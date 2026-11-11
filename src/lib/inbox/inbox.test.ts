import { describe, expect, it } from "vitest";
import { openDb } from "../../db";
import { agentRuns, events } from "../../db/schema";
import { addApplication, applicationsToAskAbout, deleteApplication, FOLLOW_UP, getApplication, moveStage, recordFormStarted, undoLastMove } from "../tracker";
import { acceptFinding, applicationsToCheck, buildInboxPrompt, FINDINGS_JSON_SCHEMA, findingsSchema, ignoreFinding, pendingFindings, recentFindings, recordFindings } from "./inbox";

const DAY = 24 * 60 * 60 * 1000;
const iso = (offsetDays = 0) => new Date(Date.now() + offsetDays * DAY).toISOString();

function setup(stage: "packet_ready" | "saved" | "submitted" = "packet_ready") {
  const { db } = openDb(":memory:");
  const result = addApplication(db, { company: "Acme", title: "Engineering Lead", stage });
  if (!result.ok) throw new Error("expected new");
  return { db, id: result.id, rows: () => applicationsToCheck(db) };
}
const finding = (applicationId: number, extra = {}) => ({ applicationId, kind: "confirmation", confidence: "high", suspicious: false, messageId: "m1", emailDate: iso(), from: "no-reply@ashbyhq.com", subject: "Thanks for applying", quote: "We received your application.", ...extra });

describe("what gets checked", () => {
  it("covers open applications only and needs nothing about you", () => {
    const { db, id, rows } = setup();
    const closed = addApplication(db, { company: "Other", title: "CTO", stage: "submitted" });
    if (!closed.ok) throw new Error();
    moveStage(db, closed.id, "rejected");
    expect(rows().map((row) => row.id)).toEqual([id]);
    const prompt = buildInboxPrompt(rows());
    expect(prompt).toContain("Acme");
    expect(prompt).not.toContain("earliestEmail");
  });
  it("searches from a day before the application at first, then only since the last check", () => {
    const { db, rows } = setup();
    const today = new Date();
    const first = rows()[0].searchAfter;
    expect(new Date(first).getTime()).toBeLessThan(today.getTime());
    db.insert(agentRuns).values({ id: "r", agent: "inbox", status: "ok", startedAt: new Date(Date.now() + 5 * DAY) }).run();
    expect(new Date(rows()[0].searchAfter).getTime()).toBeGreaterThan(today.getTime());
  });
  it("reaches back to the sent date of an older application added later", () => {
    const { db } = setup();
    db.insert(agentRuns).values({ id: "r", agent: "inbox", status: "ok", startedAt: new Date(Date.now() - DAY) }).run();
    const old = addApplication(db, { company: "Old", title: "CTO", stage: "submitted", appliedAt: new Date(Date.now() - 40 * DAY) });
    if (!old.ok) throw new Error();
    const row = applicationsToCheck(db).find((item) => item.id === old.id)!;
    expect(new Date(row.searchAfter).getTime()).toBeLessThan(Date.now() - 39 * DAY);
  });
});

describe("in ask-first mode", () => {
  it("changes nothing until you say so", () => {
    const { db, id, rows } = setup();
    expect(recordFindings(db, rows(), { findings: [finding(id)] }, false)).toMatchObject({ proposed: 1, applied: 0 });
    expect(getApplication(db, id)!.stage).toBe("packet_ready");
    expect(pendingFindings(db)).toHaveLength(1);
  });
  it("accepting moves it, dated from the email, with the email as evidence", () => {
    const { db, id, rows } = setup();
    const sent = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    recordFindings(db, rows(), { findings: [finding(id, { emailDate: sent })] }, false);
    acceptFinding(db, pendingFindings(db)[0].id);
    const application = getApplication(db, id)!;
    expect(application.stage).toBe("submitted");
    expect(application.appliedAt!.getTime()).toBe(Math.floor(new Date(sent).getTime() / 1000) * 1000);
    expect(application.nextAction).toBe(FOLLOW_UP);
    expect(application.nextActionAt!.getTime()).toBe(application.appliedAt!.getTime() + 7 * DAY);
    expect(application.timeline[0]).toMatchObject({ source: "inbox", evidence: expect.stringContaining("We received your application.") });
    expect(pendingFindings(db)).toEqual([]);
  });
  it("ignoring leaves the application alone and the email isn't raised again", () => {
    const { db, id, rows } = setup();
    recordFindings(db, rows(), { findings: [finding(id)] }, false);
    ignoreFinding(db, pendingFindings(db)[0].id);
    expect(getApplication(db, id)!.stage).toBe("packet_ready");
    expect(recordFindings(db, rows(), { findings: [finding(id)] }, false)).toMatchObject({ proposed: 0, repeats: 1 });
    expect(recentFindings(db)[0].status).toBe("ignored");
  });
});

