/**
 * Subprocess pre-warm pool for Claude Code CLI.
 *
 * We cache a few warm subprocesses keyed by the exact spawn fingerprint
 * (command + args + key env vars + cwd). This keeps new-session flows fast
 * and also lets repeated `resume` conversations start hitting a warm process
 * from the next matching turn onward.
 */
import { spawn, type ChildProcess } from "child_process";
import { createHash } from "crypto";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

const MAX_WARM_AGE_MS = 5 * 60_000;
const PRE_WARM_DELAY_MS = 500;
const MAX_WARM_PROCESSES = 3;

interface WarmEntry {
  process: ChildProcess;
  fingerprint: string;
  spawnedAt: number;
}

const warmPool = new Map<string, WarmEntry>();

function buildFingerprint(command: string, args: string[], env: Record<string, string | undefined>, cwd?: string): string {
  const envKeys = [
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
    "ANTHROPIC_MODEL", "CLAUDE_CODE_ENTRYPOINT",
  ];
  const envParts: string[] = [];
  for (const k of envKeys) {
    const v = env[k];
    if (v) envParts.push(`${k}=${v}`);
  }
  return createHash("md5")
    .update(`${command}\0${args.join("\0")}\0${envParts.join("\0")}\0${cwd ?? ""}`)
    .digest("hex");
}

function wrapChildProcess(cp: ChildProcess): SpawnedProcess {
  return {
    stdin: cp.stdin!,
    stdout: cp.stdout!,
    get killed() { return cp.killed; },
    get exitCode() { return cp.exitCode; },
    kill: (signal: NodeJS.Signals) => cp.kill(signal),
    on: cp.on.bind(cp) as SpawnedProcess["on"],
    once: cp.once.bind(cp) as SpawnedProcess["once"],
    off: cp.off.bind(cp) as SpawnedProcess["off"],
  };
}

function deleteWarmEntry(fingerprint: string): void {
  const entry = warmPool.get(fingerprint);
  if (!entry) return;
  try { entry.process.kill("SIGTERM"); } catch { /* already dead */ }
  warmPool.delete(fingerprint);
}

function isExpired(entry: WarmEntry): boolean {
  return entry.process.exitCode !== null || Date.now() - entry.spawnedAt > MAX_WARM_AGE_MS;
}

function pruneWarmPool(): void {
  for (const [fingerprint, entry] of warmPool.entries()) {
    if (isExpired(entry)) {
      deleteWarmEntry(fingerprint);
    }
  }
}

function trimWarmPool(): void {
  pruneWarmPool();
  if (warmPool.size < MAX_WARM_PROCESSES) return;

  const oldest = [...warmPool.entries()]
    .sort((a, b) => a[1].spawnedAt - b[1].spawnedAt)[0];
  if (oldest) deleteWarmEntry(oldest[0]);
}

function cleanEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Spawn (or reuse a warm process) for the given SpawnOptions.
 * Returns a SpawnedProcess compatible with the SDK's ProcessTransport.
 */
export function spawnOrAcquire(opts: SpawnOptions): SpawnedProcess {
  pruneWarmPool();

  const fingerprint = buildFingerprint(opts.command, opts.args, opts.env, opts.cwd);
  const warm = warmPool.get(fingerprint);
  if (warm && !isExpired(warm)) {
    warmPool.delete(fingerprint);
    console.log(`[subprocess-pool] Warm hit (pid=${warm.process.pid})`);
    return wrapChildProcess(warm.process);
  }

  const proc = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "ignore"],
    env: cleanEnv(opts.env),
    signal: opts.signal,
    windowsHide: true,
  });
  return wrapChildProcess(proc);
}

/**
 * Pre-warm a process for future use. Call after a query completes.
 * Uses the exact spawn template so matching `resume` turns can also hit.
 */
export function schedulePreWarm(opts: SpawnOptions): void {
  const timer = setTimeout(() => {
    pruneWarmPool();
    const fingerprint = buildFingerprint(opts.command, opts.args, opts.env, opts.cwd);
    const existing = warmPool.get(fingerprint);
    if (existing && !isExpired(existing)) return;

    trimWarmPool();

    try {
      const proc = spawn(opts.command, opts.args, {
        cwd: opts.cwd,
        stdio: ["pipe", "pipe", "ignore"],
        env: cleanEnv(opts.env),
        windowsHide: true,
      });

      const clear = () => {
        const current = warmPool.get(fingerprint);
        if (current?.process === proc) {
          warmPool.delete(fingerprint);
        }
      };
      proc.on("error", clear);
      proc.on("exit", clear);

      warmPool.set(fingerprint, { process: proc, fingerprint, spawnedAt: Date.now() });
      console.log(`[subprocess-pool] Pre-warmed (pid=${proc.pid}) pool=${warmPool.size}`);
    } catch (err) {
      console.warn("[subprocess-pool] Pre-warm failed:", err);
    }
  }, PRE_WARM_DELAY_MS);
  timer.unref?.();
}

export function cleanupPool(): void {
  for (const fingerprint of [...warmPool.keys()]) {
    deleteWarmEntry(fingerprint);
  }
}
