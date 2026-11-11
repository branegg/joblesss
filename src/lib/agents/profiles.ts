import { readSources, sourceRules } from "./sources";

export const GMAIL_READ = [
  "mcp__claude_ai_Gmail__search_threads",
  "mcp__claude_ai_Gmail__get_thread",
  "mcp__claude_ai_Gmail__get_message",
];

const GMAIL_BLOCKED = [
  "apply_sensitive_message_label",
  "apply_sensitive_thread_label",
  "create_draft",
  "download_gmail_attachment",
  "create_label",
  "delete_draft",
  "delete_label",
  "forward",
  "get_draft",
  "label_message",
  "label_thread",
  "list_drafts",
  "list_labels",
  "mark_message_spam",
  "mark_thread_spam",
  "reply",
  "send_message",
  "trash_message",
  "trash_thread",
  "unlabel_message",
  "unlabel_thread",
  "unmark_message_spam",
  "unmark_thread_spam",
  "untrash_message",
  "untrash_thread",
  "update_draft",
  "update_label",
  "update_message_labels",
].map((tool) => `mcp__claude_ai_Gmail__${tool}`);

const OTHER_CONNECTORS = [
  "Claude_Docs",
  "Vercel",
  "Supabase",
  "Linear",
  "Google_Drive",
  "Google_Calendar",
].map((server) => `mcp__claude_ai_${server}__*`);

const CHROME_BLOCKED = [
  "javascript_tool",
  "shortcuts_execute",
  "shortcuts_list",
  "browser_batch",
  "read_network_requests",
  "read_console_messages",
  "gif_creator",
  "upload_image",
].map((tool) => `mcp__claude-in-chrome__${tool}`);

const SECRET_READS = ["Read(**/.env*)", "Read(**/*.pem)", "Read(**/*.key)", "Read(**/credentials*)", "Read(**/secrets*)"];
const ROOT = `/${process.cwd()}`;
const VAULT_WRITE = [`Edit(${ROOT}/vault/**)`];
const FILE_TOOLS = ["Read", "Glob", "Grep"];
const EDIT_TOOLS = ["Write", "Edit"];

export type AgentName = "setup" | "remember" | "voice" | "profile-import" | "ask" | "job-scout" | "tailor" | "apply" | "inbox";

export type AgentProfile = {
  name: AgentName;
  model: string;
  tools: string[];
  mcpTools?: string[];
  chrome?: boolean;
  gmail?: boolean;
  allow: string[];
  deny: string[];
  interactive?: boolean;
  opening?: string;
};

export const PROFILES: Record<AgentName, AgentProfile> = {
  setup: {
    name: "setup",
    model: "sonnet",
    tools: [...FILE_TOOLS, ...EDIT_TOOLS],
    allow: [...VAULT_WRITE],
    deny: SECRET_READS,
    interactive: true,
    opening: "Start the interview now. Say in one line what this is, then ask your first question.",
  },
  remember: {
    name: "remember",
    model: "sonnet",
    tools: [...FILE_TOOLS, ...EDIT_TOOLS],
    allow: [...VAULT_WRITE],
    deny: SECRET_READS,
    interactive: true,
    opening: "Ask me what I want to save.",
  },
  voice: {
    name: "voice",
    model: "sonnet",
    tools: [...FILE_TOOLS, ...EDIT_TOOLS],
    allow: [...VAULT_WRITE],
    deny: SECRET_READS,
    interactive: true,
    opening: "Start the interview now. Say in one line what this is for, then ask your first question.",
  },
  "profile-import": {
    name: "profile-import",
    model: "sonnet",
    tools: [...FILE_TOOLS, ...EDIT_TOOLS],
    get allow() {
      return [...VAULT_WRITE, `Read(${ROOT}/data/sources/**)`, ...sourceRules(readSources()).allow];
    },
    get deny() {
      return [...SECRET_READS, ...sourceRules(readSources()).deny];
    },
  },
  ask: {
    name: "ask",
    model: "sonnet",
    tools: FILE_TOOLS,
    allow: [`Read(${ROOT}/vault/**)`],
    deny: SECRET_READS,
  },
  "job-scout": {
    name: "job-scout",
    model: "sonnet",
    tools: FILE_TOOLS,
    allow: [`Read(${ROOT}/vault/**)`],
    deny: SECRET_READS,
  },
  tailor: {
    name: "tailor",
    model: "opus",
    tools: [],
    allow: [],
    deny: SECRET_READS,
  },
  apply: {
    name: "apply",
    model: "sonnet",
    tools: ["Read", "ToolSearch"],
    chrome: true,
    allow: [`Read(${ROOT}/data/packets/**)`, "mcp__claude-in-chrome__*"],
    deny: SECRET_READS,
    interactive: true,
  },
  inbox: {
    name: "inbox",
    model: "sonnet",
    tools: ["ToolSearch"],
    gmail: true,
    mcpTools: GMAIL_READ,
    allow: [...GMAIL_READ],
    deny: [],
  },
};

