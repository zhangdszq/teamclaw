import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SpawnPlan = {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
  onSpawn?: () => void;
};

const mockState = vi.hoisted(() => ({
  homeDir: "",
  calls: [] as Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }>,
  responder: ((_command: string, _args: string[], _options: { env?: NodeJS.ProcessEnv }) => ({
    exitCode: 0,
  })) as (command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => SpawnPlan,
}));

vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os");
  return {
    ...actual,
    homedir: () => mockState.homeDir,
    default: {
      ...actual,
      homedir: () => mockState.homeDir,
    },
  };
});

vi.mock("child_process", () => ({
  spawn: vi.fn((command: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}) => {
    mockState.calls.push({ command, args, env: options.env });
    const plan = mockState.responder(command, args, options);

    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { end: ReturnType<typeof vi.fn> };
      kill: ReturnType<typeof vi.fn>;
    };

    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { end: vi.fn() };
    proc.kill = vi.fn(() => {
      proc.emit("close", 0);
      return true;
    });

    queueMicrotask(() => {
      plan.onSpawn?.();
      if (plan.stdout) proc.stdout.emit("data", Buffer.from(plan.stdout));
      if (plan.stderr) proc.stderr.emit("data", Buffer.from(plan.stderr));
      if (plan.error) {
        proc.emit("error", new Error(plan.error));
      } else {
        proc.emit("close", plan.exitCode ?? 0);
      }
    });

    return proc;
  }),
}));

async function importFreshPythonEnv() {
  vi.resetModules();
  return await import("../libs/python-env.js");
}

function fakeVenvPythonPath(homeDir: string): string {
  return process.platform === "win32"
    ? join(homeDir, ".vk-cowork", ".python-env", "Scripts", "python.exe")
    : join(homeDir, ".vk-cowork", ".python-env", "bin", "python3");
}

function materializeFakePython(homeDir: string): string {
  const pythonPath = fakeVenvPythonPath(homeDir);
  mkdirSync(dirname(pythonPath), { recursive: true });
  writeFileSync(pythonPath, "", "utf8");
  return pythonPath;
}

describe("python-env", () => {
  beforeEach(() => {
    mockState.homeDir = mkdtempSync(join(tmpdir(), "vk-python-env-test-"));
    mockState.calls = [];
    mockState.responder = () => ({ exitCode: 0 });
  });

  afterEach(() => {
    rmSync(mockState.homeDir, { recursive: true, force: true });
  });

  it("returns null when python is missing and auto-install is unavailable", async () => {
    mockState.responder = (command, args) => {
      const key = `${command} ${args.join(" ")}`;
      if (key === "python3 --version") return { error: "ENOENT" };
      if (key === "python --version") return { error: "ENOENT" };
      if (process.platform === "darwin" && key === "brew --version") return { error: "ENOENT" };
      if (process.platform === "win32" && key === "winget --version") return { error: "ENOENT" };
      return { error: "unexpected call" };
    };

    const pythonEnv = await importFreshPythonEnv();
    await expect(pythonEnv.ensurePythonEnv()).resolves.toBeNull();
  });

  it.runIf(process.platform === "darwin")(
    "retries python installation with a China mirror when the first brew install fails",
    async () => {
      let installFinished = false;

      mockState.responder = (command, args, options) => {
        const key = `${command} ${args.join(" ")}`;
        if (key === "python3 --version") {
          return installFinished ? { exitCode: 0, stdout: "Python 3.13.1\n" } : { error: "ENOENT" };
        }
        if (key === "python --version") return { error: "ENOENT" };
        if (key === "brew --version") return { exitCode: 0, stdout: "Homebrew 4.6.6\n" };
        if (key === "brew install python") {
          const hasMirror = options.env?.HOMEBREW_API_DOMAIN === "https://mirrors.ustc.edu.cn/homebrew-bottles/api";
          if (!hasMirror) return { exitCode: 1, stderr: "network failed" };
          return {
            exitCode: 0,
            onSpawn: () => {
              installFinished = true;
            },
          };
        }
        if (args[0] === "-m" && args[1] === "venv") {
          return {
            exitCode: 0,
            onSpawn: () => {
              materializeFakePython(mockState.homeDir);
            },
          };
        }
        if (args[0] === "-m" && args[1] === "pip" && args[2] === "install" && args[3] === "--upgrade") {
          return { exitCode: 0 };
        }
        return { error: `unexpected call: ${key}` };
      };

      const pythonEnv = await importFreshPythonEnv();
      const pythonPath = await pythonEnv.ensurePythonEnv();

      expect(pythonPath).toBe(fakeVenvPythonPath(mockState.homeDir));
      expect(
        mockState.calls.some(
          (call) =>
            call.command === "brew" &&
            call.args.join(" ") === "install python" &&
            call.env?.HOMEBREW_API_DOMAIN === "https://mirrors.ustc.edu.cn/homebrew-bottles/api",
        ),
      ).toBe(true);
    },
  );

  it("retries pip install with the Tsinghua mirror after the primary install fails", async () => {
    const pythonPath = materializeFakePython(mockState.homeDir);
    let firstPipInstall = true;

    mockState.responder = (command, args, _options) => {
      const key = `${command} ${args.join(" ")}`;
      if (key.endsWith("-m pip install demo-pkg")) {
        if (firstPipInstall) {
          firstPipInstall = false;
          return { exitCode: 1, stderr: "timeout" };
        }
        return { error: "primary pip install should only run once" };
      }
      if (
        args[0] === "-m" &&
        args[1] === "pip" &&
        args[2] === "install" &&
        args.includes("https://pypi.tuna.tsinghua.edu.cn/simple") &&
        args.includes("demo-pkg")
      ) {
        return { exitCode: 0 };
      }
      return { error: `unexpected call: ${key}` };
    };

    const pythonEnv = await importFreshPythonEnv();
    await expect(pythonEnv.ensurePyPackages(["demo-pkg"])).resolves.toBe(true);
    expect(pythonEnv.getPythonPath()).toBe(pythonPath);
    expect(
      mockState.calls.some(
        (call) =>
          call.command === pythonPath &&
          call.args.includes("https://pypi.tuna.tsinghua.edu.cn/simple") &&
          call.args.includes("--trusted-host"),
      ),
    ).toBe(true);

    const installedJson = JSON.parse(
      readFileSync(join(mockState.homeDir, ".vk-cowork", ".python-env", "installed.json"), "utf8"),
    ) as { packages: string[] };
    expect(installedJson.packages).toContain("demo-pkg");
  });
});
