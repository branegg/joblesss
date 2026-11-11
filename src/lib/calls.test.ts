import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { openDb } from "../db";
import { events } from "../db/schema";
import { addCall, callsFor, formatCallTime, moveCall, removeCall, shownCall, syncCalendarCalls, type ReportedCall } from "./calls";
import { addApplication, deleteApplication } from "./tracker";

const DAY = 24 * 60 * 60 * 1000;

function setup() {
  const { db } = openDb(":memory:");
  const added = addApplication(db, { company: "Northwind", title: "Engineer", stage: "submitted", appliedAt: new Date(Date.now() - 20 * DAY) });
  if (!added.ok) throw new Error("expected new");
  return { db, id: added.id };
}

function notes(db: ReturnType<typeof setup>["db"], id: number) {
  return db.select().from(events).where(eq(events.applicationId, id)).all().filter((event) => event.kind === "note");
}

describe("calls you add yourself", () => {
  it("adds, moves and removes a call, noting each on the timeline", () => {
    const { db, id } = setup();
    const callId = addCall(db, id, new Date(Date.now() + 3 * DAY));
    expect(callsFor(db, id)).toMatchObject([{ id: callId, source: "manual" }]);
    moveCall(db, callId, new Date(Date.now() + 4 * DAY));
    expect(callsFor(db, id)[0].at.getTime()).toBe(Math.floor((Date.now() + 4 * DAY) / 1000) * 1000);
    removeCall(db, callId);
    expect(callsFor(db, id)).toEqual([]);
    const summaries = notes(db, id).map((note) => note.summary);
    expect(summaries[0]).toMatch(/^Call booked for /);
    expect(summaries[1]).toMatch(/^Call moved to /);
    expect(summaries[2]).toBe("Call removed");
    expect(notes(db, id).every((note) => note.source === "manual")).toBe(true);
  });

  it("shows the next booked call, otherwise the latest one you had", () => {
    const { db, id } = setup();
    const now = new Date();
    for (const days of [-10, -2, 3, 9]) addCall(db, id, new Date(now.getTime() + days * DAY));
    const all = callsFor(db, id);
    expect(shownCall(all, now)).toEqual({ call: all[2], booked: true });
    expect(shownCall(all.slice(0, 2), now)).toEqual({ call: all[1], booked: false });
    expect(shownCall([], now)).toBeUndefined();
  });

  it("deleting an application deletes its calls", () => {
    const { db, id } = setup();
    addCall(db, id, new Date(Date.now() + DAY));
    expect(() => deleteApplication(db, id)).not.toThrow();
    expect(callsFor(db, id)).toEqual([]);
  });

  it("writes the call time the way the page shows it", () => {
    expect(formatCallTime(new Date(2026, 10, 14, 15, 0))).toBe("Sat 14 Nov, 15:00");
  });
});

