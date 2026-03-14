import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

vi.mock("electron", () => ({
  app: {
    getPath: () => "/tmp/mock-user-data",
  },
}));

import {
  getAssistantOutputDir,
  prepareVisibleArtifact,
  sanitizeArtifactPathSegment,
} from "../bot-base.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "vk-artifact-output-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("artifact output helpers", () => {
  it("sanitizes assistant names for output directories", () => {
    expect(sanitizeArtifactPathSegment(" 小欣 / 小助理 ")).toBe("小欣_小助理");
    expect(sanitizeArtifactPathSegment("???")).toBe("");
  });

  it("builds output dir under defaultCwd", () => {
    const cwd = makeTempDir();
    expect(getAssistantOutputDir({
      defaultCwd: cwd,
      assistantName: "小欣 / 小助理",
      assistantId: "assistant-1",
    })).toBe(join(cwd, "outputs", "小欣_小助理"));
  });

  it("copies visible artifacts into outputs directory", () => {
    const cwd = makeTempDir();
    const sourceDir = makeTempDir();
    const sourcePath = join(sourceDir, "clip.mp4");
    writeFileSync(sourcePath, "video-data", "utf8");

    const prepared = prepareVisibleArtifact(sourcePath, {
      defaultCwd: cwd,
      assistantName: "小欣",
      assistantId: "assistant-1",
    });

    expect(prepared.error).toBeUndefined();
    expect(prepared.filePath).toBe(join(cwd, "outputs", "小欣", "clip.mp4"));
    expect(readFileSync(prepared.filePath, "utf8")).toBe("video-data");
    expect(readFileSync(sourcePath, "utf8")).toBe("video-data");
  });

  it("deduplicates artifact names when outputs already contain the file", () => {
    const cwd = makeTempDir();
    const outputDir = join(cwd, "outputs", "小欣");
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, "clip.mp4"), "old", "utf8");

    const sourceDir = makeTempDir();
    const sourcePath = join(sourceDir, "clip.mp4");
    writeFileSync(sourcePath, "new", "utf8");

    const prepared = prepareVisibleArtifact(sourcePath, {
      defaultCwd: cwd,
      assistantName: "小欣",
    });

    expect(prepared.error).toBeUndefined();
    expect(prepared.filePath).toBe(join(outputDir, "clip-2.mp4"));
    expect(readFileSync(prepared.filePath, "utf8")).toBe("new");
  });

  it("keeps the original path when already inside outputs", () => {
    const cwd = makeTempDir();
    const outputDir = join(cwd, "outputs", "小欣");
    mkdirSync(outputDir, { recursive: true });
    const sourcePath = join(outputDir, "shot.png");
    writeFileSync(sourcePath, "image", "utf8");

    const prepared = prepareVisibleArtifact(sourcePath, {
      defaultCwd: cwd,
      assistantName: "小欣",
    });

    expect(prepared.error).toBeUndefined();
    expect(prepared.filePath).toBe(sourcePath);
    expect(prepared.archivedPath).toBeUndefined();
  });

  it("falls back to the original path when defaultCwd is missing", () => {
    const sourceDir = makeTempDir();
    const sourcePath = join(sourceDir, "note.txt");
    writeFileSync(sourcePath, "hello", "utf8");

    const prepared = prepareVisibleArtifact(sourcePath, {
      assistantName: "小欣",
    });

    expect(prepared.error).toBeUndefined();
    expect(prepared.filePath).toBe(sourcePath);
  });
});
