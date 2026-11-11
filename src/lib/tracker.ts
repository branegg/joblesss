import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNotNull, lte, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "../db";
import { applications, calls, companies, events, inboxFindings, jobs } from "../db/schema";
import { canMove, END_STAGES, hasBeenSent, isEndStage, STAGE_LABELS, type Stage } from "./stages";
import { slugify } from "./vault/entries";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Application = typeof applications.$inferSelect;
type EventSource = (typeof events.$inferInsert)["source"];

const DAY = 24 * 60 * 60 * 1000;
export const FOLLOW_UP = "Follow up if no reply";
export const FOLLOW_UP_DAYS = 7;

export type NewApplication = {
  company: string;
  title: string;
  url?: string;
  location?: string;
  stage?: Stage;
  appliedAt?: Date;
  note?: string;
  description?: string;
};

export type AddResult = { ok: true; id: number } | { ok: false; existingId: number };

export function normalizeUrl(value: string): string {
  const url = new URL(value.trim());
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_")) url.searchParams.delete(key);
  }
  return url.toString().replace(/\/$/, "");
}

function companyFor(tx: Tx, name: string) {
  const slug = slugify(name);
  const unnamed = slug === "entry";
  const match = unnamed ? eq(companies.name, name) : eq(companies.slug, slug);
  const found = tx.select().from(companies).where(match).get();
  if (found) return found;
  return tx.insert(companies).values({ name, slug: unnamed ? `company-${randomUUID().slice(0, 8)}` : slug }).returning().get();
}

function stagePatch(app: Pick<Application, "appliedAt" | "nextAction" | "nextActionAt">, to: Stage, now: Date) {
  const keepAction = !isEndStage(to) && app.nextAction !== FOLLOW_UP;
  const appliedAt = hasBeenSent(to) ? (app.appliedAt ?? now) : isEndStage(to) ? app.appliedAt : null;
  const patch = {
    stage: to,
    appliedAt,
    nextAction: keepAction ? app.nextAction : null,
    nextActionAt: keepAction ? app.nextActionAt : null,
    updatedAt: now,
  };
  if (to === "submitted" && !patch.nextAction) {
    patch.nextAction = FOLLOW_UP;
    patch.nextActionAt = new Date((appliedAt ?? now).getTime() + FOLLOW_UP_DAYS * DAY);
  }
  return patch;
}

function syncJobStatus(tx: Tx, jobId: number, appliedAt: Date | null) {
  tx.update(jobs).set({ status: appliedAt ? "applied" : "shortlisted" }).where(eq(jobs.id, jobId)).run();
}

export function addApplication(db: Db, input: NewApplication): AddResult {
  const url = input.url ? normalizeUrl(input.url) : null;
  const stage = input.stage ?? "saved";
  const now = new Date();
  return db.transaction((tx): AddResult => {
    const company = companyFor(tx, input.company.trim());
    const title = input.title.trim();
    const sameJob = and(eq(jobs.companyId, company.id), sql`lower(${jobs.title}) = lower(${title})`);
    const existing = tx
      .select({ id: applications.id })
      .from(applications)
      .innerJoin(jobs, eq(applications.jobId, jobs.id))
      .where(url ? or(eq(jobs.url, url), sameJob) : sameJob)
      .get();
    if (existing) return { ok: false, existingId: existing.id };

    const job = tx
      .insert(jobs)
      .values({ source: "manual", externalId: randomUUID(), companyId: company.id, title, url, location: input.location?.trim() || null, description: input.description?.trim() || null })
      .returning()
      .get();
    const patch = stagePatch({ appliedAt: hasBeenSent(stage) ? (input.appliedAt ?? null) : null, nextAction: null, nextActionAt: null }, stage, now);
    const application = tx.insert(applications).values({ jobId: job.id, ...patch, createdAt: now }).returning().get();
    syncJobStatus(tx, job.id, application.appliedAt);
    tx.insert(events).values({ applicationId: application.id, kind: "stage_change", toStage: stage, summary: `Added as ${STAGE_LABELS[stage]}`, source: "manual" }).run();
    const note = input.note?.trim();
    if (note) tx.insert(events).values({ applicationId: application.id, kind: "note", summary: note, source: "manual" }).run();
    return { ok: true, id: application.id };
  });
}

function requireApplication(tx: Tx, id: number): Application {
  const application = tx.select().from(applications).where(eq(applications.id, id)).get();
  if (!application) throw new Error(`No application ${id}`);
  return application;
}

export function moveStage(db: Db, id: number, to: Stage, options: { source?: EventSource; evidence?: string; at?: Date } = {}): void {
  db.transaction((tx) => {
    const application = requireApplication(tx, id);
    if (!canMove(application.stage, to)) throw new Error(`Can't move from ${application.stage} to ${to}`);
    const patch = { ...stagePatch(application, to, options.at ?? new Date()), updatedAt: new Date() };
    tx.update(applications).set(patch).where(eq(applications.id, id)).run();
    syncJobStatus(tx, application.jobId, patch.appliedAt);
    tx.insert(events)
      .values({
        applicationId: id,
        kind: "stage_change",
        fromStage: application.stage,
        toStage: to,
        summary: `Moved from ${STAGE_LABELS[application.stage]} to ${STAGE_LABELS[to]}`,
        source: options.source ?? "manual",
        evidence: options.evidence ?? null,
      })
      .run();
  });
}

export function lastMove(db: Db | Tx, id: number) {
  return db
    .select()
    .from(events)
    .where(and(eq(events.applicationId, id), eq(events.kind, "stage_change")))
    .orderBy(desc(events.id))
    .get();
}

