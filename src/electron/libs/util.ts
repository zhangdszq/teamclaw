import { app } from "electron";
import { join } from "path";
import { homedir, tmpdir } from "os";
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "fs";

// Get Claude Code CLI path for packaged app
export function getClaudeCodePath(): string | undefined {
  if (app.isPackaged) {
    // Use claude.mjs from cli-bundle for SDK compatibility
    const cliBundlePath = join(process.resourcesPath, 'cli-bundle', 'claude.mjs');
    if (existsSync(cliBundlePath)) {
      return cliBundlePath;
    }
    // Fallback to unpacked SDK
    return join(
      process.resourcesPath,
      'app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk/cli.js'
    );
  }
  return undefined;
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
  const home = homedir();
  const isWindows = process.platform === 'win32';
  const pathSeparator = isWindows ? ';' : ':';
  
  const additionalPaths = isWindows ? [
    `${home}\\AppData\\Roaming\\npm`,
    `${home}\\.bun\\bin`,
    `${home}\\.volta\\bin`,
  ] : [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    `${home}/.bun/bin`,
    `${home}/.nvm/versions/node/v20.0.0/bin`,
    `${home}/.nvm/versions/node/v22.0.0/bin`,
    `${home}/.nvm/versions/node/v18.0.0/bin`,
    `${home}/.volta/bin`,
    `${home}/.fnm/aliases/default/bin`,
    '/usr/bin',
    '/bin',
  ];

  // Add cli-bundle to PATH if packaged
  if (app.isPackaged) {
    const cliBundlePath = join(process.resourcesPath, 'cli-bundle');
    if (existsSync(cliBundlePath)) {
      additionalPaths.unshift(cliBundlePath);
    }
  }

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

export const claudeCodePath = getClaudeCodePath();
export const enhancedEnv = getEnhancedEnv();

