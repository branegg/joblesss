import { and, desc, eq, inArray, notInArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../../db";
import { agentRuns, applications, companies, events, inboxFindings, jobs } from "../../db/schema";
import { CALENDAR_DAYS_AHEAD, CALENDAR_DAYS_BACK } from "../calls";
import { canMove, END_STAGES, isEndStage, type Stage } from "../stages";
import { moveStage } from "../tracker";

const DAY = 24 * 60 * 60 * 1000;
const MAX_APPLICATIONS = 30;

const KIND_STAGE = { confirmation: "submitted", screening: "screening", interview: "interview", offer: "offer", rejection: "rejected", update: null } as const satisfies Record<string, Stage | null>;

export const KIND_LABELS: Record<keyof typeof KIND_STAGE, string> = {
  confirmation: "Confirmed you applied",
  screening: "Screening",
  interview: "Interview invite",
  offer: "Offer",
  rejection: "Rejection",
  update: "Update",
};

export const findingsSchema = z.object({
  findings: z.array(
    z.object({
      applicationId: z.number().int(),
      kind: z.enum(["confirmation", "screening", "interview", "offer", "rejection", "update"]),
      confidence: z.enum(["high", "low"]),
      suspicious: z.boolean().default(false),
      messageId: z.string().min(1),
      emailDate: z.string().min(1),
      from: z.string().min(1),
      subject: z.string(),
      quote: z.string().min(1),
    }),
  ),
  calls: z.array(z.unknown()).optional(),
});

export const reportedCallSchema = z.object({
  applicationId: z.number().int(),
  eventId: z.string().min(1),
  start: z.string().min(1),
  title: z.string(),
  confidence: z.enum(["high", "low"]),
});

export const FINDINGS_JSON_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          applicationId: { type: "integer" },
          kind: { type: "string", enum: ["confirmation", "screening", "interview", "offer", "rejection", "update"] },
          confidence: { type: "string", enum: ["high", "low"] },
          suspicious: { type: "boolean" },
          messageId: { type: "string" },
          emailDate: { type: "string", description: "The email's date as an ISO 8601 timestamp" },
          from: { type: "string" },
          subject: { type: "string" },
          quote: { type: "string", maxLength: 300 },
        },
        required: ["applicationId", "kind", "confidence", "suspicious", "messageId", "emailDate", "from", "subject", "quote"],
        additionalProperties: false,
      },
    },
    calls: {
      type: "array",
      items: {
        type: "object",
        properties: {
          applicationId: { type: "integer" },
          eventId: { type: "string" },
          start: { type: "string", description: "The event's start as an ISO 8601 date and time with its offset, exactly as the calendar gives it" },
          title: { type: "string" },
          confidence: { type: "string", enum: ["high", "low"] },
        },
        required: ["applicationId", "eventId", "start", "title", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["findings"],
  additionalProperties: false,
} as const;

function dayString(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "/");
}

function lastCheck(db: Db): Date | undefined {
  return db.select({ at: agentRuns.startedAt }).from(agentRuns).where(and(eq(agentRuns.agent, "inbox"), eq(agentRuns.status, "ok"))).orderBy(desc(agentRuns.startedAt)).get()?.at;
}

export function applicationsToCheck(db: Db) {
  const previous = lastCheck(db);
  const rows = db
    .select({ id: applications.id, stage: applications.stage, appliedAt: applications.appliedAt, createdAt: applications.createdAt, title: jobs.title, company: companies.name })
    .from(applications)
    .innerJoin(jobs, eq(applications.jobId, jobs.id))
    .innerJoin(companies, eq(jobs.companyId, companies.id))
    .where(notInArray(applications.stage, [...END_STAGES]))
    .orderBy(desc(applications.updatedAt))
    .limit(MAX_APPLICATIONS)
    .all();
  return rows.map((row) => {
    const start = (row.appliedAt ?? row.createdAt).getTime() - DAY;
    const isNew = !previous || row.createdAt.getTime() >= previous.getTime();
    const searchFrom = isNew ? start : Math.max(start, previous.getTime() - DAY);
    return { id: row.id, company: row.company, role: row.title, stage: row.stage, searchAfter: dayString(new Date(searchFrom)), earliestEmail: start };
  });
}

export function buildInboxPrompt(rows: ReturnType<typeof applicationsToCheck>): string {
  const list = rows.map(({ id, company, role, stage, searchAfter }) => ({ id, company, role, stage, searchAfter }));
  const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
  return `These are my open job applications. Look for emails about them.\n\n${JSON.stringify(list, null, 1)}\n\nCalendar window: ${day(-CALENDAR_DAYS_BACK)} to ${day(CALENDAR_DAYS_AHEAD)}`;
}

export type RecordSummary = { proposed: number; applied: number; noChange: number; repeats: number; dropped: number };

export function recordFindings(db: Db, rows: { id: number; earliestEmail: number }[], output: unknown, autoApply: boolean): RecordSummary {
  const parsed = findingsSchema.parse(output);
  const summary: RecordSummary = { proposed: 0, applied: 0, noChange: 0, repeats: 0, dropped: 0 };
  const allowed = new Map(rows.map((row) => [row.id, row.earliestEmail]));
  const ordered = [...parsed.findings].sort((a, b) => new Date(a.emailDate).getTime() - new Date(b.emailDate).getTime());
  for (const finding of ordered) {
    const emailAt = new Date(finding.emailDate);
    const earliest = allowed.get(finding.applicationId);
    if (earliest === undefined || Number.isNaN(emailAt.getTime()) || emailAt.getTime() < earliest) {
      summary.dropped++;
      continue;
    }
    const seen = db.select({ id: inboxFindings.id }).from(inboxFindings).where(and(eq(inboxFindings.messageId, finding.messageId), eq(inboxFindings.applicationId, finding.applicationId))).get();
    if (seen) {
      summary.repeats++;
      continue;
    }
    const proposedStage = KIND_STAGE[finding.kind];
    const current = db.select({ stage: applications.stage }).from(applications).where(eq(applications.id, finding.applicationId)).get()!;
    const pointless = proposedStage !== null && !canMove(current.stage, proposedStage);
    const row = db
      .insert(inboxFindings)
      .values({
        applicationId: finding.applicationId,
        messageId: finding.messageId,
        kind: finding.kind,
        proposedStage,
        confidence: finding.confidence,
        suspicious: finding.suspicious,
        emailAt,
        fromAddress: finding.from.slice(0, 200),
        subject: finding.subject.slice(0, 300),
        quote: finding.quote.slice(0, 300),
        status: pointless ? "no_change" : "pending",
      })
      .returning()
      .get();
    if (pointless) {
      summary.noChange++;
    } else if (autoApply && finding.confidence === "high" && !finding.suspicious) {
      acceptFinding(db, row.id);
      summary.applied++;
    } else {
      summary.proposed++;
    }
  }
  return summary;
}

function evidence(finding: { fromAddress: string; subject: string; quote: string }): string {
  return `Email from ${finding.fromAddress}, "${finding.subject}": "${finding.quote}"`;
}

export function acceptFinding(db: Db, id: number): void {
  const finding = db.select().from(inboxFindings).where(eq(inboxFindings.id, id)).get();
  if (!finding || finding.status !== "pending") return;
  const current = db.select({ stage: applications.stage }).from(applications).where(eq(applications.id, finding.applicationId)).get();
  if (!current) return;
  if (finding.proposedStage === null) {
    db.insert(events).values({ applicationId: finding.applicationId, at: finding.emailAt, kind: "email", summary: finding.subject || "Email update", source: "inbox", evidence: evidence(finding) }).run();
    db.update(inboxFindings).set({ status: "applied" }).where(eq(inboxFindings.id, id)).run();
    return;
  }
  if (!canMove(current.stage, finding.proposedStage)) {
    db.update(inboxFindings).set({ status: "no_change" }).where(eq(inboxFindings.id, id)).run();
    return;
  }
  moveStage(db, finding.applicationId, finding.proposedStage, { source: "inbox", evidence: evidence(finding), at: finding.emailAt });
  db.update(inboxFindings).set({ status: "applied" }).where(eq(inboxFindings.id, id)).run();
}

const REPLY_KINDS = ["screening", "interview", "offer"] as const;

export function repliesToRead(db: Db) {
  return findingsQuery(db)
    .where(and(eq(inboxFindings.status, "applied"), eq(inboxFindings.suspicious, false), inArray(inboxFindings.kind, [...REPLY_KINDS])))
    .orderBy(desc(inboxFindings.emailAt))
    .all()
    .filter((reply) => !isEndStage(reply.stage));
}

export function repliesFound(db: Db, limit = 5) {
  return findingsQuery(db)
    .where(and(inArray(inboxFindings.status, ["applied", "seen"]), eq(inboxFindings.suspicious, false), inArray(inboxFindings.kind, [...REPLY_KINDS])))
    .orderBy(desc(inboxFindings.createdAt))
    .limit(limit)
    .all();
}

export function markReplySeen(db: Db, id: number): void {
  db.update(inboxFindings).set({ status: "seen" }).where(and(eq(inboxFindings.id, id), eq(inboxFindings.status, "applied"))).run();
}

export function gmailSearchUrl(from: string, subject: string): string {
  const address = from.match(/<([^>]+)>/)?.[1] ?? from;
  const query = `from:${address} subject:"${subject.replaceAll('"', "")}"`;
  return `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(query)}`;
}

export function ignoreFinding(db: Db, id: number): void {
  db.update(inboxFindings).set({ status: "ignored" }).where(and(eq(inboxFindings.id, id), eq(inboxFindings.status, "pending"))).run();
}

const findingRow = {
  id: inboxFindings.id,
  applicationId: inboxFindings.applicationId,
  stage: applications.stage,
  createdAt: inboxFindings.createdAt,
  kind: inboxFindings.kind,
  proposedStage: inboxFindings.proposedStage,
  confidence: inboxFindings.confidence,
  suspicious: inboxFindings.suspicious,
  emailAt: inboxFindings.emailAt,
  fromAddress: inboxFindings.fromAddress,
  subject: inboxFindings.subject,
  quote: inboxFindings.quote,
  status: inboxFindings.status,
  title: jobs.title,
  company: companies.name,
};

function findingsQuery(db: Db) {
  return db.select(findingRow).from(inboxFindings).innerJoin(applications, eq(inboxFindings.applicationId, applications.id)).innerJoin(jobs, eq(applications.jobId, jobs.id)).innerJoin(companies, eq(jobs.companyId, companies.id));
}

export function pendingFindings(db: Db) {
  return findingsQuery(db).where(eq(inboxFindings.status, "pending")).orderBy(desc(inboxFindings.emailAt)).all();
}

export function recentFindings(db: Db, limit = 30) {
  return findingsQuery(db).where(notInArray(inboxFindings.status, ["pending"])).orderBy(desc(inboxFindings.emailAt)).limit(limit).all();
}

export function lastCheckedAt(db: Db): Date | undefined {
  return lastCheck(db);
}
