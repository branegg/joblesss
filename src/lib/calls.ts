import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db";
import { applications, calls, events } from "../db/schema";

export type Call = typeof calls.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Source = "manual" | "inbox";

export function formatCallTime(date: Date): string {
  const day = date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }).replace(",", "");
  const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${day}, ${time}`;
}

function note(tx: Tx, applicationId: number, summary: string, source: Source): void {
  tx.update(applications).set({ updatedAt: new Date() }).where(eq(applications.id, applicationId)).run();
  tx.insert(events).values({ applicationId, kind: "note", summary, source }).run();
}

function requireCall(tx: Tx, callId: number): Call {
  const call = tx.select().from(calls).where(eq(calls.id, callId)).get();
  if (!call) throw new Error(`No call ${callId}`);
  return call;
}

export function addCall(db: Db, applicationId: number, at: Date): number {
  return db.transaction((tx) => {
    const id = tx.insert(calls).values({ applicationId, at, source: "manual" }).returning({ id: calls.id }).get().id;
    note(tx, applicationId, `Call booked for ${formatCallTime(at)}`, "manual");
    return id;
  });
}

export function moveCall(db: Db, callId: number, at: Date): void {
  db.transaction((tx) => {
    const call = requireCall(tx, callId);
    tx.update(calls).set({ at, source: "manual" }).where(eq(calls.id, callId)).run();
    note(tx, call.applicationId, `Call moved to ${formatCallTime(at)}`, "manual");
  });
}

export function removeCall(db: Db, callId: number): void {
  db.transaction((tx) => {
    const call = requireCall(tx, callId);
    if (call.eventId) tx.update(calls).set({ dismissed: true }).where(eq(calls.id, callId)).run();
    else tx.delete(calls).where(eq(calls.id, callId)).run();
    note(tx, call.applicationId, "Call removed", "manual");
  });
}

export function callsFor(db: Db, applicationId: number): Call[] {
  return db.select().from(calls).where(and(eq(calls.applicationId, applicationId), eq(calls.dismissed, false))).orderBy(asc(calls.at)).all();
}

export function shownCall(list: Call[], now: Date): { call: Call; booked: boolean } | undefined {
  const sorted = [...list].sort((a, b) => a.at.getTime() - b.at.getTime());
  const next = sorted.find((call) => call.at.getTime() > now.getTime());
  if (next) return { call: next, booked: true };
  const last = sorted.at(-1);
  return last ? { call: last, booked: false } : undefined;
}

export const CALENDAR_DAYS_BACK = 60;
export const CALENDAR_DAYS_AHEAD = 90;
const DAY = 24 * 60 * 60 * 1000;
const EVENT_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

export type ReportedCall = { applicationId: number; eventId: string; start: string; title: string; confidence: "high" | "low" };
export type SyncSummary = { added: number; moved: number; removed: number; dropped: number };

const minute = (date: Date) => Math.floor(date.getTime() / 60_000);

export function syncCalendarCalls(db: Db, applicationIds: number[], reported: ReportedCall[], now: Date = new Date()): SyncSummary {
  const summary: SyncSummary = { added: 0, moved: 0, removed: 0, dropped: 0 };
  const asked = new Set(applicationIds);
  const earliest = now.getTime() - CALENDAR_DAYS_BACK * DAY;
  const latest = now.getTime() + CALENDAR_DAYS_AHEAD * DAY;
  const valid = new Map<string, { applicationId: number; at: Date; title: string }>();
  for (const call of reported) {
    const at = new Date(call.start);
    const usable = call.confidence === "high" && asked.has(call.applicationId) && EVENT_TIME.test(call.start.trim()) && !Number.isNaN(at.getTime()) && at.getTime() >= earliest && at.getTime() <= latest;
    if (!usable || valid.has(call.eventId)) {
      summary.dropped++;
      continue;
    }
    valid.set(call.eventId, { applicationId: call.applicationId, at: new Date(Math.floor(at.getTime() / 1000) * 1000), title: call.title.slice(0, 120) });
  }
  if (applicationIds.length === 0) return summary;
  db.transaction((tx) => {
    const stored = tx.select().from(calls).where(inArray(calls.applicationId, applicationIds)).all();
    for (const [eventId, event] of valid) {
      const known = tx.select().from(calls).where(eq(calls.eventId, eventId)).get();
      if (known) {
        if (known.applicationId !== event.applicationId) {
          summary.dropped++;
          continue;
        }
        if (known.dismissed || known.source === "manual") continue;
        const timeChanged = known.at.getTime() !== event.at.getTime();
        tx.update(calls).set({ at: event.at, title: event.title }).where(eq(calls.id, known.id)).run();
        if (timeChanged) {
          note(tx, known.applicationId, `Call moved to ${formatCallTime(event.at)}`, "inbox");
          summary.moved++;
        }
        continue;
      }
      const mine = stored.find((call) => call.source === "manual" && call.eventId === null && call.applicationId === event.applicationId && minute(call.at) === minute(event.at));
      if (mine) {
        tx.update(calls).set({ eventId, title: event.title }).where(eq(calls.id, mine.id)).run();
        mine.eventId = eventId;
        continue;
      }
      tx.insert(calls).values({ applicationId: event.applicationId, at: event.at, source: "calendar", eventId, title: event.title }).run();
      note(tx, event.applicationId, `Call booked for ${formatCallTime(event.at)}`, "inbox");
      summary.added++;
    }
    for (const call of stored) {
      if (call.source !== "calendar" || call.dismissed || call.eventId === null || valid.has(call.eventId) || call.at.getTime() <= now.getTime()) continue;
      tx.delete(calls).where(and(eq(calls.id, call.id), eq(calls.source, "calendar"))).run();
      note(tx, call.applicationId, "Call removed", "inbox");
      summary.removed++;
    }
  });
  return summary;
}
