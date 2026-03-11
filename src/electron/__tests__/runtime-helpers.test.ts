import { EventEmitter } from "events";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  appPath: "/mock/app",
  userDataPath: "/mock/user-data",
  isPackaged: false,
  existingPaths: new Set<string>(),
  spawnCalls: [] as Array<{ command: string; args: string[]; options: Record<string, unknown> }>,
  autoEmitServerStarting: true,
}));

vi.mock("electron", () => ({
  app: {
    getAppPath: () => mockState.appPath,
    getPath: () => mockState.userDataPath,
    get isPackaged() {
      return mockState.isPackaged;
    },
  },
  ipcMain: {
    handle: vi.fn(),
  },
}));

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    existsSync: vi.fn((targetPath: string) => mockState.existingPaths.has(String(targetPath))),
  };
});

vi.mock("child_process", () => ({
  spawn: vi.fn((command: string, args: string[], options: Record<string, unknown>) => {
    mockState.spawnCalls.push({ command, args, options });

    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = vi.fn(() => {
      proc.emit("exit", 0);
      return true;
    });

    if (mockState.autoEmitServerStarting) {
      queueMicrotask(() => {
        proc.stdout.emit("data", Buffer.from("Server starting"));
      });
    }

    return proc;
  }),
}));

vi.mock("../libs/user-settings.js", () => ({
  loadUserSettings: () => ({
    anthropicAuthToken: "",
    anthropicBaseUrl: "",
    anthropicModel: "",
    proxyEnabled: false,
    proxyUrl: "",
  }),
}));

const ORIGINAL_ENV = { ...process.env };

function setResourcesPath(value: string) {
  Object.defineProperty(process, "resourcesPath", {
    value,
    configurable: true,
    writable: true,
  });
}

function resetMockState() {
  mockState.appPath = "/mock/app";
  mockState.userDataPath = "/mock/user-data";
  mockState.isPackaged = false;
  mockState.existingPaths = new Set<string>();
  mockState.spawnCalls = [];
  mockState.autoEmitServerStarting = true;
  setResourcesPath("/mock/resources");
}

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value;
  }
}

function getMockBinaryPath() {
  const ext = process.platform === "win32" ? ".exe" : "";
  const triple =
    process.platform === "darwin"
      ? process.arch === "arm64"
        ? "aarch64-apple-darwin"
        : "x86_64-apple-darwin"
      : process.platform === "linux"
        ? "x86_64-unknown-linux-gnu"
        : process.platform === "win32"
          ? "x86_64-pc-windows-msvc"
          : "unknown";
  return join("/mock/resources", "sidecar", `agent-api-${triple}${ext}`);
}

async function importFresh<T>(modulePath: string): Promise<T> {
  vi.resetModules();
  return (await import(modulePath)) as T;
}

beforeEach(() => {
  resetMockState();
  restoreEnv();
  delete process.env.NODE_ENV;
  delete process.env.VITE_DEV_SERVER_URL;
  delete process.env.ELECTRON_RENDERER_URL;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  restoreEnv();
});

describe("pathResolver", () => {
  it("prefers the app directory before resources and parent fallback", async () => {
    mockState.existingPaths.add(join("/mock/app", "dist-electron", "electron", "preload.cjs"));
    mockState.existingPaths.add(join("/mock/resources", "dist-electron", "electron", "preload.cjs"));

    const pathResolver = await importFresh<typeof import("../pathResolver.js")>("../pathResolver.js");

    expect(pathResolver.getPreloadPath()).toBe(join("/mock/app", "dist-electron", "electron", "preload.cjs"));
  });

  it("falls back to resources and then parent directory", async () => {
    const pathResolver = await importFresh<typeof import("../pathResolver.js")>("../pathResolver.js");

    mockState.existingPaths.add(join("/mock/resources", "skills-catalog.json"));
    expect(pathResolver.resolveAppAsset("skills-catalog.json")).toBe(join("/mock/resources", "skills-catalog.json"));

    mockState.existingPaths = new Set<string>([join("/mock", "skills-catalog.json")]);
    expect(pathResolver.resolveAppAsset("skills-catalog.json")).toBe(join("/mock", "skills-catalog.json"));
  });

  it("keeps supporting the legacy flat preload path", async () => {
    mockState.existingPaths.add(join("/mock/resources", "dist-electron", "preload.cjs"));

    const pathResolver = await importFresh<typeof import("../pathResolver.js")>("../pathResolver.js");

    expect(pathResolver.getPreloadPath()).toBe(join("/mock/resources", "dist-electron", "preload.cjs"));
  });
});

