/**
 * Sidecar process manager for the API server
 */
import { spawn, type ChildProcess } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';
import { app } from 'electron';
import { isUnpackagedRuntime } from '../util.js';

let sidecarProcess: ChildProcess | null = null;
let apiPort = 2620;

// Get target triple for current platform
function getTargetTriple(): string {
  const platform = process.platform;
  const arch = process.arch;
  
  if (platform === 'darwin') {
    return arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  } else if (platform === 'linux') {
    return 'x86_64-unknown-linux-gnu';
  } else if (platform === 'win32') {
    return 'x86_64-pc-windows-msvc';
  }
  return 'unknown';
}

// Get the path to the API sidecar binary
function getSidecarPath(): string {
  const targetTriple = getTargetTriple();
  const ext = process.platform === 'win32' ? '.exe' : '';
  const binaryName = `agent-api-${targetTriple}${ext}`;
  
  if (app.isPackaged) {
    // In packaged app, sidecar is in resources
    return join(process.resourcesPath, 'sidecar', binaryName);
  } else {
    // In development, check if binary exists, otherwise return empty
    const binaryPath = join(app.getAppPath(), 'src-api', 'dist', binaryName);
    return binaryPath;
  }
}

// Check if we should run sidecar from source in dev mode
function shouldRunFromSource(): boolean {
  if (!isUnpackagedRuntime()) return false;
  
  // Check if bundle.cjs exists
  const bundlePath = join(app.getAppPath(), 'src-api', 'dist', 'bundle.cjs');
  return existsSync(bundlePath);
}

// Get the bundle path for dev mode
function getBundlePath(): string {
  return join(app.getAppPath(), 'src-api', 'dist', 'bundle.cjs');
}

// Get the path to bundled CLI
function getCliBundlePath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'cli-bundle');
  } else {
    return join(app.getAppPath(), 'cli-bundle');
  }
}

// Check if sidecar is available
export function isSidecarAvailable(): boolean {
  // In dev mode, check for bundle.cjs
  if (shouldRunFromSource()) {
    return existsSync(getBundlePath());
  }
  // Otherwise check for binary
  const sidecarPath = getSidecarPath();
  return existsSync(sidecarPath);
}

// Start the sidecar process
export async function startSidecar(): Promise<boolean> {
  if (sidecarProcess) {
    console.log('Sidecar already running');
    return true;
  }

  // In dev mode, prefer running from bundle.cjs with node
  const runFromSource = shouldRunFromSource();
  let command: string;
  let args: string[];
  
  if (runFromSource) {
    const bundlePath = getBundlePath();
    console.log(`Starting sidecar from bundle: ${bundlePath}`);
    command = process.execPath; // Use electron's node
    args = [bundlePath];
  } else {
    const sidecarPath = getSidecarPath();
    if (!existsSync(sidecarPath)) {
      console.warn(`Sidecar not found at ${sidecarPath}`);
      return false;
    }
    console.log(`Starting sidecar binary: ${sidecarPath}`);
    command = sidecarPath;
    args = [];
  }

  // Prepare environment
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    PORT: String(apiPort),
    DATA_DIR: join(app.getPath('userData')),
  };

  // Add CLI bundle path if available
  const cliBundlePath = getCliBundlePath();
  if (existsSync(cliBundlePath)) {
    // Use .mjs file so SDK will use node to execute it (works on all platforms)
    const cliPath = join(cliBundlePath, 'claude.mjs');
    if (existsSync(cliPath)) {
      env.CLAUDE_CLI_PATH = cliPath;
      // Add cli-bundle to PATH so node.exe can be found
      const pathSeparator = process.platform === 'win32' ? ';' : ':';
      env.PATH = cliBundlePath + pathSeparator + (env.PATH || '');
    }
  }

  // Load user settings for API config and proxy
  try {
    const { loadUserSettings } = await import('./user-settings.js');
    const settings = loadUserSettings();
    
    if (settings.anthropicAuthToken) {
      env.ANTHROPIC_API_KEY = settings.anthropicAuthToken;
    }
    if (settings.anthropicBaseUrl) {
      env.ANTHROPIC_BASE_URL = settings.anthropicBaseUrl;
    }
    if (settings.anthropicModel) {
      env.ANTHROPIC_MODEL = settings.anthropicModel;
    }
    // Proxy settings
    if (settings.proxyEnabled && settings.proxyUrl) {
      env.PROXY_URL = settings.proxyUrl;
      env.HTTP_PROXY = settings.proxyUrl;
      env.HTTPS_PROXY = settings.proxyUrl;
      env.ALL_PROXY = settings.proxyUrl;
      env.http_proxy = settings.proxyUrl;
      env.https_proxy = settings.proxyUrl;
      env.all_proxy = settings.proxyUrl;
    }
  } catch (error) {
    console.error('Failed to load user settings:', error);
  }

  return new Promise((resolve) => {
    sidecarProcess = spawn(command, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let started = false;

    sidecarProcess.stdout?.on('data', (data) => {
      const output = data.toString();
      console.log('[Sidecar]', output);
      
      if (!started && output.includes('Server starting')) {
        started = true;
        // Wait a bit for the server to be ready
        setTimeout(() => resolve(true), 500);
      }
    });

    sidecarProcess.stderr?.on('data', (data) => {
      console.error('[Sidecar Error]', data.toString());
    });

    sidecarProcess.on('error', (error) => {
      console.error('Failed to start sidecar:', error);
      sidecarProcess = null;
      resolve(false);
    });

    sidecarProcess.on('exit', (code) => {
      console.log(`Sidecar exited with code ${code}`);
      sidecarProcess = null;
    });

    // Timeout if server doesn't start
    setTimeout(() => {
      if (!started) {
        console.warn('Sidecar startup timeout, assuming it started');
        resolve(true);
      }
    }, 5000);
  });
}

// Stop the sidecar process
export function stopSidecar(): void {
  if (sidecarProcess) {
    console.log('Stopping sidecar...');
    sidecarProcess.kill('SIGTERM');
    sidecarProcess = null;
  }
}

// Get the API base URL
export function getApiBaseUrl(): string {
  return `http://localhost:${apiPort}`;
}

// Check if sidecar is running
export function isSidecarRunning(): boolean {
  return sidecarProcess !== null;
}

// Restart sidecar
export async function restartSidecar(): Promise<boolean> {
  stopSidecar();
  await new Promise(resolve => setTimeout(resolve, 1000));
  return startSidecar();
}