describe("calls from the calendar", () => {
  const NOW = new Date("2026-11-11T12:00:00Z");
  const iso = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString();
  const reported = (applicationId: number, extra: Partial<ReportedCall> = {}): ReportedCall => ({ applicationId, eventId: "e1", start: iso(3), title: "Interview with Northwind", confidence: "high", ...extra });

  it("adds a clearly matching event and keeps its exact time", () => {
    const { db, id } = setup();
    const result = syncCalendarCalls(db, [id], [reported(id, { start: "2026-11-14T09:00:00-05:00" })], NOW);
    expect(result).toMatchObject({ added: 1, moved: 0, removed: 0, dropped: 0 });
    const [call] = callsFor(db, id);
    expect(call).toMatchObject({ source: "calendar", eventId: "e1", title: "Interview with Northwind" });
    expect(call.at.toISOString()).toBe("2026-11-14T14:00:00.000Z");
    expect(notes(db, id).at(-1)).toMatchObject({ source: "inbox" });
    expect(notes(db, id).at(-1)?.summary).toMatch(/^Call booked for /);
  });

  it("drops unclear, malformed or out-of-range events, and events for applications it wasn't asked about", () => {
    const { db, id } = setup();
    const result = syncCalendarCalls(db, [id], [
      reported(id, { eventId: "a", confidence: "low" }),
      reported(id, { eventId: "b", start: "next Tuesday" }),
      reported(id, { eventId: "c", start: iso(-61) }),
      reported(id, { eventId: "d", start: iso(91) }),
      reported(id + 1, { eventId: "e" }),
    ], NOW);
    expect(result.dropped).toBe(5);
    expect(callsFor(db, id)).toEqual([]);
  });

  it("moves a call when its event moves", () => {
    const { db, id } = setup();
    syncCalendarCalls(db, [id], [reported(id)], NOW);
    const result = syncCalendarCalls(db, [id], [reported(id, { start: iso(4) })], NOW);
    expect(result.moved).toBe(1);
    expect(callsFor(db, id).map((call) => call.at.toISOString())).toEqual([new Date(Math.floor((NOW.getTime() + 4 * DAY) / 1000) * 1000).toISOString()]);
    expect(notes(db, id).at(-1)?.summary).toMatch(/^Call moved to /);
  });

  it("removes a future call whose event is gone, but keeps past ones and yours", () => {
    const { db, id } = setup();
    syncCalendarCalls(db, [id], [reported(id, { eventId: "e1", start: iso(3) }), reported(id, { eventId: "e2", start: iso(-3) })], NOW);
    addCall(db, id, new Date(NOW.getTime() + 5 * DAY));
    const result = syncCalendarCalls(db, [id], [], NOW);
    expect(result.removed).toBe(1);
    expect(callsFor(db, id).map((call) => call.eventId ?? call.source)).toEqual(["e2", "manual"]);
    expect(notes(db, id).at(-1)?.summary).toBe("Call removed");
  });

  it("joins an event to a call you added at the same minute", () => {
    const { db, id } = setup();
    const at = new Date(NOW.getTime() + 2 * DAY);
    addCall(db, id, at);
    syncCalendarCalls(db, [id], [reported(id, { start: new Date(at.getTime() + 20_000).toISOString() })], NOW);
    expect(callsFor(db, id)).toMatchObject([{ source: "manual", eventId: "e1" }]);
    syncCalendarCalls(db, [id], [], NOW);
    expect(callsFor(db, id)).toHaveLength(1);
  });

  it("only touches applications it was asked about", () => {
    const { db, id } = setup();
    syncCalendarCalls(db, [id], [reported(id)], NOW);
    syncCalendarCalls(db, [], [], NOW);
    expect(callsFor(db, id)).toHaveLength(1);
  });

  it("ignores an event already tied to another application", () => {
    const { db, id } = setup();
    const other = addApplication(db, { company: "Globex", title: "Engineer", stage: "submitted" });
    if (!other.ok) throw new Error();
    syncCalendarCalls(db, [id], [reported(id)], NOW);
    const result = syncCalendarCalls(db, [other.id], [reported(other.id)], NOW);
    expect(result).toMatchObject({ added: 0, dropped: 1 });
    expect(callsFor(db, id)).toHaveLength(1);
    expect(callsFor(db, other.id)).toEqual([]);
  });

  it("keeps a calendar call you removed removed", () => {
    const { db, id } = setup();
    syncCalendarCalls(db, [id], [reported(id)], NOW);
    removeCall(db, callsFor(db, id)[0].id);
    expect(syncCalendarCalls(db, [id], [reported(id)], NOW)).toMatchObject({ added: 0, removed: 0 });
    expect(callsFor(db, id)).toEqual([]);
  });

  it("keeps a calendar call where you moved it", () => {
    const { db, id } = setup();
    syncCalendarCalls(db, [id], [reported(id)], NOW);
    const yours = new Date(NOW.getTime() + 6 * DAY);
    moveCall(db, callsFor(db, id)[0].id, yours);
    syncCalendarCalls(db, [id], [reported(id)], NOW);
    syncCalendarCalls(db, [id], [], NOW);
    expect(callsFor(db, id).map((call) => call.at.getTime())).toEqual([Math.floor(yours.getTime() / 1000) * 1000]);
  });

  it("cuts long titles", () => {
    const { db, id } = setup();
    syncCalendarCalls(db, [id], [reported(id, { title: "x".repeat(300) })], NOW);
    expect(callsFor(db, id)[0].title).toHaveLength(120);
  });
});
