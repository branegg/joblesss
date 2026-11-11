"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import { addCall, moveCall, removeCall } from "@/lib/calls";

const id = z.coerce.number().int().positive();
const when = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
  .transform((value) => new Date(value))
  .refine((date) => !Number.isNaN(date.getTime()));

export async function saveCall(form: FormData) {
  const at = when.safeParse(String(form.get("at") ?? ""));
  if (!at.success) return;
  const callId = form.get("callId");
  if (callId) moveCall(getDb(), id.parse(callId), at.data);
  else addCall(getDb(), id.parse(form.get("applicationId")), at.data);
  revalidatePath("/", "layout");
}

export async function deleteCall(form: FormData) {
  removeCall(getDb(), id.parse(form.get("callId")));
  revalidatePath("/", "layout");
}
