export const RUN_LABELS = { running: "Running", ok: "Finished", failed: "Failed", blocked: "Stopped by safety check" } as const;

const NAMES: Record<string, string> = {
  setup: "First-run interview",
  remember: "Saved a note",
  voice: "Interview about how you sound",
  "profile-import": "Profile import",
  ask: "Question about profile",
  "job-scout": "Job scoring",
  "fetch-jobs": "Job check",
  tailor: "Application packet",
  apply: "Form filling",
  inbox: "Email check",
};

export function runName(agent: string): string {
  return NAMES[agent] ?? agent;
}

export function formatWhen(date: Date): string {
  return date.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function formatClock(date: Date, now: Date = new Date()): string {
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay ? date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function formatDuration(start: Date, end: Date | null): string {
  if (!end) return "";
  const seconds = Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
  return seconds < 90 ? `${seconds}s` : `${Math.round(seconds / 60)} min`;
}

export function formatDay(date: Date): string {
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function toDayInput(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function parseDay(value: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) || toDayInput(date) !== value ? undefined : date;
}

export function formatAgo(date: Date, now: Date = new Date()): string {
  const start = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((start(now) - start(date)) / (24 * 60 * 60 * 1000));
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}
