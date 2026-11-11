import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { STAGES } from "../lib/stages";

const now = sql`(unixepoch())`;

export const companies = sqliteTable("companies", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  ats: text("ats", { enum: ["greenhouse", "lever", "ashby", "workable", "recruitee"] }),
  boardToken: text("board_token"),
  website: text("website"),
  notes: text("notes"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(now),
});

export const jobs = sqliteTable(
  "jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    source: text("source", { enum: ["greenhouse", "lever", "ashby", "workable", "recruitee", "reed", "adzuna", "url", "manual"] }).notNull(),
    externalId: text("external_id").notNull(),
    companyId: integer("company_id").notNull().references(() => companies.id),
    title: text("title").notNull(),
    location: text("location"),
    url: text("url"),
    description: text("description"),
    previewOnly: integer("preview_only", { mode: "boolean" }).notNull().default(false),
    compensation: text("compensation"),
    postedAt: integer("posted_at", { mode: "timestamp" }),
    firstSeenAt: integer("first_seen_at", { mode: "timestamp" }).notNull().default(now),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp" }).notNull().default(now),
    score: real("score"),
    scoreReason: text("score_reason"),
    scoredAt: integer("scored_at", { mode: "timestamp" }),
    status: text("status", { enum: ["new", "shortlisted", "dismissed", "applied", "closed"] }).notNull().default("new"),
    pasted: integer("pasted", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [uniqueIndex("jobs_source_external").on(t.source, t.externalId), index("jobs_status_score").on(t.status, t.score)],
);

export const applications = sqliteTable(
  "applications",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: integer("job_id").notNull().references(() => jobs.id),
    stage: text("stage", { enum: STAGES }).notNull().default("saved"),
    packetPath: text("packet_path"),
    appliedAt: integer("applied_at", { mode: "timestamp" }),
    nextAction: text("next_action"),
    nextActionAt: integer("next_action_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(now),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(now),
  },
  (t) => [uniqueIndex("applications_job").on(t.jobId), index("applications_stage").on(t.stage)],
);

export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    applicationId: integer("application_id").notNull().references(() => applications.id),
    at: integer("at", { mode: "timestamp" }).notNull().default(now),
    kind: text("kind", { enum: ["stage_change", "note", "email", "packet", "reminder"] }).notNull(),
    fromStage: text("from_stage", { enum: STAGES }),
    toStage: text("to_stage", { enum: STAGES }),
    summary: text("summary").notNull(),
    source: text("source", { enum: ["manual", "inbox", "apply", "tailor"] }).notNull(),
    evidence: text("evidence"),
  },
  (t) => [index("events_application").on(t.applicationId, t.at)],
);

export const inboxFindings = sqliteTable(
  "inbox_findings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    applicationId: integer("application_id").notNull().references(() => applications.id),
    messageId: text("message_id").notNull(),
    kind: text("kind", { enum: ["confirmation", "screening", "interview", "offer", "rejection", "update"] }).notNull(),
    proposedStage: text("proposed_stage", { enum: STAGES }),
    confidence: text("confidence", { enum: ["high", "low"] }).notNull(),
    suspicious: integer("suspicious", { mode: "boolean" }).notNull().default(false),
    emailAt: integer("email_at", { mode: "timestamp" }).notNull(),
    fromAddress: text("from_address").notNull(),
    subject: text("subject").notNull(),
    quote: text("quote").notNull(),
    status: text("status", { enum: ["pending", "applied", "ignored", "no_change", "seen"] }).notNull().default("pending"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(now),
  },
  (t) => [uniqueIndex("inbox_message_application").on(t.messageId, t.applicationId), index("inbox_status").on(t.status)],
);

export const calls = sqliteTable(
  "calls",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    applicationId: integer("application_id").notNull().references(() => applications.id),
    at: integer("at", { mode: "timestamp" }).notNull(),
    source: text("source", { enum: ["manual", "calendar"] }).notNull(),
    eventId: text("event_id"),
    title: text("title"),
    dismissed: integer("dismissed", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(now),
  },
  (t) => [index("calls_application").on(t.applicationId, t.at), uniqueIndex("calls_event").on(t.eventId)],
);

export const agentRuns = sqliteTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    agent: text("agent").notNull(),
    startedAt: integer("started_at", { mode: "timestamp" }).notNull().default(now),
    endedAt: integer("ended_at", { mode: "timestamp" }),
    status: text("status", { enum: ["running", "ok", "failed", "blocked"] }).notNull().default("running"),
    result: text("result"),
    logPath: text("log_path"),
    costUsd: real("cost_usd"),
  },
  (t) => [index("agent_runs_agent").on(t.agent, t.startedAt)],
);
