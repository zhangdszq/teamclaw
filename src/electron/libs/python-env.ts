import { spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import os from "os";
import { join } from "path";

const PYTHON_ENV_DIR = join(os.homedir(), ".vk-cowork", ".python-env");
const INSTALLED_PACKAGES_FILE = join(PYTHON_ENV_DIR, "installed.json");

const BREW_CN_MIRROR_ENV = {
  HOMEBREW_BREW_GIT_REMOTE: "https://mirrors.ustc.edu.cn/brew.git",
  HOMEBREW_CORE_GIT_REMOTE: "https://mirrors.ustc.edu.cn/homebrew-core.git",
  HOMEBREW_BOTTLE_DOMAIN: "https://mirrors.ustc.edu.cn/homebrew-bottles",
  HOMEBREW_API_DOMAIN: "https://mirrors.ustc.edu.cn/homebrew-bottles/api",
};

const PIP_CN_MIRROR = "https://pypi.tuna.tsinghua.edu.cn/simple";
const PIP_CN_HOST = "pypi.tuna.tsinghua.edu.cn";

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type CommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs?: number;
};

type ManagedPythonInfo = {
  path: string | null;
  version: string | null;
  packages: string[];
};

let cachedPythonPath: string | null = null;
let ensurePythonEnvPromise: Promise<string | null> | null = null;
const ensurePackagesPromises = new Map<string, Promise<boolean>>();

function getVenvPythonPath(): string {
  return process.platform === "win32"
    ? join(PYTHON_ENV_DIR, "Scripts", "python.exe")
    : join(PYTHON_ENV_DIR, "bin", "python3");
}

function ensureParentDir(): void {
  mkdirSync(join(os.homedir(), ".vk-cowork"), { recursive: true });
}

function normalizeRequirementName(requirement: string): string {
  const match = requirement.trim().match(/^[A-Za-z0-9._-]+/);
  return (match?.[0] ?? requirement.trim()).toLowerCase();
}

function readInstalledPackages(): string[] {
  if (!existsSync(INSTALLED_PACKAGES_FILE)) return [];
  try {
    const raw = JSON.parse(readFileSync(INSTALLED_PACKAGES_FILE, "utf8")) as { packages?: string[] } | string[];
    const packages = Array.isArray(raw) ? raw : (raw.packages ?? []);
    return [...new Set(packages.map((pkg) => String(pkg).toLowerCase()).filter(Boolean))].sort();
  } catch {
    return [];
  }
}

function writeInstalledPackages(packages: Iterable<string>): void {
  const normalized = [...new Set([...packages].map((pkg) => String(pkg).toLowerCase()).filter(Boolean))].sort();
  writeFileSync(INSTALLED_PACKAGES_FILE, `${JSON.stringify({ packages: normalized }, null, 2)}\n`, "utf8");
}

function getExistingPythonPath(): string | null {
  if (cachedPythonPath && existsSync(cachedPythonPath)) return cachedPythonPath;
  const candidate = getVenvPythonPath();
  if (existsSync(candidate)) {
    cachedPythonPath = candidate;
    return candidate;
  }
  return null;
}

async function runCommand(
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  return await new Promise((resolve) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    const timer = options.timeoutMs
      ? setTimeout(() => {
          proc.kill();
          finish({
            exitCode: -1,
            stdout,
            stderr: `${stderr}${stderr ? "\n" : ""}Command timed out after ${options.timeoutMs}ms`,
          });
        }, options.timeoutMs)
      : null;

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      finish({
        exitCode: -1,
        stdout,
        stderr: `${stderr}${stderr ? "\n" : ""}${err.message}`,
      });
    });

    proc.on("close", (code) => {
      finish({ exitCode: code ?? -1, stdout, stderr });
    });

    if (options.stdin !== undefined) {
      proc.stdin?.end(options.stdin);
    } else {
      proc.stdin?.end();
    }
  });
}

async function commandExists(command: string): Promise<boolean> {
  const result = await runCommand(command, ["--version"], { timeoutMs: 15_000 });
  return result.exitCode === 0;
}

async function findSystemPython(): Promise<string | null> {
  const candidates = process.platform === "win32" ? ["python", "python3"] : ["python3", "python"];
  for (const candidate of candidates) {
    if (await commandExists(candidate)) return candidate;
  }
  return null;
}

async function installPythonOnMac(): Promise<boolean> {
  if (!(await commandExists("brew"))) return false;

  const baseArgs = ["install", "python"];
  const primary = await runCommand("brew", baseArgs, { timeoutMs: 20 * 60_000 });
  if (primary.exitCode === 0) return true;

  const mirrorRetry = await runCommand("brew", baseArgs, {
    env: { ...process.env, ...BREW_CN_MIRROR_ENV },
    timeoutMs: 20 * 60_000,
  });
  return mirrorRetry.exitCode === 0;
}