describe("util runtime helpers", () => {
  it("prefers explicit renderer dev URL over NODE_ENV fallback", async () => {
    process.env.NODE_ENV = "development";
    process.env.VITE_DEV_SERVER_URL = "http://127.0.0.1:4173";

    const util = await importFresh<typeof import("../util.js")>("../util.js");

    expect(util.isDev()).toBe(true);
    expect(util.getRendererDevUrl()).toBe("http://127.0.0.1:4173");
  });

  it("allows renderer IPC from the configured dev server host", async () => {
    process.env.ELECTRON_RENDERER_URL = "http://localhost:5173";

    const util = await importFresh<typeof import("../util.js")>("../util.js");

    expect(() => util.validateEventFrame({ url: "http://localhost:5173/?mode=quick" } as never)).not.toThrow();
  });

  it("accepts the expected file renderer path and rejects unexpected files", async () => {
    mockState.existingPaths.add(join("/mock/app", "dist-react", "index.html"));

    const util = await importFresh<typeof import("../util.js")>("../util.js");

    expect(() => util.validateEventFrame({ url: "file:///mock/app/dist-react/index.html?mode=quick" } as never)).not.toThrow();
    expect(() => util.validateEventFrame({ url: "file:///tmp/evil.html" } as never)).toThrow("Malicious event");
  });
});

describe("sidecar runtime helpers", () => {
  it("detects source bundle availability in unpackaged runtime", async () => {
    mockState.existingPaths.add(join("/mock/app", "src-api", "dist", "bundle.cjs"));

    const sidecar = await importFresh<typeof import("../libs/sidecar.js")>("../libs/sidecar.js");

    expect(sidecar.isSidecarAvailable()).toBe(true);
  });

  it("checks packaged binary availability when app is packaged", async () => {
    mockState.isPackaged = true;
    mockState.existingPaths.add(getMockBinaryPath());

    const sidecar = await importFresh<typeof import("../libs/sidecar.js")>("../libs/sidecar.js");

    expect(sidecar.isSidecarAvailable()).toBe(true);
  });

  it("starts from bundle with CLAUDE_CLI_PATH when unpackaged bundle exists", async () => {
    vi.useFakeTimers();
    const bundlePath = join("/mock/app", "src-api", "dist", "bundle.cjs");
    const cliBundlePath = join("/mock/app", "cli-bundle");
    const cliPath = join(cliBundlePath, "claude.mjs");
    mockState.existingPaths = new Set<string>([bundlePath, cliBundlePath, cliPath]);

    const sidecar = await importFresh<typeof import("../libs/sidecar.js")>("../libs/sidecar.js");
    const startPromise = sidecar.startSidecar();

    await vi.runAllTimersAsync();
    await expect(startPromise).resolves.toBe(true);

    expect(mockState.spawnCalls).toHaveLength(1);
    expect(mockState.spawnCalls[0].command).toBe(process.execPath);
    expect(mockState.spawnCalls[0].args).toEqual([bundlePath]);
    expect((mockState.spawnCalls[0].options.env as Record<string, string>).CLAUDE_CLI_PATH).toBe(cliPath);

    sidecar.stopSidecar();
  });
});
