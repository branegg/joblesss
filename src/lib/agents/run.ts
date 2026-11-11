import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { eq } from "drizzle-orm";
import { getDb } from "../../db";
import { agentRuns } from "../../db/schema";
import { buildArgs, buildEnv, checkTools, otherServers, PROFILES, serversFromList, unexpectedToolUse, type AgentName } from "./profiles";

export type RunOptions = { prompt: string; jsonSchema?: object; timeoutMs?: number };
export type RunResult = {
  id: string;
  status: "ok" | "failed" | "blocked";
  result?: string;
  structured?: unknown;
  costUsd?: number;
  reason?: string;
  sessionTools?: string[];
};

export function logsDir(): string {
  const database = process.env.JOBLESSS_DB ?? path.join(process.cwd(), "data", "joblesss.db");
  return path.join(path.dirname(database), "logs");
}

function skillFile(agent: AgentName): string | undefined {
  const file = path.join(process.cwd(), ".claude", "skills", agent, "SKILL.md");
  return fs.existsSync(file) ? file : undefined;
}

function claudeBinary(): string {
  return process.env.JOBLESSS_CLAUDE_BIN ?? "claude";
}

function configuredServers(env: NodeJS.ProcessEnv): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(claudeBinary(), ["mcp", "list"], { env, cwd: process.cwd(), timeout: 120_000 }, (error, stdout) => resolve(error ? [] : serversFromList(stdout)));
  });
}

export async function runAgent(agent: AgentName, options: RunOptions): Promise<RunResult> {
  const profile = PROFILES[agent];
  const db = getDb();
  const id = randomUUID();
  const logDir = logsDir();
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `${id}.jsonl`);
  const log = fs.createWriteStream(logPath);
  db.insert(agentRuns).values({ id, agent, logPath }).run();

  let outcome: RunResult = { id, status: "failed", reason: "agent exited without a result" };
  let guarded = false;
  let sessionTools: string[] | undefined;
  let extraBlockedServers = profile.gmail ? await configuredServers(buildEnv(profile) as NodeJS.ProcessEnv) : [];
  let exitCode: number | null = null;
  let stderr = "";

  for (let attempt = 0; attempt < 3; attempt++) {
    const child = spawn(
      claudeBinary(),
      buildArgs(profile, { prompt: options.prompt, jsonSchema: options.jsonSchema, systemPromptFile: skillFile(agent), interactive: false, extraBlockedServers }),
      { env: buildEnv(profile) as NodeJS.ProcessEnv, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    guarded = false;
    stderr = "";
    let retry = false;
    const timer = options.timeoutMs ? setTimeout(() => {
      outcome = { id, status: "failed", reason: `stopped after ${Math.round(options.timeoutMs! / 60_000)} minutes` };
      child.kill("SIGTERM");
    }, options.timeoutMs) : undefined;
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const lines = readline.createInterface({ input: child.stdout });
    for await (const line of lines) {
      log.write(line + "\n");
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.type === "system" && message.subtype === "init" && !guarded) {
        guarded = true;
        sessionTools = (message.tools as string[]) ?? [];
        const check = checkTools(profile, sessionTools, { structuredOutput: Boolean(options.jsonSchema) });
        if (!check.ok) {
          const servers = profile.gmail && attempt < 2 && check.missing.length === 0 ? otherServers(check.extra) : undefined;
          if (servers) {
            extraBlockedServers = [...extraBlockedServers, ...servers];
            retry = true;
          } else {
            outcome = { id, status: "blocked", reason: check.reason };
          }
          child.kill("SIGTERM");
          break;
        }
      }
      if (message.type === "assistant") {
        const content = (message.message as { content?: { type?: string; name?: string }[] } | undefined)?.content ?? [];
        const stray = content.find((part) => part.type === "tool_use" && part.name && unexpectedToolUse(profile, part.name, { structuredOutput: Boolean(options.jsonSchema) }));
        if (stray) {
          outcome = { id, status: "blocked", reason: `stopped because it used a tool outside its list: ${stray.name}` };
          child.kill("SIGTERM");
          break;
        }
      }
      if (message.type === "result") {
        outcome = {
          id,
          status: message.is_error ? "failed" : "ok",
          result: message.result as string | undefined,
          structured: message.structured_output,
          costUsd: message.total_cost_usd as number | undefined,
          reason: message.is_error ? String(message.result ?? message.subtype) : undefined,
          sessionTools,
        };
      }
    }

    exitCode = await new Promise<number | null>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode);
      else child.once("close", resolve);
    });
    clearTimeout(timer);
    if (!retry) break;
  }
  log.end();

  if (!guarded && outcome.status === "failed") {
    outcome = { id, status: "blocked", reason: `no session started, so tools could not be checked (exit ${exitCode}): ${stderr.slice(0, 500)}` };
  }

  db.update(agentRuns)
    .set({
      endedAt: new Date(),
      status: outcome.status,
      result: outcome.reason ?? (options.jsonSchema ? null : (outcome.result ?? null)),
      costUsd: outcome.costUsd ?? null,
    })
    .where(eq(agentRuns.id, id))
    .run();
  return outcome;
}

export function launchInteractive(agent: AgentName, prompt?: string): Promise<number> {
  const profile = PROFILES[agent];
  const child = spawn(
    claudeBinary(),
    buildArgs(profile, { prompt, systemPromptFile: skillFile(agent), interactive: true }),
    { env: buildEnv(profile) as NodeJS.ProcessEnv, cwd: process.cwd(), stdio: "inherit" },
  );
  return new Promise((resolve) => child.once("close", (code) => resolve(code ?? 1)));
}
