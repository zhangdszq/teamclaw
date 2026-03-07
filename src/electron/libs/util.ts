import { app } from "electron";
import { join } from "path";
import { homedir } from "os";
import { existsSync } from "fs";

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

  const currentPath = process.env.PATH || '';
  const newPath = [...additionalPaths, currentPath].join(pathSeparator);

  return {
    ...process.env,
    PATH: newPath,
  };
}

export const claudeCodePath = getClaudeCodePath();
export const enhancedEnv = getEnhancedEnv();

