import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("running an agent", () => {
  it("reports which tools the session really had", async () => {
    process.env.JOBLESSS_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "joblesss-run-")), "run.db");
    process.env.JOBLESSS_CLAUDE_BIN = path.resolve("tests/fake-claude.sh");
    const { runAgent } = await import("./run");
    const run = await runAgent("ask", { prompt: "x" });
    expect(run.status).toBe("ok");
    expect(run.sessionTools).toEqual(["Read", "Glob", "Grep"]);
  }, 30_000);
});