export type BuildOptions = { prompt?: string; jsonSchema?: object; systemPromptFile?: string; interactive?: boolean; extraBlockedServers?: string[] };

function safePrompt(prompt: string): string {
  return prompt.startsWith("-") ? `Request: ${prompt}` : prompt;
}

export function buildArgs(profile: AgentProfile, options: BuildOptions = {}): string[] {
  const interactive = options.interactive ?? profile.interactive ?? false;
  const args = [
    "--model",
    process.env.JOBLESSS_MODEL ?? profile.model,
    "--setting-sources",
    profile.gmail ? "user,project" : "project",
    "--permission-mode",
    "dontAsk",
    "--tools",
    profile.tools.join(","),
    "--settings",
    JSON.stringify({ permissions: { allow: profile.allow, deny: profile.deny }, ...(profile.gmail ? { disableAllHooks: true } : {}) }),
  ];
  if (profile.gmail) {
    const extra = (options.extraBlockedServers ?? []).map((server) => `mcp__${server}__*`);
    args.push("--disable-slash-commands", "--disallowedTools", [...GMAIL_BLOCKED, ...OTHER_CONNECTORS, ...extra].join(","));
  } else if (!profile.chrome) {
    args.push("--strict-mcp-config");
  }
  if (profile.chrome) args.push("--disallowedTools", CHROME_BLOCKED.join(","), "--chrome", "--strict-mcp-config");
  if (options.systemPromptFile) args.push("--append-system-prompt-file", options.systemPromptFile);
  if (interactive) {
    const prompt = options.prompt || profile.opening;
    if (prompt) args.push(safePrompt(prompt));
    return args;
  }
  args.push("-p", safePrompt(options.prompt ?? ""), "--output-format", "stream-json", "--verbose");
  if (options.jsonSchema) args.push("--json-schema", JSON.stringify(options.jsonSchema));
  return args;
}

type Env = Record<string, string | undefined>;

export function buildEnv(profile: AgentProfile, base: Env = process.env): Env {
  const env: Env = { ...base };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION = "false";
  if (profile.gmail) delete env.ENABLE_CLAUDEAI_MCP_SERVERS;
  else env.ENABLE_CLAUDEAI_MCP_SERVERS = "false";
  return env;
}

export function otherServers(extraTools: string[]): string[] | undefined {
  const servers = new Set<string>();
  for (const tool of extraTools) {
    const server = tool.match(/^mcp__([^_].*?)__/)?.[1];
    if (!server || server === "claude_ai_Gmail") return undefined;
    servers.add(server);
  }
  return [...servers];
}

export function serversFromList(output: string): string[] {
  const servers = new Set<string>();
  for (const line of output.split("\n")) {
    const name = line.match(/^(.+?): .+ - /)?.[1]?.trim();
    if (!name) continue;
    const prefix = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (prefix !== "claude_ai_Gmail") servers.add(prefix);
  }
  return [...servers];
}

export function unexpectedToolUse(profile: AgentProfile, tool: string, options: { structuredOutput?: boolean } = {}): boolean {
  if (tool === "StructuredOutput") return !options.structuredOutput;
  if (profile.chrome && tool.startsWith("mcp__claude-in-chrome__")) return false;
  return !profile.tools.includes(tool) && !(profile.mcpTools ?? []).includes(tool);
}

export type GuardResult = { ok: true } | { ok: false; reason: string; extra: string[]; missing: string[] };

export function checkTools(profile: AgentProfile, sessionTools: string[], options: { structuredOutput?: boolean } = {}): GuardResult {
  const permitted = new Set([...profile.tools, ...(profile.mcpTools ?? []), ...(options.structuredOutput ? ["StructuredOutput"] : [])]);
  const extra = sessionTools.filter((tool) => {
    if (permitted.has(tool)) return false;
    return !(profile.chrome && tool.startsWith("mcp__claude-in-chrome__"));
  });
  const missing = [...permitted].filter((tool) => !sessionTools.includes(tool));
  if (extra.length === 0 && missing.length === 0) return { ok: true };
  const parts = [];
  if (extra.length) parts.push(`unexpected tools: ${extra.join(", ")}`);
  if (missing.length) parts.push(`missing tools: ${missing.join(", ")}`);
  return { ok: false, reason: parts.join("; "), extra, missing };
}
