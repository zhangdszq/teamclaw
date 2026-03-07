import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { HookRunner } from "../modules/hook-runner.js";
import type { HookTaskCreateInput } from "../core/types.js";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/fake-electron" },
}));

let tmpDir: string;
let storePath: string;

function makeRunner(onExecute = vi.fn()) {
  return new HookRunner({ storePath, onExecute });
}

function hookInput(overrides: Partial<HookTaskCreateInput> = {}): HookTaskCreateInput {
  return {
    name: "Startup Hook",
    enabled: true,
    prompt: "check things",
    hookEvent: "startup",
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-runner-test-"));
  storePath = path.join(tmpDir, "tasks.json");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("HookRunner.add", () => {
  it("creates a hook task", async () => {
    const r = makeRunner();
    const hook = await r.add(hookInput());
    expect(hook.id).toMatch(/^hook_/);
    expect(hook.hookEvent).toBe("startup");
  });
});

describe("HookRunner.runHooks", () => {
  it("calls onExecute for matching event", async () => {
    const exec = vi.fn();
    const r = makeRunner(exec);
    await r.add(hookInput({ hookEvent: "startup" }));
    r.runHooks("startup");
    // Wait for async dispatch
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exec).toHaveBeenCalledOnce();
  });

  it("does not fire for non-matching event", async () => {
    const exec = vi.fn();
    const r = makeRunner(exec);
    await r.add(hookInput({ hookEvent: "startup" }));
    r.runHooks("session.complete");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exec).not.toHaveBeenCalled();
  });

  it("filters by assistantId", async () => {
    const exec = vi.fn();
    const r = makeRunner(exec);
    await r.add(hookInput({ hookFilter: { assistantId: "asst-1" } }));
    r.runHooks("startup", { assistantId: "asst-2" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exec).not.toHaveBeenCalled();

    r.runHooks("startup", { assistantId: "asst-1" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exec).toHaveBeenCalledOnce();
  });

  it("filters by onlyOnError", async () => {
    const exec = vi.fn();
    const r = makeRunner(exec);
    await r.add(
      hookInput({
        hookEvent: "session.complete",
        hookFilter: { onlyOnError: true },
      }),
    );
    r.runHooks("session.complete", { status: "idle" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exec).not.toHaveBeenCalled();

    r.runHooks("session.complete", { status: "error" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exec).toHaveBeenCalledOnce();
  });

  it("skips disabled hooks", async () => {
    const exec = vi.fn();
    const r = makeRunner(exec);
    await r.add(hookInput({ enabled: false }));
    r.runHooks("startup");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exec).not.toHaveBeenCalled();
  });

  it("runs multiple matching hooks", async () => {
    const exec = vi.fn();
    const r = makeRunner(exec);
    await r.add(hookInput({ name: "Hook 1" }));
    await r.add(hookInput({ name: "Hook 2" }));
    r.runHooks("startup");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exec).toHaveBeenCalledTimes(2);
  });
});

describe("HookRunner.delete", () => {
  it("removes the hook", async () => {
    const r = makeRunner();
    const hook = await r.add(hookInput());
    await r.delete(hook.id);
    expect(await r.list()).toHaveLength(0);
  });

  it("returns false for non-existent id", async () => {
    const r = makeRunner();
    expect(await r.delete("no-such")).toBe(false);
  });
});
