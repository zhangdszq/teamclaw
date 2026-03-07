import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join } from "path";

const PROJECT_ROOT = join(__dirname, "..", "..", "..");

function collectSourceFiles(dir: string, exts: string[]): string[] {
  const files: string[] = [];
  if (!existsSync(dir)) return files;

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === "node_modules" || entry === ".git" || entry === "dist-electron" || entry === "dist-react") continue;
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...collectSourceFiles(full, exts));
    } else if (exts.some((ext) => entry.endsWith(ext))) {
      files.push(full);
    }
  }
  return files;
}

describe("No @openai/codex-sdk regression", () => {
  it("codex-runner.ts should not exist", () => {
    expect(existsSync(join(PROJECT_ROOT, "src/electron/libs/codex-runner.ts"))).toBe(false);
  });

  it("package.json should not contain @openai/codex-sdk", () => {
    const pkg = readFileSync(join(PROJECT_ROOT, "package.json"), "utf8");
    expect(pkg).not.toContain("@openai/codex-sdk");
  });

  it("electron-builder.cjs should not reference codex-sdk vendor", () => {
    const config = readFileSync(join(PROJECT_ROOT, "electron-builder.cjs"), "utf8");
    expect(config).not.toContain("@openai/codex-sdk");
  });

  it("no source file imports @openai/codex-sdk", () => {
    const files = collectSourceFiles(join(PROJECT_ROOT, "src"), [".ts", ".tsx", ".cts"]);
    const violations: string[] = [];

    for (const file of files) {
      if (file.includes("__tests__")) continue;
      const content = readFileSync(file, "utf8");
      if (content.includes("from \"@openai/codex-sdk\"") || content.includes("from '@openai/codex-sdk'")) {
        violations.push(file.replace(PROJECT_ROOT + "/", ""));
      }
    }

    expect(violations).toEqual([]);
  });

  it("no source file imports from codex-runner", () => {
    const files = collectSourceFiles(join(PROJECT_ROOT, "src"), [".ts", ".tsx", ".cts"]);
    const violations: string[] = [];

    for (const file of files) {
      if (file.includes("__tests__")) continue;
      const content = readFileSync(file, "utf8");
      if (content.includes("codex-runner")) {
        violations.push(file.replace(PROJECT_ROOT + "/", ""));
      }
    }

    expect(violations).toEqual([]);
  });

  it("no source file calls runCodex directly", () => {
    const files = collectSourceFiles(join(PROJECT_ROOT, "src"), [".ts", ".tsx"]);
    const violations: string[] = [];

    for (const file of files) {
      if (file.includes("__tests__")) continue;
      const content = readFileSync(file, "utf8");
      if (/\brunCodex\b/.test(content)) {
        violations.push(file.replace(PROJECT_ROOT + "/", ""));
      }
    }

    expect(violations).toEqual([]);
  });

  it("openai-auth.ts should not reference codex auth.json sync", () => {
    const authFile = join(PROJECT_ROOT, "src/electron/libs/openai-auth.ts");
    if (!existsSync(authFile)) return;
    const content = readFileSync(authFile, "utf8");
    expect(content).not.toContain("syncTokensToCodexAuth");
    expect(content).not.toContain("removeCodexAuth");
    expect(content).not.toContain("ensureCodexAuthSync");
  });

  it("api/types.ts AgentProvider should not include 'codex'", () => {
    const typesFile = join(PROJECT_ROOT, "src/electron/api/types.ts");
    if (!existsSync(typesFile)) return;
    const content = readFileSync(typesFile, "utf8");
    expect(content).not.toMatch(/['"]codex['"]/);
    expect(content).toContain("'openai'");
  });
});
