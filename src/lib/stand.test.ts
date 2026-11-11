import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { openDb, type Db } from "../db";
import { calls, events } from "../db/schema";
import { addCall, syncCalendarCalls } from "./calls";
import { standRows } from "./stand";
import type { Stage } from "./stages";
import { addApplication, moveStage } from "./tracker";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 10, 11, 12);
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

function sent(db: Db, company: string, stage: Stage = "submitted", appliedDaysAgo = 30) {
  const added = addApplication(db, { company, title: "Engineer", stage, appliedAt: ago(appliedDaysAgo) });
  if (!added.ok) throw new Error("expected new");
  return added.id;
}

function heard(db: Db, applicationId: number, daysAgo: number) {
  db.insert(events).values({ applicationId, at: ago(daysAgo), kind: "email", summary: "Update", source: "inbox" }).run();
}

function closeAt(db: Db, applicationId: number, daysAgo: number) {
  moveStage(db, applicationId, "rejected");
  db.update(events).set({ at: ago(daysAgo) }).where(and(eq(events.applicationId, applicationId), eq(events.toStage, "rejected"))).run();
}

describe("where things stand", () => {
  it("lists only applications that were sent", () => {
    const { db } = openDb(":memory:");
    addApplication(db, { company: "Hooli", title: "Engineer", stage: "saved" });
    addApplication(db, { company: "Initech", title: "Engineer", stage: "packet_ready" });
    const dropped = addApplication(db, { company: "Umbrella", title: "Engineer", stage: "saved" });
    if (!dropped.ok) throw new Error();
    moveStage(db, dropped.id, "rejected");
    const id = sent(db, "Northwind");
    expect(standRows(db, NOW).map((row) => row.id)).toEqual([id]);
  });

  it("puts booked calls first, soonest first, then the longest silence, then closed", () => {
    const { db } = openDb(":memory:");
    const northwind = sent(db, "Northwind", "interview");
    const globex = sent(db, "Globex", "screening");
    const initech = sent(db, "Initech");
    const umbrella = sent(db, "Umbrella");
    const vandelay = sent(db, "Vandelay");
    moveStage(db, vandelay, "rejected");
    db.insert(calls).values({ applicationId: northwind, at: new Date(NOW.getTime() + 3 * DAY), source: "manual" }).run();
    db.insert(calls).values({ applicationId: globex, at: new Date(NOW.getTime() + DAY), source: "manual" }).run();
    heard(db, initech, 2);
    heard(db, umbrella, 9);
    expect(standRows(db, NOW).map((row) => row.id)).toEqual([globex, northwind, umbrella, initech, vandelay]);
  });

  it("says Applied, not Submitted", () => {
    const { db } = openDb(":memory:");
    sent(db, "Northwind");
    sent(db, "Globex", "interview");
    expect(standRows(db, NOW).map((row) => row.stageLabel).sort()).toEqual(["Applied", "Interview"]);
  });

  it("counts emails and your own stage moves as hearing back, but not calendar calls", () => {
    const { db } = openDb(":memory:");
    const id = sent(db, "Northwind");
    db.insert(events).values({ applicationId: id, at: ago(1), kind: "note", summary: "Thought about it", source: "manual" }).run();
    db.insert(calls).values({ applicationId: id, at: ago(2), source: "calendar", eventId: "e1" }).run();
    expect(standRows(db, NOW)[0].lastHeard).toBeUndefined();
    heard(db, id, 4);
    expect(standRows(db, NOW)[0].lastHeard).toEqual(ago(4));
    db.insert(events).values({ applicationId: id, at: ago(1), kind: "stage_change", fromStage: "submitted", toStage: "screening", summary: "Moved", source: "manual" }).run();
    expect(standRows(db, NOW)[0].lastHeard).toEqual(ago(1));
  });

  it("doesn't count adding an application as hearing back", () => {
    const { db } = openDb(":memory:");
    sent(db, "Northwind", "interview");
    expect(standRows(db, NOW)[0].lastHeard).toBeUndefined();
  });

  it("waits to hear only after a call you had, while still open", () => {
    const { db } = openDb(":memory:");
    const id = sent(db, "Northwind", "interview");
    addCall(db, id, ago(3));
    expect(standRows(db, NOW)[0]).toMatchObject({ waitingToHear: true, closed: false, call: { booked: false } });
    heard(db, id, 1);
    expect(standRows(db, NOW)[0].waitingToHear).toBe(false);
    const other = sent(db, "Globex", "interview");
    addCall(db, other, ago(3));
    moveStage(db, other, "rejected");
    expect(standRows(db, NOW).find((row) => row.id === other)).toMatchObject({ waitingToHear: false, closed: true, stageLabel: "Rejected" });
  });

  it("orders closed ones by when they closed, newest first", () => {
    const { db } = openDb(":memory:");
    const older = sent(db, "Hooli");
    const newer = sent(db, "Vandelay");
    closeAt(db, older, 1);
    closeAt(db, newer, 5);
    expect(standRows(db, NOW).map((row) => row.id)).toEqual([older, newer]);
  });

  it("doesn't count the calendar's own timeline notes as hearing back", () => {
    const { db } = openDb(":memory:");
    const id = sent(db, "Northwind", "interview");
    syncCalendarCalls(db, [id], [{ applicationId: id, eventId: "e1", start: ago(10).toISOString(), title: "Interview", confidence: "high" }], NOW);
    expect(standRows(db, NOW)[0]).toMatchObject({ lastHeard: undefined, waitingToHear: true });
  });
});
