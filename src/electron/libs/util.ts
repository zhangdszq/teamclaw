import { app } from "electron";
import { join } from "path";
import { homedir, tmpdir } from "os";
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "fs";
import { getClaudeCliSearchDirs, resolveClaudeCodePath } from "./claude-cli-resolver.js";

function getAppPathSafe(): string | undefined {
  try {
    return typeof (app as Partial<typeof app>).getAppPath === "function"
      ? app.getAppPath()
      : undefined;
  } catch {
    return undefined;
  }
}

function isPackagedSafe(): boolean {
  return Boolean((app as Partial<typeof app>).isPackaged);
}

// Get Claude Code CLI path for packaged app
export function getClaudeCodePath(): string | undefined {
  return resolveClaudeCodePath({
    packaged: isPackagedSafe(),
    resourcesPath: process.resourcesPath,
    appPath: getAppPathSafe(),
    cwd: process.cwd(),
    env: process.env,
  });
}

/**
 * On macOS, Claude Code CLI runs `security find-generic-password -a $USER …`
 * which triggers a Keychain dialog when the login keychain is locked/broken.
 * We place a thin wrapper script first in PATH that silently fails for
 * find-generic-password while forwarding everything else to /usr/bin/security.
 */
let _shimDir: string | null = null;
function ensureSecurityShim(): string | null {
  if (process.platform !== "darwin") return null;
  if (_shimDir) return _shimDir;

  const dir = join(tmpdir(), "vk-cowork-shims");
  const shimPath = join(dir, "security");
  const script = `#!/bin/bash
# Skip find-generic-password to avoid Keychain dialog
if [[ "\$1" == "find-generic-password" ]]; then exit 1; fi
exec /usr/bin/security "$@"
`;

  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(shimPath, script, { mode: 0o755 });
    chmodSync(shimPath, 0o755);
    _shimDir = dir;
  } catch {
    return null;
  }
  return dir;
}

// Build enhanced PATH for packaged environment
export function getEnhancedEnv(): Record<string, string | undefined> {
  const isWindows = process.platform === 'win32';
  const pathSeparator = isWindows ? ';' : ':';
  const additionalPaths = getClaudeCliSearchDirs({
    packaged: isPackagedSafe(),
    resourcesPath: process.resourcesPath,
    appPath: getAppPathSafe(),
    cwd: process.cwd(),
    env: process.env,
  });

  // Suppress macOS Keychain dialog from Claude Code CLI
  const shimDir = ensureSecurityShim();
  if (shimDir) additionalPaths.unshift(shimDir);

  const currentPath = process.env.PATH || '';
  const newPath = [...additionalPaths, currentPath].join(pathSeparator);

  return {
    ...process.env,
    PATH: newPath,
  };
}