async function installPythonOnWindows(): Promise<boolean> {
  if (!(await commandExists("winget"))) return false;

  const commonArgs = ["install", "python3", "--accept-package-agreements", "--accept-source-agreements"];
  const primary = await runCommand("winget", commonArgs, { timeoutMs: 20 * 60_000 });
  if (primary.exitCode === 0) return true;

  const fallback = await runCommand(
    "winget",
    ["install", "python", "--accept-package-agreements", "--accept-source-agreements"],
    { timeoutMs: 20 * 60_000 },
  );
  return fallback.exitCode === 0;
}

async function installSystemPython(): Promise<boolean> {
  if (process.platform === "darwin") return await installPythonOnMac();
  if (process.platform === "win32") return await installPythonOnWindows();
  return false;
}

async function internalEnsurePythonEnv(): Promise<string | null> {
  ensureParentDir();

  const existing = getExistingPythonPath();
  if (existing) return existing;

  let systemPython = await findSystemPython();
  if (!systemPython) {
    const installed = await installSystemPython();
    if (!installed) return null;
    systemPython = await findSystemPython();
    if (!systemPython) return null;
  }

  const createResult = await runCommand(systemPython, ["-m", "venv", PYTHON_ENV_DIR], {
    timeoutMs: 5 * 60_000,
  });
  if (createResult.exitCode !== 0) return null;

  const pythonPath = getExistingPythonPath();
  if (!pythonPath) return null;

  cachedPythonPath = pythonPath;

  await runCommand(
    pythonPath,
    ["-m", "pip", "install", "--upgrade", "pip"],
    { timeoutMs: 10 * 60_000 },
  );

  return pythonPath;
}

export async function ensurePythonEnv(): Promise<string | null> {
  const existing = getExistingPythonPath();
  if (existing) return existing;

  if (!ensurePythonEnvPromise) {
    ensurePythonEnvPromise = internalEnsurePythonEnv().finally(() => {
      ensurePythonEnvPromise = null;
    });
  }

  return await ensurePythonEnvPromise;
}

export async function ensurePyPackages(requirements: string[]): Promise<boolean> {
  const normalizedNames = [...new Set(requirements.map(normalizeRequirementName).filter(Boolean))].sort();
  if (normalizedNames.length === 0) return (await ensurePythonEnv()) !== null;

  const promiseKey = normalizedNames.join(",");
  const existingPromise = ensurePackagesPromises.get(promiseKey);
  if (existingPromise) return await existingPromise;

  const installPromise = (async () => {
    const pythonPath = await ensurePythonEnv();
    if (!pythonPath) return false;

    const installed = new Set(readInstalledPackages());
    const missingRequirements = requirements.filter((requirement) => {
      return !installed.has(normalizeRequirementName(requirement));
    });
    if (missingRequirements.length === 0) return true;

    let result = await runCommand(
      pythonPath,
      ["-m", "pip", "install", ...missingRequirements],
      { timeoutMs: 10 * 60_000 },
    );

    if (result.exitCode !== 0) {
      result = await runCommand(
        pythonPath,
        [
          "-m",
          "pip",
          "install",
          "-i",
          PIP_CN_MIRROR,
          "--trusted-host",
          PIP_CN_HOST,
          ...missingRequirements,
        ],
        { timeoutMs: 10 * 60_000 },
      );
    }

    if (result.exitCode !== 0) return false;

    missingRequirements.forEach((requirement) => {
      installed.add(normalizeRequirementName(requirement));
    });
    writeInstalledPackages(installed);
    return true;
  })().finally(() => {
    ensurePackagesPromises.delete(promiseKey);
  });

  ensurePackagesPromises.set(promiseKey, installPromise);
  return await installPromise;
}

export function getPythonPath(): string | null {
  return getExistingPythonPath();
}

export function getPythonEnvDir(): string {
  return PYTHON_ENV_DIR;
}

export function getInstalledPackages(): string[] {
  return readInstalledPackages();
}

export async function getManagedPythonInfo(): Promise<ManagedPythonInfo> {
  const pythonPath = getExistingPythonPath();
  const packages = readInstalledPackages();
  if (!pythonPath) {
    return {
      path: null,
      version: null,
      packages,
    };
  }

  const versionResult = await runCommand(pythonPath, ["--version"], { timeoutMs: 15_000 });
  const versionText = `${versionResult.stdout}\n${versionResult.stderr}`.trim();
  return {
    path: pythonPath,
    version: versionResult.exitCode === 0 ? versionText : null,
    packages,
  };
}
