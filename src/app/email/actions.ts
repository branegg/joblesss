"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import { checkEmail, describeCheck } from "@/lib/inbox/check";
import { acceptFinding, ignoreFinding, markReplySeen } from "@/lib/inbox/inbox";
import { canMove } from "@/lib/stages";
import { readSettings, writeSettings } from "@/lib/settings";
import { getApplication, moveStage, recordFormStarted } from "@/lib/tracker";

const id = z.number().int().positive();

function changed() {
  revalidatePath("/", "layout");
}

export async function acceptFindingAction(findingId: number) {
  acceptFinding(getDb(), id.parse(findingId));
  changed();
}

export async function ignoreFindingAction(findingId: number) {
  ignoreFinding(getDb(), id.parse(findingId));
  changed();
}

export async function markReplyRead(findingId: number) {
  markReplySeen(getDb(), id.parse(findingId));
  changed();
}

export async function setAutoApply(value: boolean) {
  writeSettings({ ...readSettings(), inboxAutoApply: z.boolean().parse(value) });
  changed();
}

export async function sentAnswer(applicationId: number, sent: boolean) {
  const db = getDb();
  const valid = id.parse(applicationId);
  const current = getApplication(db, valid);
  if (current?.stage === "packet_ready") {
    if (sent && canMove(current.stage, "submitted")) moveStage(db, valid, "submitted");
    if (!sent) recordFormStarted(db, valid, "Not sent yet");
  }
  changed();
}

export type CheckState = { message?: string; error?: string };

export async function checkEmailAction(_previous: CheckState, form: FormData): Promise<CheckState> {
  void form;
  const summary = await checkEmail(getDb());
  changed();
  if (summary.skipped) return { message: "Nothing to check: you have no open applications." };
  if (!summary.ok) return { error: `The email check stopped: ${summary.reason}. See Agent activity.` };
  return { message: describeCheck(summary) };
}
