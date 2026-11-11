import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { calls, events } from "../db/schema";
import { shownCall, type Call } from "./calls";
import { isEndStage, STAGE_LABELS, type Stage } from "./stages";
import { listApplications } from "./tracker";

export type StandRow = {
  id: number;
  company: string;
  role: string;
  stageLabel: string;
  closed: boolean;
  call: { at: Date; booked: boolean; callId: number } | undefined;
  waitingToHear: boolean;
  lastHeard: Date | undefined;
  sentAt: Date;
};

const HEARD_STAGES: Stage[] = ["screening", "interview", "offer", "rejected"];

type Event = typeof events.$inferSelect;

function countsAsHeard(event: Event): boolean {
  if (event.source === "inbox") return event.kind !== "note";
  return event.kind === "stage_change" && event.source === "manual" && event.fromStage !== null && event.toStage !== null && HEARD_STAGES.includes(event.toStage);
}

function latest(dates: Date[]): Date | undefined {
  return dates.reduce<Date | undefined>((best, date) => (!best || date.getTime() > best.getTime() ? date : best), undefined);
}

function groupBy<T>(items: T[], key: (item: T) => number): Map<number, T[]> {
  const groups = new Map<number, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}

export function standRows(db: Db, now: Date = new Date()): StandRow[] {
  const eventsByApplication = groupBy(db.select().from(events).all(), (event) => event.applicationId);
  const callsByApplication = groupBy<Call>(db.select().from(calls).where(eq(calls.dismissed, false)).all(), (call) => call.applicationId);
  const rows = listApplications(db)
    .filter((application) => application.appliedAt !== null)
    .map((application) => {
      const own = eventsByApplication.get(application.id) ?? [];
      const lastHeard = latest(own.filter(countsAsHeard).map((event) => event.at));
      const shown = shownCall(callsByApplication.get(application.id) ?? [], now);
      const closed = isEndStage(application.stage);
      const closedAt = latest(own.filter((event) => event.kind === "stage_change" && event.toStage !== null && isEndStage(event.toStage)).map((event) => event.at)) ?? application.updatedAt;
      const row: StandRow = {
        id: application.id,
        company: application.company,
        role: application.title,
        stageLabel: application.stage === "submitted" ? "Applied" : STAGE_LABELS[application.stage],
        closed,
        call: shown && { at: shown.call.at, booked: shown.booked, callId: shown.call.id },
        waitingToHear: !closed && shown !== undefined && !shown.booked && (!lastHeard || lastHeard.getTime() < shown.call.at.getTime()),
        lastHeard,
        sentAt: application.appliedAt!,
      };
      return { row, closedAt };
    });
  const group = ({ row }: (typeof rows)[number]) => (row.closed ? 2 : row.call?.booked ? 0 : 1);
  return rows
    .sort((a, b) => {
      const byGroup = group(a) - group(b);
      if (byGroup !== 0) return byGroup;
      if (group(a) === 0) return a.row.call!.at.getTime() - b.row.call!.at.getTime();
      if (group(a) === 1) return (a.row.lastHeard ?? a.row.sentAt).getTime() - (b.row.lastHeard ?? b.row.sentAt).getTime();
      return b.closedAt.getTime() - a.closedAt.getTime();
    })
    .map(({ row }) => row);
}
