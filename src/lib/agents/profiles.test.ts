import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { buildArgs, buildEnv, CALENDAR_BLOCKED, CALENDAR_READ, checkTools, GMAIL_READ, otherServers, PROFILES, serversFromList, unexpectedToolUse } from "./profiles";
import { isCvName, parseSources, sourceRules } from "./sources";

const flagValue = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe("agent settings", () => {
  it("every agent runs in dontAsk mode with project settings only", () => {
    for (const profile of Object.values(PROFILES)) {
      const args = buildArgs(profile, { prompt: "x" });
      expect(flagValue(args, "--permission-mode")).toBe("dontAsk");
      expect(flagValue(args, "--setting-sources")).toBe(profile.gmail ? "user,project" : "project");
    }
  });
  it("interactive agents start talking on their own unless given a prompt", () => {
    for (const name of ["setup", "remember", "voice"] as const) {
      const profile = PROFILES[name];
      const opened = buildArgs(profile, { systemPromptFile: "skill.md", interactive: true });
      expect(opened.at(-1)).toBe(profile.opening);
      expect(opened.at(-3)).toBe("--append-system-prompt-file");
      expect(buildArgs(profile, { prompt: "shipped X", interactive: true }).at(-1)).toBe("shipped X");
    }
  });
  it("no agent offers suggested replies the person could accept as their own words", () => {
    for (const profile of Object.values(PROFILES)) {
      expect(buildEnv(profile, {}).CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION).toBe("false");
    }
  });
  it("allows the structured output tool only on a run that asked for it", () => {
    const tools = [...PROFILES["job-scout"].tools, "StructuredOutput"];
    expect(checkTools(PROFILES["job-scout"], tools).ok).toBe(false);
    expect(checkTools(PROFILES["job-scout"], tools, { structuredOutput: true }).ok).toBe(true);
    expect(checkTools(PROFILES["job-scout"], [...tools, "Bash"], { structuredOutput: true }).ok).toBe(false);
  });
  it("the email agent turns off your hooks and skills, since connectors need user settings", () => {
    const args = buildArgs(PROFILES.inbox, { prompt: "x" });
    expect(JSON.parse(flagValue(args, "--settings")).disableAllHooks).toBe(true);
    expect(args).toContain("--disable-slash-commands");
    expect(args).not.toContain("--strict-mcp-config");
    const others = buildArgs(PROFILES.ask, { prompt: "x" });
    expect(JSON.parse(flagValue(others, "--settings")).disableAllHooks).toBeUndefined();
  });
  it("blocks other servers it found, but never treats an extra Gmail tool as something to retry past", () => {
    expect(otherServers(["mcp__cloudflare__kv_put", "mcp__elevenlabs__play_audio", "mcp__cloudflare__kv_get"])).toEqual(["cloudflare", "elevenlabs"]);
    expect(otherServers(["mcp__claude_ai_Gmail__send_message"])).toBeUndefined();
    expect(otherServers(["mcp__cloudflare__kv_put", "Bash"])).toBeUndefined();
    expect(flagValue(buildArgs(PROFILES.inbox, { prompt: "x", extraBlockedServers: ["cloudflare"] }), "--disallowedTools")).toContain("mcp__cloudflare__*");
  });
  it("reads every configured server to block up front, except Gmail", () => {
    const listed = "Checking MCP server health...\n\nclaude.ai Gmail: https://g.example - ✓ Connected\nclaude.ai Vercel: https://v.example - ! Needs authentication\ncloudflare: npx x - ✓ Connected\nplugin:context7:context7: npx y - ✗ Failed to connect\n";
    expect(serversFromList(listed)).toEqual(["claude_ai_Vercel", "cloudflare", "plugin_context7_context7"]);
  });
  it("spots a tool used mid-run that isn't on the list", () => {
    expect(unexpectedToolUse(PROFILES.inbox, "mcp__claude_ai_Gmail__search_threads")).toBe(false);
    expect(unexpectedToolUse(PROFILES.inbox, "ToolSearch")).toBe(false);
    expect(unexpectedToolUse(PROFILES.inbox, "mcp__cloudflare__kv_put")).toBe(true);
    expect(unexpectedToolUse(PROFILES.inbox, "mcp__claude_ai_Gmail__send_message")).toBe(true);
    expect(unexpectedToolUse(PROFILES.inbox, "StructuredOutput")).toBe(true);
    expect(unexpectedToolUse(PROFILES.inbox, "StructuredOutput", { structuredOutput: true })).toBe(false);
  });
  it("the CV writer has no file access, so it sees only what it's given", () => {
    expect(PROFILES.tailor.tools).toEqual([]);
    expect(PROFILES.tailor.allow).toEqual([]);
  });
  it("the form filler can't run scripts in the page, which could submit a form", () => {
    const blocked = flagValue(buildArgs(PROFILES.apply, { prompt: "x", interactive: true }), "--disallowedTools");
    for (const tool of ["javascript_tool", "browser_batch", "shortcuts_execute"]) expect(blocked).toContain(`mcp__claude-in-chrome__${tool}`);
  });
  it("no agent ever receives Bash or web tools", () => {
    for (const profile of Object.values(PROFILES)) {
      for (const forbidden of ["Bash", "WebFetch", "WebSearch", "Agent", "Skill"]) {
        expect(profile.tools).not.toContain(forbidden);
      }
    }
  });
  it("only inbox can reach Gmail, and only for reading", () => {
    for (const profile of Object.values(PROFILES)) {
      const env = buildEnv(profile, {});
      if (profile.name === "inbox") {
        expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBeUndefined();
        const blocked = flagValue(buildArgs(profile, { prompt: "x" }), "--disallowedTools");
        for (const tool of ["send_message", "reply", "forward", "trash_message", "create_draft"]) {
          expect(blocked).toContain(`mcp__claude_ai_Gmail__${tool}`);
        }
      } else {
        expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
        expect(profile.mcpTools ?? []).toEqual([]);
      }
    }
  });
  it("only apply can reach the browser, and it can't reach Gmail", () => {
    for (const profile of Object.values(PROFILES)) {
      expect(buildArgs(profile, { prompt: "x" }).includes("--chrome")).toBe(profile.name === "apply");
    }
    expect(PROFILES.apply.gmail).toBeUndefined();
  });
  it("a prompt can't be mistaken for a command line flag", () => {
    const args = buildArgs(PROFILES.ask, { prompt: "--dangerously-skip-permissions" });
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(flagValue(args, "-p")).toBe("Request: --dangerously-skip-permissions");
  });
  it("strips credentials that would bill per token", () => {
    const env = buildEnv(PROFILES.ask, { ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t", CLAUDE_CODE_OAUTH_TOKEN: "o", PATH: "/bin" });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.PATH).toBe("/bin");
  });
  it("profile-import can't read secrets", () => {
    expect(PROFILES["profile-import"].deny).toContain("Read(**/.env*)");
  });
});

describe("checkTools", () => {
  it("passes on the exact set", () => {
    expect(checkTools(PROFILES.inbox, ["ToolSearch", ...GMAIL_READ]).ok).toBe(true);
  });
  it("blocks when an extra tool is present", () => {
    const result = checkTools(PROFILES.inbox, ["ToolSearch", ...GMAIL_READ, "mcp__claude_ai_Gmail__send_message"]);
    expect(result).toMatchObject({ ok: false, extra: ["mcp__claude_ai_Gmail__send_message"] });
  });
  it("blocks when a required tool is missing, such as a disconnected Gmail", () => {
    const result = checkTools(PROFILES.inbox, ["ToolSearch"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missing).toEqual(GMAIL_READ);
  });
  it("allows browser tools only for apply", () => {
    expect(checkTools(PROFILES.apply, ["Read", "ToolSearch", "mcp__claude-in-chrome__navigate"]).ok).toBe(true);
    expect(checkTools(PROFILES.ask, ["Read", "Glob", "Grep", "mcp__claude-in-chrome__navigate"]).ok).toBe(false);
  });
});

describe("the folders profile-import may read", () => {
  it("grants nothing until the person names a folder", () => {
    expect(sourceRules(parseSources("", "/home/me"))).toEqual({ allow: [], deny: [] });
  });
  it("expands the home folder and allows only what's named", () => {
    const rules = sourceRules(parseSources("cvFolders: [~/cvs]\nprojectFolders: [/work]", "/home/me"));
    expect(rules.allow).toEqual(["Read(//home/me/cvs/**)", "Read(//work/**)"]);
  });
  it("narrows a CV folder to files with a CV name, so the rest of it stays closed", () => {
    const rules = sourceRules(parseSources("cvFolders: [~/Documents]\ncvNames: [CV, Resume]\nprojectFolders: [/work]", "/home/me"));
    expect(rules.allow).toEqual([
      "Read(//home/me/Documents/*CV*.pdf)",
      "Read(//home/me/Documents/*CV*.md)",
      "Read(//home/me/Documents/*CV*.txt)",
      "Read(//home/me/Documents/*Resume*.pdf)",
      "Read(//home/me/Documents/*Resume*.md)",
      "Read(//home/me/Documents/*Resume*.txt)",
      "Read(//work/**)",
    ]);
    expect(isCvName("CV Alex.pdf", { cvNames: ["CV"] })).toBe(true);
    expect(isCvName("taxes.pdf", { cvNames: ["CV"] })).toBe(false);
    expect(isCvName("taxes.pdf", { cvNames: [] })).toBe(true);
  });
  it("refuses a CV name that would widen what can be read", () => {
    for (const name of ["*", "CV/**", "..", "[CV]", "C?", "{a,b}", "a\\b"]) expect(() => parseSources(`cvFolders: [~/Documents]\ncvNames: ["${name.replaceAll("\\", "\\\\")}"]`, "/home/me")).toThrow();
  });
  it("blocks excluded names in every folder it can read", () => {
    const rules = sourceRules(parseSources("cvFolders: [~/cvs]\nprojectFolders: [/work]\nexclude: [Someone Else]", "/home/me"));
    expect(rules.deny).toEqual(["Read(//home/me/cvs/**/*Someone Else*)", "Read(//work/**/*Someone Else*)"]);
  });
  it("refuses a relative folder", () => {
    expect(() => parseSources("cvFolders: [cvs]", "/home/me")).toThrow();
  });
});

describe("the example settings", () => {
  it("sources.example.yaml is valid", () => {
    expect(parseSources(fs.readFileSync("sources.example.yaml", "utf8"), "/home/me").cvFolders).toEqual(["/home/me/Documents/CVs"]);
  });
});

describe("the email check and the calendar", () => {
  it("lets the email check read the calendar but never change it", () => {
    const args = buildArgs(PROFILES.inbox, { prompt: "x" });
    const blocked = flagValue(args, "--disallowedTools").split(",");
    for (const tool of CALENDAR_BLOCKED) expect(blocked).toContain(tool);
    expect(blocked).not.toContain("mcp__claude_ai_Google_Calendar__*");
    for (const tool of CALENDAR_READ) expect(blocked).not.toContain(tool);
    for (const tool of CALENDAR_READ) expect(PROFILES.inbox.allow).toContain(tool);
    expect(CALENDAR_BLOCKED).toEqual(expect.arrayContaining(["create_event", "update_event", "delete_event", "respond_to_event"].map((tool) => `mcp__claude_ai_Google_Calendar__${tool}`)));
    expect(unexpectedToolUse(PROFILES.inbox, "mcp__claude_ai_Google_Calendar__list_events")).toBe(false);
    expect(unexpectedToolUse(PROFILES.inbox, "mcp__claude_ai_Google_Calendar__create_event")).toBe(true);
  });
  it("doesn't block the calendar up front, and shuts it off entirely if it shows an unknown tool", () => {
    const listed = "claude.ai Gmail: https://g.example - ✓ Connected\nclaude.ai Google Calendar: https://c.example - ✓ Connected\n";
    expect(serversFromList(listed)).toEqual([]);
    expect(otherServers(["mcp__claude_ai_Google_Calendar__new_write_tool"])).toEqual(["claude_ai_Google_Calendar"]);
  });
  it("doesn't need the calendar to be signed in", () => {
    expect(checkTools(PROFILES.inbox, ["ToolSearch", ...GMAIL_READ]).ok).toBe(true);
    expect(checkTools(PROFILES.inbox, ["ToolSearch", ...GMAIL_READ, ...CALENDAR_READ]).ok).toBe(true);
    expect(checkTools(PROFILES.inbox, ["ToolSearch", ...GMAIL_READ, "mcp__claude_ai_Google_Calendar__create_event"]).ok).toBe(false);
  });
  it("no other agent can reach the calendar", () => {
    for (const profile of Object.values(PROFILES).filter((profile) => profile.name !== "inbox")) {
      expect(profile.optionalMcpTools).toBeUndefined();
      expect(profile.allow.some((rule) => rule.includes("Google_Calendar"))).toBe(false);
    }
  });
});

describe("Gmail tools added later", () => {
  it("blocks downloading attachments, which the email check never needs", () => {
    const blocked = flagValue(buildArgs(PROFILES.inbox, { prompt: "x" }), "--disallowedTools").split(",");
    expect(blocked).toContain("mcp__claude_ai_Gmail__download_gmail_attachment");
  });
});