export function undoLastMove(db: Db, id: number): boolean {
  return db.transaction((tx) => {
    const application = requireApplication(tx, id);
    const move = lastMove(tx, id);
    if (!move?.fromStage) return false;
    const patch = stagePatch(application, move.fromStage, new Date());
    tx.update(applications).set(patch).where(eq(applications.id, id)).run();
    syncJobStatus(tx, application.jobId, patch.appliedAt);
    tx.insert(events)
      .values({
        applicationId: id,
        kind: "stage_change",
        fromStage: application.stage,
        toStage: move.fromStage,
        summary: `Undid the move to ${STAGE_LABELS[application.stage]}, back to ${STAGE_LABELS[move.fromStage]}`,
        source: "manual",
      })
      .run();
    return true;
  });
}

export function addNote(db: Db, id: number, text: string): void {
  db.transaction((tx) => {
    requireApplication(tx, id);
    tx.update(applications).set({ updatedAt: new Date() }).where(eq(applications.id, id)).run();
    tx.insert(events).values({ applicationId: id, kind: "note", summary: text.trim(), source: "manual" }).run();
  });
}

export const SEND_CHECK_DAYS = 3;

export function recordFormStarted(db: Db, id: number, summary = "Started filling in the form"): void {
  db.insert(events).values({ applicationId: id, kind: "note", summary, source: "apply" }).run();
}

export function applicationsToAskAbout(db: Db, now: Date = new Date()) {
  const cutoff = now.getTime() - SEND_CHECK_DAYS * DAY;
  return listingQuery(db)
    .where(eq(applications.stage, "packet_ready"))
    .all()
    .filter((application) => {
      const latest = db.select({ at: events.at }).from(events).where(and(eq(events.applicationId, application.id), eq(events.source, "apply"))).orderBy(desc(events.id)).get();
      return latest !== undefined && latest.at.getTime() <= cutoff;
    });
}

export function setNextAction(db: Db, id: number, text: string | null, at: Date | null): void {
  db.transaction((tx) => {
    requireApplication(tx, id);
    tx.update(applications).set({ nextAction: text?.trim() || null, nextActionAt: text?.trim() ? at : null, updatedAt: new Date() }).where(eq(applications.id, id)).run();
  });
}

export type Details = { company: string; title: string; url?: string; location?: string; description?: string };

export function updateDetails(db: Db, id: number, details: Details): void {
  db.transaction((tx) => {
    const application = requireApplication(tx, id);
    const company = companyFor(tx, details.company.trim());
    const current = tx.select({ description: jobs.description }).from(jobs).where(eq(jobs.id, application.jobId)).get();
    tx.update(jobs)
      .set({
        companyId: company.id,
        title: details.title.trim(),
        url: details.url ? normalizeUrl(details.url) : null,
        location: details.location?.trim() || null,
        ...(details.description === undefined ? {} : { description: details.description.trim() || null, ...(details.description.trim() === current?.description?.trim() ? {} : { previewOnly: false }) }),
      })
      .where(eq(jobs.id, application.jobId))
      .run();
    tx.update(applications).set({ updatedAt: new Date() }).where(eq(applications.id, id)).run();
  });
}

export function deleteApplication(db: Db, id: number): void {
  db.transaction((tx) => {
    const application = requireApplication(tx, id);
    tx.delete(calls).where(eq(calls.applicationId, id)).run();
    tx.delete(inboxFindings).where(eq(inboxFindings.applicationId, id)).run();
    tx.delete(events).where(eq(events.applicationId, id)).run();
    tx.delete(applications).where(eq(applications.id, id)).run();
    tx.delete(jobs).where(and(eq(jobs.id, application.jobId), eq(jobs.source, "manual"))).run();
    tx.update(jobs).set({ status: "new" }).where(eq(jobs.id, application.jobId)).run();
  });
}

const listing = {
  id: applications.id,
  stage: applications.stage,
  appliedAt: applications.appliedAt,
  nextAction: applications.nextAction,
  nextActionAt: applications.nextActionAt,
  createdAt: applications.createdAt,
  updatedAt: applications.updatedAt,
  packetPath: applications.packetPath,
  score: jobs.score,
  hasDescription: sql<boolean>`coalesce(trim(${jobs.description}), '') <> ''`.mapWith(Boolean),
  title: jobs.title,
  location: jobs.location,
  url: jobs.url,
  company: companies.name,
};

function listingQuery(db: Db) {
  return db.select(listing).from(applications).innerJoin(jobs, eq(applications.jobId, jobs.id)).innerJoin(companies, eq(jobs.companyId, companies.id));
}

export type ApplicationRow = ReturnType<typeof listApplications>[number];

export function listApplications(db: Db) {
  return listingQuery(db).orderBy(desc(applications.updatedAt), desc(applications.id)).all();
}

export function getApplication(db: Db, id: number) {
  const application = listingQuery(db).where(eq(applications.id, id)).get();
  if (!application) return undefined;
  const timeline = db.select().from(events).where(eq(events.applicationId, id)).orderBy(desc(events.id)).all();
  const job = db.select({ description: jobs.description }).from(jobs).innerJoin(applications, eq(applications.jobId, jobs.id)).where(eq(applications.id, id)).get();
  return { ...application, description: job?.description ?? null, timeline };
}

export function dueApplications(db: Db, now: Date = new Date()) {
  return listingQuery(db)
    .where(and(isNotNull(applications.nextActionAt), lte(applications.nextActionAt, now), notInArray(applications.stage, [...END_STAGES])))
    .orderBy(asc(applications.nextActionAt))
    .all();
}