describe("in automatic mode", () => {
  it("applies a clear update straight away", () => {
    const { db, id, rows } = setup();
    expect(recordFindings(db, rows(), { findings: [finding(id)] }, true)).toMatchObject({ applied: 1, proposed: 0 });
    expect(getApplication(db, id)!.stage).toBe("submitted");
  });
  it("still waits for you on anything unclear or suspicious", () => {
    const { db, id, rows } = setup();
    const summary = recordFindings(db, rows(), { findings: [finding(id, { confidence: "low" }), finding(id, { messageId: "m2", suspicious: true, kind: "rejection" })] }, true);
    expect(summary).toMatchObject({ applied: 0, proposed: 2 });
    expect(getApplication(db, id)!.stage).toBe("packet_ready");
  });
  it("follows several emails in the order they were sent", () => {
    const { db, id, rows } = setup();
    recordFindings(db, rows(), { findings: [finding(id, { messageId: "b", kind: "interview", emailDate: iso() }), finding(id, { messageId: "a", emailDate: iso(-0.5) })] }, true);
    expect(getApplication(db, id)!.stage).toBe("interview");
  });
  it("won't redo a move you undid", () => {
    const { db, id, rows } = setup();
    recordFindings(db, rows(), { findings: [finding(id)] }, true);
    undoLastMove(db, id);
    recordFindings(db, rows(), { findings: [finding(id)] }, true);
    expect(getApplication(db, id)!.stage).toBe("packet_ready");
  });
  it("adds a general update to the timeline without moving the stage", () => {
    const { db, id, rows } = setup();
    recordFindings(db, rows(), { findings: [finding(id, { kind: "update", subject: "Role on hold" })] }, true);
    const application = getApplication(db, id)!;
    expect(application.stage).toBe("packet_ready");
    expect(application.timeline[0]).toMatchObject({ kind: "email", summary: "Role on hold" });
  });
});

describe("what it refuses", () => {
  it("drops findings for applications it wasn't asked about, bad dates and emails from before you applied", () => {
    const { db, id, rows } = setup();
    const result = recordFindings(db, rows(), { findings: [finding(999), finding(id, { messageId: "x", emailDate: "soon" }), finding(id, { messageId: "y", emailDate: iso(-30) })] }, true);
    expect(result.dropped).toBe(3);
    expect(getApplication(db, id)!.stage).toBe("packet_ready");
  });
  it("doesn't raise an update that's already true", () => {
    const { db, id, rows } = setup("submitted");
    expect(recordFindings(db, rows(), { findings: [finding(id)] }, false)).toMatchObject({ proposed: 0, noChange: 1 });
    expect(pendingFindings(db)).toEqual([]);
  });
  it("refuses an output in the wrong shape", () => {
    const { db, id, rows } = setup();
    expect(() => recordFindings(db, rows(), { findings: [finding(id, { kind: "hired" })] }, true)).toThrow();
  });
  it("deleting an application takes its findings with it", () => {
    const { db, id, rows } = setup();
    recordFindings(db, rows(), { findings: [finding(id)] }, false);
    deleteApplication(db, id);
    expect(pendingFindings(db)).toEqual([]);
  });
});

describe("asking whether you sent it", () => {
  it("asks only a few days after form filling, with no email found", () => {
    const { db, id } = setup();
    recordFormStarted(db, id);
    expect(applicationsToAskAbout(db)).toEqual([]);
    expect(applicationsToAskAbout(db, new Date(Date.now() + 4 * DAY)).map((row) => row.id)).toEqual([id]);
  });
  it("doesn't ask if the form was never started", () => {
    const { db } = setup();
    expect(applicationsToAskAbout(db, new Date(Date.now() + 4 * DAY))).toEqual([]);
  });
  it("stops asking once it's sent, and 'not yet' waits again", () => {
    const { db, id } = setup();
    recordFormStarted(db, id);
    db.update(events).set({ at: new Date(Date.now() - 5 * DAY) }).run();
    expect(applicationsToAskAbout(db)).toHaveLength(1);
    recordFormStarted(db, id, "Not sent yet");
    expect(applicationsToAskAbout(db)).toEqual([]);
    db.update(events).set({ at: new Date(Date.now() - 5 * DAY) }).run();
    moveStage(db, id, "submitted");
    expect(applicationsToAskAbout(db)).toEqual([]);
  });
});

describe("calls in what the check reports", () => {
  it("reads calls when there are some and an empty list when there aren't", () => {
    const call = { applicationId: 1, eventId: "e1", start: "2026-11-14T09:00:00-05:00", title: "Interview", confidence: "high" };
    expect(findingsSchema.parse({ findings: [], calls: [call] }).calls).toEqual([call]);
    expect(findingsSchema.parse({ findings: [] }).calls).toBeUndefined();
    expect(FINDINGS_JSON_SCHEMA.properties.calls.items.required).toEqual(["applicationId", "eventId", "start", "title", "confidence"]);
    expect(FINDINGS_JSON_SCHEMA.required).toEqual(["findings"]);
  });
});
