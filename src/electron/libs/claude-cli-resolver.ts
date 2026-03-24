import { existsSync, readdirSync } from "fs";
import { homedir } from "os";
import { delimiter, dirname, join } from "path";

type ResolveClaudeCodePathOptions = {
  packaged?: boolean;
  resourcesPath?: string;
  appPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

function unique(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim())))];
}

function listNvmBinDirs(home: string): string[] {
  const baseDir = join(home, ".nvm", "versions", "node");
  if (!existsSync(baseDir)) return [];

  try {
    return readdirSync(baseDir)
      .map((version) => join(baseDir, version, "bin"))
      .filter((binDir) => existsSync(binDir));
  } catch {
    return [];
  }
}

function getDefaultBinDirs(env: NodeJS.ProcessEnv): string[] {
  const home = homedir();
  const pathDirs = (env.PATH || "").split(delimiter).filter(Boolean);

  return unique([
    ...pathDirs,
    "/usr/local/bin",
    "/opt/homebrew/bin",
    join(home, ".bun", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".volta", "bin"),
    join(home, ".fnm", "aliases", "default", "bin"),
    ...listNvmBinDirs(home),
    "/usr/bin",
    "/bin",
  ]);
}

function getCliBundleDirs(options: ResolveClaudeCodePathOptions): string[] {
  const bundleDirs = unique([
    options.packaged && options.resourcesPath ? join(options.resourcesPath, "cli-bundle") : undefined,
    options.appPath ? join(options.appPath, "cli-bundle") : undefined,
    options.cwd ? join(options.cwd, "cli-bundle") : undefined,
    process.cwd() ? join(process.cwd(), "cli-bundle") : undefined,
  ]);

  return bundleDirs.filter((dir) => existsSync(dir));
}

export function getClaudeCliSearchDirs(options: ResolveClaudeCodePathOptions = {}): string[] {
  const env = options.env ?? process.env;
  const configuredPath = env.CLAUDE_CLI_PATH;
  const configuredDir = configuredPath ? dirname(configuredPath) : undefined;

  return unique([
    configuredDir,
    ...getCliBundleDirs(options),
    ...getDefaultBinDirs(env),
  ]);
}

export function resolveClaudeCodePath(options: ResolveClaudeCodePathOptions = {}): string | undefined {
  const env = options.env ?? process.env;

  if (env.CLAUDE_CLI_PATH && existsSync(env.CLAUDE_CLI_PATH)) {
    return env.CLAUDE_CLI_PATH;
  }

  for (const bundleDir of getCliBundleDirs(options)) {
    const bundleCandidates = process.platform === "win32"
      ? [join(bundleDir, "claude.cmd"), join(bundleDir, "claude.exe"), join(bundleDir, "claude.mjs")]
      : [join(bundleDir, "claude.mjs"), join(bundleDir, "claude")];

    for (const candidate of bundleCandidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  if (process.platform === "win32") {
    const npmPath = join(env.APPDATA || "", "npm");
    const claudeJs = join(npmPath, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    if (existsSync(claudeJs)) {
      return claudeJs;
    }
  }

  for (const dir of getDefaultBinDirs(env)) {
    const executableCandidates = process.platform === "win32"
      ? [join(dir, "claude.cmd"), join(dir, "claude.exe"), join(dir, "claude.bat")]
      : [join(dir, "claude")];

    for (const candidate of executableCandidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  if (options.packaged && options.resourcesPath) {
    const sdkFallback = join(
      options.resourcesPath,
      "app.asar.unpacked",
      "node_modules",
      "@anthropic-ai",
      "claude-agent-sdk",
      "cli.js",
    );
    if (existsSync(sdkFallback)) {
      return sdkFallback;
    }
  }

  return undefined;
}
