import type { Db } from "../../db";
import { CALENDAR_READ } from "../agents/profiles";
import { runAgent } from "../agents/run";
import { syncCalendarCalls, type SyncSummary } from "../calls";
import { readSettings } from "../settings";
import { applicationsToCheck, buildInboxPrompt, FINDINGS_JSON_SCHEMA, findingsSchema, recordFindings, reportedCallSchema, type RecordSummary } from "./inbox";

export type CalendarSummary = { checked: false } | ({ checked: true } & SyncSummary);
export type CheckSummary = { skipped: true; reason: string } | { skipped: false; ok: false; reason: string } | ({ skipped: false; ok: true; calendar: CalendarSummary } & RecordSummary);

export async function checkEmail(db: Db): Promise<CheckSummary> {
  const rows = applicationsToCheck(db);
  if (rows.length === 0) return { skipped: true, reason: "no open applications" };
  const run = await runAgent("inbox", { prompt: buildInboxPrompt(rows), jsonSchema: FINDINGS_JSON_SCHEMA });
  if (run.status !== "ok" || !run.structured) return { skipped: false, ok: false, reason: run.reason ?? "the agent returned nothing" };
  const recorded = recordFindings(db, rows, run.structured, readSettings().inboxAutoApply);
  const calendar = syncCalendar(db, rows.map((row) => row.id), run.structured, run.sessionTools);
  return { skipped: false, ok: true, calendar, ...recorded };
}

function syncCalendar(db: Db, applicationIds: number[], structured: unknown, sessionTools: string[] = []): CalendarSummary {
  const reported = findingsSchema.parse(structured).calls;
  if (!CALENDAR_READ.every((tool) => sessionTools.includes(tool)) || reported === undefined) return { checked: false };
  const parsed = reported.map((item) => reportedCallSchema.safeParse(item));
  const valid = parsed.flatMap((result) => (result.success ? [result.data] : []));
  const summary = syncCalendarCalls(db, applicationIds, valid);
  return { checked: true, ...summary, dropped: summary.dropped + parsed.length - valid.length };
}

export function describeCheck(summary: Extract<CheckSummary, { ok: true }>): string {
  const found = summary.proposed + summary.applied;
  const email = found === 0 ? "Checked. Nothing new." : `Checked. ${summary.applied} applied, ${summary.proposed} waiting for your OK.`;
  if (!summary.calendar.checked) return `${email} Your calendar wasn't checked, so calls weren't updated. Sign in to Google Calendar in your Claude connectors to track them.`;
  const { added, moved, removed } = summary.calendar;
  const parts = [added && `${added} new`, moved && `${moved} moved`, removed && `${removed} removed`].filter(Boolean);
  return parts.length ? `${email} Calls: ${parts.join(", ")}.` : email;
}
