import { beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../../db";
import { calls } from "../../db/schema";
import { CALENDAR_READ, GMAIL_READ } from "../agents/profiles";
import { runAgent } from "../agents/run";
import { callsFor } from "../calls";
import { addApplication } from "../tracker";
import { checkEmail, describeCheck } from "./check";

vi.mock("../agents/run", () => ({ runAgent: vi.fn() }));

const DAY = 24 * 60 * 60 * 1000;

function setup() {
  const { db } = openDb(":memory:");
  const added = addApplication(db, { company: "Northwind", title: "Engineer", stage: "submitted" });
  if (!added.ok) throw new Error("expected new");
  db.insert(calls).values({ applicationId: added.id, at: new Date(Date.now() + 5 * DAY), source: "calendar", eventId: "old" }).run();
  const reported = { applicationId: added.id, eventId: "new", start: new Date(Date.now() + 2 * DAY).toISOString(), title: "Interview with Northwind", confidence: "high" };
  return { db, id: added.id, reported };
}

describe("checking email and the calendar", () => {
  beforeEach(() => vi.mocked(runAgent).mockReset());

  it("syncs calendar calls only when the calendar tools were there", async () => {
    const without = setup();
    vi.mocked(runAgent).mockResolvedValue({ id: "r1", status: "ok", structured: { findings: [], calls: [without.reported] }, sessionTools: ["ToolSearch", ...GMAIL_READ] });
    expect(await checkEmail(without.db)).toMatchObject({ ok: true, calendar: { checked: false } });
    expect(callsFor(without.db, without.id).map((call) => call.eventId)).toEqual(["old"]);

    const withCalendar = setup();
    vi.mocked(runAgent).mockResolvedValue({ id: "r2", status: "ok", structured: { findings: [], calls: [withCalendar.reported] }, sessionTools: ["ToolSearch", ...GMAIL_READ, ...CALENDAR_READ] });
    expect(await checkEmail(withCalendar.db)).toMatchObject({ ok: true, calendar: { checked: true, added: 1, removed: 1 } });
    expect(callsFor(withCalendar.db, withCalendar.id).map((call) => call.eventId)).toEqual(["new"]);
  });

  it("leaves calls alone when the calendar was there but the agent couldn't read it", async () => {
    const { db, id } = setup();
    vi.mocked(runAgent).mockResolvedValue({ id: "r4", status: "ok", structured: { findings: [] }, sessionTools: ["ToolSearch", ...GMAIL_READ, ...CALENDAR_READ] });
    expect(await checkEmail(db)).toMatchObject({ ok: true, calendar: { checked: false } });
    expect(callsFor(db, id).map((call) => call.eventId)).toEqual(["old"]);
  });

  it("keeps email findings when a calendar item is malformed, and drops just that item", async () => {
    const { db, id, reported } = setup();
    const finding = { applicationId: id, kind: "confirmation", confidence: "high", suspicious: false, messageId: "m1", emailDate: new Date().toISOString(), from: "jobs@northwind.example", subject: "Thanks", quote: "We got it." };
    vi.mocked(runAgent).mockResolvedValue({ id: "r5", status: "ok", structured: { findings: [finding], calls: [{ ...reported, eventId: "" }, reported] }, sessionTools: ["ToolSearch", ...GMAIL_READ, ...CALENDAR_READ] });
    expect(await checkEmail(db)).toMatchObject({ ok: true, noChange: 1, calendar: { checked: true, added: 1, dropped: 1 } });
  });

  it("gives the calendar window in the prompt", async () => {
    const { db } = setup();
    vi.mocked(runAgent).mockResolvedValue({ id: "r3", status: "ok", structured: { findings: [] }, sessionTools: [] });
    await checkEmail(db);
    const prompt = vi.mocked(runAgent).mock.calls[0][1].prompt;
    const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
    expect(prompt).toContain(`Calendar window: ${day(-60)} to ${day(90)}`);
  });
});

describe("what the check says when it's done", () => {
  const base = { skipped: false as const, ok: true as const, proposed: 0, applied: 0, noChange: 0, repeats: 0, dropped: 0 };
  it("mentions calls only when the calendar changed something, and says when it couldn't look", () => {
    expect(describeCheck({ ...base, calendar: { checked: true, added: 0, moved: 0, removed: 0, dropped: 0 } })).toBe("Checked. Nothing new.");
    expect(describeCheck({ ...base, applied: 1, proposed: 2, calendar: { checked: true, added: 2, moved: 1, removed: 0, dropped: 3 } })).toBe("Checked. 1 applied, 2 waiting for your OK. Calls: 2 new, 1 moved.");
    expect(describeCheck({ ...base, calendar: { checked: false } })).toBe("Checked. Nothing new. Your calendar wasn't checked, so calls weren't updated. Sign in to Google Calendar in your Claude connectors to track them.");
  });
});
