import {
  spawn,
  type ChildProcess,
  type ChildProcessByStdio,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type AuthMethod,
  type ContentBlock,
  type ContentChunk,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type KillTerminalRequest,
  type KillTerminalResponse,
  type PromptResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type ReleaseTerminalRequest,
  type ReleaseTerminalResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type ToolCall,
  type ToolCallContent,
  type ToolCallUpdate,
  type WaitForTerminalExitRequest,
  type WaitForTerminalExitResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from "@agentclientprotocol/sdk";

const DEFAULT_AGENT_COMMAND = "cursor agent acp";
const FALLBACK_AGENT_COMMAND = "cursor-agent acp";
const DEFAULT_TERMINAL_OUTPUT_LIMIT_BYTES = 64 * 1024;
const DEFAULT_INIT_TIMEOUT_MS = 20_000;
const DEFAULT_SESSION_CREATE_TIMEOUT_MS = 60_000;
const DEFAULT_PROMPT_TIMEOUT_MS = 15 * 60_000;
const REPLAY_IDLE_MS = 80;
const REPLAY_DRAIN_TIMEOUT_MS = 5_000;
const DRAIN_POLL_INTERVAL_MS = 20;
const AGENT_CLOSE_AFTER_STDIN_END_MS = 100;
const AGENT_CLOSE_TERM_GRACE_MS = 1_500;
const AGENT_CLOSE_KILL_GRACE_MS = 1_000;
const TERMINAL_KILL_GRACE_MS = 1_500;
const MAX_PREVIEW_LINES = 16;
const MAX_PREVIEW_CHARS = 1_200;
const MAX_TOOL_RESULT_CHARS = 20_000;

type AgentDisconnectReason =
  | "process_exit"
  | "process_close"
  | "pipe_close"
  | "connection_close";

type AgentProcess = ChildProcessByStdio<Writable, Readable, Readable>;
type TerminalProcess = ChildProcessByStdio<null, Readable, Readable>;

type AgentExitInfo = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  exitedAt: string;
  reason: AgentDisconnectReason;
  unexpectedDuringPrompt: boolean;
};

type ManagedTerminal = {
  process: TerminalProcess;
  output: Buffer;
  truncated: boolean;
  outputByteLimit: number;
  exitCode: number | null | undefined;
  signal: NodeJS.Signals | null | undefined;
  exitPromise: Promise<WaitForTerminalExitResponse>;
  resolveExit: (response: WaitForTerminalExitResponse) => void;
};

type ToolCallSnapshot = {
  title: string;
  status?: string;
  kind?: string;
  locations: string[];
  content: string[];
  rawInput?: string;
  rawOutput?: string;
};

type PromptCollector = {
  assistantText: string;
  thoughtText: string;
  lastAssistantMessageId: string | null;
  lastThoughtMessageId: string | null;
  planEntries: string[];
  toolCalls: Map<string, ToolCallSnapshot>;
};

type CommandParts = {
  command: string;
  args: string[];
};

function isoNow(): string {
  return new Date().toISOString();
}

function debugLog(...args: unknown[]): void {
  if (process.env.VK_COWORK_ACP_DEBUG !== "1") return;
  console.log("[acp-bridge]", ...args);
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}

function isCursorExtensionMethod(method: string): boolean {
  return typeof method === "string" && method.startsWith("_cursor/");
}

function getBridgeEnv(): NodeJS.ProcessEnv {
  const home = homedir();
  const isWindows = process.platform === "win32";
  const pathSeparator = isWindows ? ";" : ":";
  const additionalPaths = isWindows
    ? [
        `${home}\\AppData\\Roaming\\npm`,
        `${home}\\.bun\\bin`,
        `${home}\\.volta\\bin`,
      ]
    : [
        "/usr/local/bin",
        "/opt/homebrew/bin",
        `${home}/.local/bin`,
        `${home}/.bun/bin`,
        `${home}/.nvm/versions/node/v20.0.0/bin`,
        `${home}/.nvm/versions/node/v22.0.0/bin`,
        `${home}/.nvm/versions/node/v18.0.0/bin`,
        `${home}/.volta/bin`,
        `${home}/.fnm/aliases/default/bin`,
        "/usr/bin",
        "/bin",
      ];

  if (typeof process.resourcesPath === "string" && process.resourcesPath) {
    const cliBundlePath = join(process.resourcesPath, "cli-bundle");
    if (existsSync(cliBundlePath)) {
      additionalPaths.unshift(cliBundlePath);
    }
  }

  return {
    ...process.env,
    PATH: [...additionalPaths, process.env.PATH || ""].join(pathSeparator),
  };
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, Math.max(0, ms));
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, rejectPromise) => {
        timer = setTimeout(() => rejectPromise(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function truncateText(value: string, limit = MAX_TOOL_RESULT_CHARS): string {
  if (value.length <= limit) return value;
  const head = Math.max(0, Math.floor(limit * 0.6));
  const tail = Math.max(0, limit - head - 18);
  return `${value.slice(0, head)}\n...[truncated]...\n${value.slice(-tail)}`;
}

function splitCommandLine(value: string): CommandParts {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const ch of value) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (escaping) current += "\\";
  if (quote) throw new Error("Invalid ACP agent command: unterminated quote");
  if (current.length > 0) parts.push(current);
  if (parts.length === 0) throw new Error("Invalid ACP agent command: empty command");

  return {
    command: parts[0],
    args: parts.slice(1),
  };
}

function readWindowsEnvValue(
  env: NodeJS.ProcessEnv,
  key: string,
): string | undefined {
  const matchedKey = Object.keys(env).find((entry) => entry.toUpperCase() === key);
  return matchedKey ? env[matchedKey] : undefined;
}

function resolveWindowsCommand(
  command: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const extensions = (readWindowsEnvValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const commandExtension = extname(command);
  const candidates =
    commandExtension.length > 0
      ? [command]
      : extensions.map((extension) => `${command}${extension}`);
  const hasPath = command.includes("/") || command.includes("\\");

  if (hasPath) {
    return candidates.find((candidate) => existsSync(candidate));
  }

  const pathValue = readWindowsEnvValue(env, "PATH");
  if (!pathValue) return undefined;
  for (const directory of pathValue.split(";")) {
    const trimmedDirectory = directory.trim();
    if (!trimmedDirectory) continue;
    for (const candidate of candidates) {
      const resolvedCandidate = resolve(trimmedDirectory, candidate);
      if (existsSync(resolvedCandidate)) return resolvedCandidate;
    }
  }
  return undefined;
}

function shouldUseWindowsBatchShell(
  command: string,
  env: NodeJS.ProcessEnv,
): boolean {
  if (process.platform !== "win32") return false;
  const resolvedCommand = resolveWindowsCommand(command, env) ?? command;
  const extension = extname(resolvedCommand).toLowerCase();
  return extension === ".cmd" || extension === ".bat";
}

function buildSpawnCommandOptions(
  command: string,
  options: Parameters<typeof spawn>[2],
  env: NodeJS.ProcessEnv,
): Parameters<typeof spawn>[2] {
  if (!shouldUseWindowsBatchShell(command, env)) {
    return options;
  }
  return {
    ...options,
    shell: true,
  };
}

function requireAgentStdio(child: ChildProcess): AgentProcess {
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("ACP agent must be spawned with piped stdin/stdout/stderr");
  }
  return child as AgentProcess;
}

function requireTerminalStdio(child: ChildProcess): TerminalProcess {
  if (!child.stdout || !child.stderr) {
    throw new Error("Terminal process must be spawned with piped stdout/stderr");
  }
  return child as TerminalProcess;
}

function isChildProcessRunning(child: ChildProcess | undefined | null): child is ChildProcess {
  if (!child) return false;
  return child.exitCode == null && child.signalCode == null && !child.killed;
}

function isWithinRoot(rootDir: string, targetPath: string): boolean {
  const relativePath = relative(rootDir, targetPath);
  return (
    relativePath.length === 0 ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

function resolvePathWithinRoot(rootDir: string, rawPath: string): string {
  if (!isAbsolute(rawPath)) {
    throw new Error(`Path must be absolute: ${rawPath}`);
  }
  const resolvedPath = resolve(rawPath);
  if (!isWithinRoot(rootDir, resolvedPath)) {
    throw new Error(`Path is outside allowed cwd subtree: ${resolvedPath}`);
  }
  return resolvedPath;
}

function sliceContent(
  content: string,
  line: number | null | undefined,
  limit: number | null | undefined,
): string {
  if (line == null && limit == null) {
    return content;
  }
  const lines = content.split("\n");
  const startLine = line == null ? 1 : Math.max(1, Math.trunc(line));
  const startIndex = Math.max(0, startLine - 1);
  const maxLines = limit == null ? undefined : Math.max(0, Math.trunc(limit));
  if (maxLines === 0) return "";
  const endIndex =
    maxLines == null
      ? lines.length
      : Math.min(lines.length, startIndex + maxLines);
  return lines.slice(startIndex, endIndex).join("\n");
}

function trimToUtf8Boundary(buffer: Buffer, limit: number): Buffer {
  if (limit <= 0) return Buffer.alloc(0);
  if (buffer.length <= limit) return buffer;
  let start = buffer.length - limit;
  while (start < buffer.length && (buffer[start] & 0b1100_0000) === 0b1000_0000) {
    start += 1;
  }
  if (start >= buffer.length) {
    start = buffer.length - limit;
  }
  return buffer.subarray(start);
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const onSpawn = () => {
      child.off("error", onError);
      resolvePromise();
    };
    const onError = (error: Error) => {
      child.off("spawn", onSpawn);
      rejectPromise(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function waitForChildExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (!isChildProcessRunning(child)) {
    return Promise.resolve(true);
  }
  return new Promise((resolvePromise) => {
    let settled = false;
    const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      child.off("close", onExitLike);
      child.off("exit", onExitLike);
      clearTimeout(timer);
      resolvePromise(value);
    };
    const onExitLike = () => finish(true);
    child.once("close", onExitLike);
    child.once("exit", onExitLike);
  });
}

function toEnvToken(value: string): string | undefined {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return normalized.length > 0 ? normalized : undefined;
}

function selectAuthMethod(methods: AuthMethod[]): string | undefined {
  const forcedMethodId = process.env.VK_COWORK_ACP_AUTH_METHOD?.trim();
  if (forcedMethodId) {
    return methods.some((method) => method.id === forcedMethodId)
      ? forcedMethodId
      : undefined;
  }

  for (const method of methods) {
    if (!("type" in method)) continue;
    const normalized = toEnvToken(method.id);
    if (!normalized) continue;
    if (process.env[`ACPX_AUTH_${normalized}`] || process.env[normalized]) {
      return method.id;
    }
  }
  return undefined;
}

function pickPermissionResponse(
  request: RequestPermissionRequest,
): RequestPermissionResponse {
  const allowOption =
    request.options.find((option) => option.kind === "allow_always") ??
    request.options.find((option) => option.kind === "allow_once");
  if (!allowOption) {
    return {
      outcome: {
        outcome: "cancelled",
      },
    };
  }
  return {
    outcome: {
      outcome: "selected",
      optionId: allowOption.optionId,
    },
  };
}

function renderContentBlock(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "resource_link":
      return block.title ?? block.name ?? block.uri;
    case "resource": {
      const resource = block.resource;
      if (
        resource &&
        typeof resource === "object" &&
        "text" in resource &&
        typeof resource.text === "string"
      ) {
        return resource.text;
      }
      return "[resource]";
    }
    case "image":
      return "[image]";
    case "audio":
      return "[audio]";
    default:
      return `[${String((block as { type?: unknown }).type ?? "content")}]`;
  }
}

function renderToolCallContent(content: ToolCallContent): string {
  if (content.type === "content") {
    return renderContentBlock(content.content);
  }
  if (content.type === "diff") {
    const path = content.path || "(unknown path)";
    const oldText = content.oldText ?? "";
    const newText = content.newText ?? "";
    return [
      `diff: ${path}`,
      oldText ? `old=${truncateText(oldText, 500)}` : "old=<new file>",
      `new=${truncateText(newText, 500)}`,
    ].join("\n");
  }
  if (content.type === "terminal") {
    return `terminalId=${content.terminalId}`;
  }
  return "[tool content]";
}

function toPreview(value: unknown): string | undefined {
  if (value == null) return undefined;
  const raw = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!raw) return undefined;
  const normalized = raw.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const previewLines = lines.slice(0, MAX_PREVIEW_LINES).join("\n");
  return truncateText(previewLines, MAX_PREVIEW_CHARS);
}

function createEmptyCollector(): PromptCollector {
  return {
    assistantText: "",
    thoughtText: "",
    lastAssistantMessageId: null,
    lastThoughtMessageId: null,
    planEntries: [],
    toolCalls: new Map(),
  };
}

function mergeToolCall(
  toolCalls: Map<string, ToolCallSnapshot>,
  toolCallId: string,
  patch: Partial<ToolCallSnapshot>,
): void {
  const existing = toolCalls.get(toolCallId) ?? {
    title: toolCallId,
    locations: [],
    content: [],
  };
  const next: ToolCallSnapshot = {
    ...existing,
    ...patch,
    title: patch.title ?? existing.title,
    locations: patch.locations ?? existing.locations,
    content: patch.content ?? existing.content,
  };
  toolCalls.set(toolCallId, next);
}

function renderCollector(
  collector: PromptCollector,
  response: PromptResponse,
): string {
  const sections: string[] = [];

  if (collector.assistantText.trim()) {
    sections.push(`Assistant output:\n${truncateText(collector.assistantText.trim())}`);
  }

  if (collector.thoughtText.trim()) {
    sections.push(`Thoughts:\n${truncateText(collector.thoughtText.trim(), 6_000)}`);
  }

  if (collector.planEntries.length > 0) {
    sections.push(`Plan:\n${collector.planEntries.map((entry) => `- ${entry}`).join("\n")}`);
  }

  if (collector.toolCalls.size > 0) {
    const toolLines = Array.from(collector.toolCalls.values()).map((toolCall) => {
      const meta = [
        toolCall.status ? `status=${toolCall.status}` : "",
        toolCall.kind ? `kind=${toolCall.kind}` : "",
      ].filter(Boolean).join(", ");
      const details: string[] = [];
      if (toolCall.locations.length > 0) {
        details.push(`files=${toolCall.locations.join(", ")}`);
      }
      if (toolCall.content.length > 0) {
        details.push(truncateText(toolCall.content.join("\n"), 4_000));
      } else if (toolCall.rawOutput) {
        details.push(`output=${toolCall.rawOutput}`);
      }
      return [
        `- ${toolCall.title}${meta ? ` (${meta})` : ""}`,
        ...details.map((line) => `  ${line.replace(/\n/g, "\n  ")}`),
      ].join("\n");
    });
    sections.push(`Tool activity:\n${toolLines.join("\n")}`);
  }

  sections.push(`Stop reason: ${response.stopReason}`);

  return truncateText(sections.join("\n\n"));
}

function isRecoverablePromptError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("session not found") ||
    normalized.includes("connection closed") ||
    normalized.includes("query closed") ||
    normalized.includes("broken pipe") ||
    normalized.includes("socket hang up") ||
    normalized.includes("transport closed")
  );
}

function buildPromptBlocks(task: string): Array<ContentBlock> {
  return [{ type: "text", text: task }];
}

class CursorFileSystemHandlers {
  constructor(private readonly rootDir: string) {}

  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    const filePath = resolvePathWithinRoot(this.rootDir, params.path);
    const content = await readFile(filePath, "utf8");
    return {
      content: sliceContent(content, params.line, params.limit),
    };
  }

  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    const filePath = resolvePathWithinRoot(this.rootDir, params.path);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, params.content, "utf8");
    return {};
  }
}

class CursorTerminalManager {
  private readonly terminals = new Map<string, ManagedTerminal>();

  constructor(private readonly rootDir: string) {}

  async createTerminal(
    params: CreateTerminalRequest,
  ): Promise<CreateTerminalResponse> {
    const cwd = params.cwd ? resolvePathWithinRoot(this.rootDir, params.cwd) : this.rootDir;
    const env = this.toEnvObject(params.env);
    const proc = spawn(
      params.command,
      params.args ?? [],
      buildSpawnCommandOptions(
        params.command,
        {
          cwd,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
        env ?? process.env,
      ),
    );

    await waitForSpawn(proc);
    const terminal = requireTerminalStdio(proc);

    let resolveExit: (response: WaitForTerminalExitResponse) => void = () => {};
    const exitPromise = new Promise<WaitForTerminalExitResponse>((resolvePromise) => {
      resolveExit = resolvePromise;
    });

    const managedTerminal: ManagedTerminal = {
      process: terminal,
      output: Buffer.alloc(0),
      truncated: false,
      outputByteLimit: Math.max(
        0,
        Math.round(params.outputByteLimit ?? DEFAULT_TERMINAL_OUTPUT_LIMIT_BYTES),
      ),
      exitCode: undefined,
      signal: undefined,
      exitPromise,
      resolveExit,
    };

    const appendOutput = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes.length === 0) return;
      managedTerminal.output = Buffer.concat([managedTerminal.output, bytes]);
      if (managedTerminal.output.length > managedTerminal.outputByteLimit) {
        managedTerminal.output = trimToUtf8Boundary(
          managedTerminal.output,
          managedTerminal.outputByteLimit,
        );
        managedTerminal.truncated = true;
      }
    };

    terminal.stdout.on("data", appendOutput);
    terminal.stderr.on("data", appendOutput);
    terminal.once("exit", (exitCode, signal) => {
      managedTerminal.exitCode = exitCode;
      managedTerminal.signal = signal;
      managedTerminal.resolveExit({
        exitCode: exitCode ?? null,
        signal: signal ?? null,
      });
    });

    const terminalId = randomUUID();
    this.terminals.set(terminalId, managedTerminal);
    return { terminalId };
  }

  async terminalOutput(
    params: TerminalOutputRequest,
  ): Promise<TerminalOutputResponse> {
    const terminal = this.getTerminal(params.terminalId);
    const hasExitStatus =
      terminal.exitCode !== undefined || terminal.signal !== undefined;

    return {
      output: terminal.output.toString("utf8"),
      truncated: terminal.truncated,
      exitStatus: hasExitStatus
        ? {
            exitCode: terminal.exitCode ?? null,
            signal: terminal.signal ?? null,
          }
        : undefined,
    };
  }

  async waitForTerminalExit(
    params: WaitForTerminalExitRequest,
  ): Promise<WaitForTerminalExitResponse> {
    const terminal = this.getTerminal(params.terminalId);
    return await terminal.exitPromise;
  }

  async killTerminal(
    params: KillTerminalRequest,
  ): Promise<KillTerminalResponse> {
    const terminal = this.getTerminal(params.terminalId);
    await this.killProcess(terminal);
    return {};
  }

  async releaseTerminal(
    params: ReleaseTerminalRequest,
  ): Promise<ReleaseTerminalResponse> {
    const terminal = this.getTerminal(params.terminalId);
    await this.killProcess(terminal);
    await terminal.exitPromise.catch(() => undefined);
    terminal.output = Buffer.alloc(0);
    this.terminals.delete(params.terminalId);
    return {};
  }

  async shutdown(): Promise<void> {
    for (const terminalId of Array.from(this.terminals.keys())) {
      await this.releaseTerminal({ terminalId, sessionId: "shutdown" }).catch(() => undefined);
    }
  }

  private getTerminal(terminalId: string): ManagedTerminal {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      throw new Error(`Unknown terminal: ${terminalId}`);
    }
    return terminal;
  }

  private async killProcess(terminal: ManagedTerminal): Promise<void> {
    if (terminal.exitCode !== undefined || terminal.signal !== undefined) {
      return;
    }

    try {
      terminal.process.kill("SIGTERM");
    } catch {
      return;
    }

    const exitedAfterTerm = await Promise.race([
      terminal.exitPromise.then(() => true),
      waitMs(TERMINAL_KILL_GRACE_MS).then(() => false),
    ]);
    if (exitedAfterTerm || terminal.exitCode !== undefined || terminal.signal !== undefined) {
      return;
    }

    try {
      terminal.process.kill("SIGKILL");
    } catch {
      return;
    }
    await Promise.race([
      terminal.exitPromise.then(() => undefined),
      waitMs(TERMINAL_KILL_GRACE_MS),
    ]);
  }

  private toEnvObject(
    env: CreateTerminalRequest["env"],
  ): NodeJS.ProcessEnv | undefined {
    if (!env || env.length === 0) {
      return getBridgeEnv();
    }
    const merged: NodeJS.ProcessEnv = { ...getBridgeEnv() };
    for (const entry of env) {
      merged[entry.name] = entry.value;
    }
    return merged;
  }
}

class CursorAcpBridge {
  private readonly rootDir: string;
  private readonly filesystem: CursorFileSystemHandlers;
  private readonly terminalManager: CursorTerminalManager;
  private readonly agentCommandCandidates: string[];
  private resolvedAgentCommand?: string;
  private connection?: ClientSideConnection;
  private agent?: AgentProcess;
  private sessionId?: string;
  private sessionUpdateChain: Promise<void> = Promise.resolve();
  private observedSessionUpdates = 0;
  private processedSessionUpdates = 0;
  private activePrompt?: { sessionId: string; promise: Promise<PromptResponse> };
  private readonly cancellingSessionIds = new Set<string>();
  private closing = false;
  private agentStartedAt?: string;
  private lastAgentExit?: AgentExitInfo;
  private lastKnownPid?: number;
  private currentCollector?: PromptCollector;
  private promptQueue: Promise<unknown> = Promise.resolve();

  constructor(cwd: string, agentCommand = DEFAULT_AGENT_COMMAND) {
    this.rootDir = resolve(cwd);
    this.filesystem = new CursorFileSystemHandlers(this.rootDir);
    this.terminalManager = new CursorTerminalManager(this.rootDir);
    this.agentCommandCandidates = Array.from(
      new Set(
        [
          process.env.VK_COWORK_CURSOR_AGENT_COMMAND,
          process.env.CURSOR_AGENT_COMMAND,
          agentCommand,
          FALLBACK_AGENT_COMMAND,
        ].filter((value): value is string => Boolean(value?.trim())),
      ),
    );
  }

  enqueuePrompt(task: string): Promise<string> {
    const run = async () => await this.promptInternal(task);
    const queued = this.promptQueue.then(run, run);
    this.promptQueue = queued.catch(() => undefined);
    return queued;
  }

  async cancel(): Promise<boolean> {
    const active = this.activePrompt;
    if (!active || !this.connection) return false;
    this.cancellingSessionIds.add(active.sessionId);
    await this.connection.cancel({ sessionId: active.sessionId });
    return true;
  }

  async dispose(): Promise<void> {
    this.closing = true;
    await this.terminalManager.shutdown();

    const agent = this.agent;
    this.connection = undefined;
    this.sessionId = undefined;
    this.activePrompt = undefined;
    this.currentCollector = undefined;

    if (agent) {
      await this.terminateAgentProcess(agent);
    }

    this.agent = undefined;
    this.sessionUpdateChain = Promise.resolve();
    this.observedSessionUpdates = 0;
    this.processedSessionUpdates = 0;
    this.cancellingSessionIds.clear();
  }

  private async promptInternal(task: string): Promise<string> {
    try {
      await this.ensureConnected();
      return await this.runPrompt(task);
    } catch (error) {
      debugLog("promptInternal error", error);
      if (!isRecoverablePromptError(error)) {
        throw error;
      }
      await this.dispose();
      this.closing = false;
      await this.ensureConnected();
      return await this.runPrompt(task);
    }
  }

  private async ensureConnected(): Promise<void> {
    if (
      this.connection &&
      this.agent &&
      isChildProcessRunning(this.agent) &&
      this.sessionId
    ) {
      return;
    }

    if (this.connection || this.agent) {
      await this.dispose();
      this.closing = false;
    }

    const commandsToTry = this.resolvedAgentCommand
      ? [this.resolvedAgentCommand]
      : this.agentCommandCandidates;
    const errors: string[] = [];

    for (const candidate of commandsToTry) {
      try {
        debugLog("trying agent command", candidate);
        await this.startAgent(candidate);
        this.resolvedAgentCommand = candidate;
        debugLog("agent command ready", candidate);
        return;
      } catch (error) {
        debugLog("agent command failed", candidate, error);
        errors.push(`${candidate}: ${describeError(error)}`);
      }
    }

    throw new Error(
      `Failed to start Cursor ACP agent. Tried commands:\n${errors.map((entry) => `- ${entry}`).join("\n")}`,
    );
  }

  private async startAgent(commandLine: string): Promise<void> {
    const { command, args } = splitCommandLine(commandLine);
    const env = getBridgeEnv();
    debugLog("spawning agent", { command, args, cwd: this.rootDir });
    const spawnedChild = spawn(
      command,
      args,
      buildSpawnCommandOptions(
        command,
        {
          cwd: this.rootDir,
          env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
        env,
      ),
    );

    try {
      await waitForSpawn(spawnedChild);
    } catch (error) {
      throw new Error(
        `spawn failed: ${describeError(error)}`,
      );
    }

    const child = requireAgentStdio(spawnedChild);
    this.closing = false;
    this.agentStartedAt = isoNow();
    this.lastAgentExit = undefined;
    this.lastKnownPid = child.pid ?? undefined;
    debugLog("agent spawned", { pid: child.pid, commandLine });
    this.attachAgentLifecycleObservers(child);

    const input = Writable.toWeb(child.stdin);
    const output = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(input, output);

    const connection = new ClientSideConnection(
      () => ({
        sessionUpdate: async (params: SessionNotification) => {
          await this.handleSessionUpdate(params);
        },
        requestPermission: async (params: RequestPermissionRequest) => {
          return this.handlePermissionRequest(params);
        },
        readTextFile: async (params: ReadTextFileRequest) => {
          return await this.filesystem.readTextFile(params);
        },
        writeTextFile: async (params: WriteTextFileRequest) => {
          return await this.filesystem.writeTextFile(params);
        },
        createTerminal: async (params: CreateTerminalRequest) => {
          return await this.terminalManager.createTerminal(params);
        },
        terminalOutput: async (params: TerminalOutputRequest) => {
          return await this.terminalManager.terminalOutput(params);
        },
        waitForTerminalExit: async (params: WaitForTerminalExitRequest) => {
          return await this.terminalManager.waitForTerminalExit(params);
        },
        killTerminal: async (params: KillTerminalRequest) => {
          return await this.terminalManager.killTerminal(params);
        },
        releaseTerminal: async (params: ReleaseTerminalRequest) => {
          return await this.terminalManager.releaseTerminal(params);
        },
        extMethod: async (method: string, params: Record<string, unknown>) => {
          if (isCursorExtensionMethod(method)) {
            debugLog("ignoring cursor extension method", method, params);
            return {};
          }
          throw new Error(`Unsupported ACP extension method: ${method}`);
        },
        extNotification: async (method: string, params: Record<string, unknown>) => {
          if (isCursorExtensionMethod(method)) {
            debugLog("ignoring cursor extension notification", method, params);
            return;
          }
          throw new Error(`Unsupported ACP extension notification: ${method}`);
        },
      }),
      stream,
    );

    connection.signal.addEventListener(
      "abort",
      () => {
        this.recordAgentExit(
          "connection_close",
          child.exitCode ?? null,
          child.signalCode ?? null,
        );
      },
      { once: true },
    );

    try {
      const initResult = await withTimeout(
        connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            fs: {
              readTextFile: true,
              writeTextFile: true,
            },
            terminal: true,
          },
          clientInfo: {
            name: "vk-cowork",
            version: "0.0.0",
          },
        }),
        DEFAULT_INIT_TIMEOUT_MS,
        `Timed out waiting for Cursor ACP initialize after ${DEFAULT_INIT_TIMEOUT_MS}ms`,
      );
      debugLog("agent initialized", {
        authMethods: initResult.authMethods?.map((method: AuthMethod) => method.id) ?? [],
      });

      const authMethodId = selectAuthMethod(initResult.authMethods ?? []);
      if (authMethodId) {
        debugLog("authenticating agent", authMethodId);
        await connection.authenticate({ methodId: authMethodId });
      } else if ((initResult.authMethods ?? []).length > 0) {
        debugLog("skipping auto auth; no noninteractive credentials found");
      }

      const sessionResult = await withTimeout(
        connection.newSession({
          cwd: this.rootDir,
          mcpServers: [],
        }),
        DEFAULT_SESSION_CREATE_TIMEOUT_MS,
        `Timed out waiting for Cursor ACP session creation after ${DEFAULT_SESSION_CREATE_TIMEOUT_MS}ms`,
      );
      debugLog("session created", sessionResult.sessionId);

      this.connection = connection;
      this.agent = child;
      this.sessionId = sessionResult.sessionId;
    } catch (error) {
      child.kill();
      throw error;
    }
  }

  private async runPrompt(task: string): Promise<string> {
    if (!this.connection || !this.sessionId) {
      throw new Error("Cursor ACP bridge is not connected");
    }

    const collector = createEmptyCollector();
    this.currentCollector = collector;
    debugLog("sending prompt", { sessionId: this.sessionId, cwd: this.rootDir });

    const promptPromise = withTimeout(
      this.connection.prompt({
        sessionId: this.sessionId,
        messageId: randomUUID(),
        prompt: buildPromptBlocks(task),
      }),
      DEFAULT_PROMPT_TIMEOUT_MS,
      `Cursor ACP prompt timed out after ${DEFAULT_PROMPT_TIMEOUT_MS}ms`,
    );

    this.activePrompt = {
      sessionId: this.sessionId,
      promise: promptPromise,
    };

    try {
      const response = await promptPromise;
      debugLog("prompt completed", response.stopReason);
      await this.waitForSessionUpdateDrain(REPLAY_IDLE_MS, REPLAY_DRAIN_TIMEOUT_MS);
      return renderCollector(collector, response);
    } finally {
      this.activePrompt = undefined;
      this.currentCollector = undefined;
      if (this.sessionId) {
        this.cancellingSessionIds.delete(this.sessionId);
      }
    }
  }

  private appendChunk(
    target: "assistant" | "thought",
    chunk: ContentChunk,
  ): void {
    if (!this.currentCollector) return;
    const rendered = renderContentBlock(chunk.content);
    if (!rendered) return;

    if (target === "assistant") {
      if (
        this.currentCollector.assistantText &&
        chunk.messageId &&
        this.currentCollector.lastAssistantMessageId &&
        this.currentCollector.lastAssistantMessageId !== chunk.messageId
      ) {
        this.currentCollector.assistantText += "\n\n";
      }
      this.currentCollector.assistantText += rendered;
      this.currentCollector.lastAssistantMessageId = chunk.messageId ?? null;
      return;
    }

    if (
      this.currentCollector.thoughtText &&
      chunk.messageId &&
      this.currentCollector.lastThoughtMessageId &&
      this.currentCollector.lastThoughtMessageId !== chunk.messageId
    ) {
      this.currentCollector.thoughtText += "\n\n";
    }
    this.currentCollector.thoughtText += rendered;
    this.currentCollector.lastThoughtMessageId = chunk.messageId ?? null;
  }

  private recordToolCall(toolCall: ToolCall): void {
    if (!this.currentCollector) return;
    mergeToolCall(this.currentCollector.toolCalls, toolCall.toolCallId, {
      title: toolCall.title,
      status: toolCall.status,
      kind: toolCall.kind,
      locations: (toolCall.locations ?? []).map((location) => location.path),
      content: (toolCall.content ?? []).map(renderToolCallContent),
      rawInput: toPreview(toolCall.rawInput),
      rawOutput: toPreview(toolCall.rawOutput),
    });
  }

  private recordToolCallUpdate(toolCall: ToolCallUpdate): void {
    if (!this.currentCollector) return;
    mergeToolCall(this.currentCollector.toolCalls, toolCall.toolCallId, {
      title: toolCall.title ?? undefined,
      status: toolCall.status ?? undefined,
      kind: toolCall.kind ?? undefined,
      locations: toolCall.locations
        ? toolCall.locations.map((location) => location.path)
        : undefined,
      content: toolCall.content
        ? toolCall.content.map(renderToolCallContent)
        : undefined,
      rawInput: toolCall.rawInput === undefined
        ? undefined
        : toPreview(toolCall.rawInput),
      rawOutput: toolCall.rawOutput === undefined
        ? undefined
        : toPreview(toolCall.rawOutput),
    });
  }

  private async handleSessionUpdate(
    notification: SessionNotification,
  ): Promise<void> {
    const sequence = ++this.observedSessionUpdates;
    debugLog("session update", sequence, notification.update.sessionUpdate);
    this.sessionUpdateChain = this.sessionUpdateChain.then(async () => {
      try {
        const update = notification.update;
        switch (update.sessionUpdate) {
          case "agent_message_chunk":
            this.appendChunk("assistant", update);
            break;
          case "agent_thought_chunk":
            this.appendChunk("thought", update);
            break;
          case "tool_call":
            this.recordToolCall(update);
            break;
          case "tool_call_update":
            this.recordToolCallUpdate(update);
            break;
          case "plan":
            if (this.currentCollector) {
              this.currentCollector.planEntries = update.entries.map((entry) => {
                return `[${entry.status}/${entry.priority}] ${entry.content}`;
              });
            }
            break;
          default:
            break;
        }
      } finally {
        this.processedSessionUpdates = sequence;
      }
    });

    await this.sessionUpdateChain;
  }

  private async waitForSessionUpdateDrain(
    idleMs: number,
    timeoutMs: number,
  ): Promise<void> {
    const normalizedIdleMs = Math.max(0, idleMs);
    const normalizedTimeoutMs = Math.max(normalizedIdleMs, timeoutMs);
    const deadline = Date.now() + normalizedTimeoutMs;
    let lastObserved = this.observedSessionUpdates;
    let idleSince = Date.now();

    while (Date.now() <= deadline) {
      const observed = this.observedSessionUpdates;
      if (observed !== lastObserved) {
        lastObserved = observed;
        idleSince = Date.now();
      }

      if (
        this.processedSessionUpdates === this.observedSessionUpdates &&
        Date.now() - idleSince >= normalizedIdleMs
      ) {
        await this.sessionUpdateChain;
        if (this.processedSessionUpdates === this.observedSessionUpdates) {
          return;
        }
      }

      await waitMs(DRAIN_POLL_INTERVAL_MS);
    }

    throw new Error(
      `Timed out waiting for session update drain after ${normalizedTimeoutMs}ms`,
    );
  }

  private handlePermissionRequest(
    params: RequestPermissionRequest,
  ): RequestPermissionResponse {
    if (this.cancellingSessionIds.has(params.sessionId)) {
      return {
        outcome: {
          outcome: "cancelled",
        },
      };
    }
    return pickPermissionResponse(params);
  }

  private attachAgentLifecycleObservers(child: AgentProcess): void {
    child.once("exit", (exitCode, signal) => {
      this.recordAgentExit("process_exit", exitCode, signal);
    });
    child.once("close", (exitCode, signal) => {
      this.recordAgentExit("process_close", exitCode, signal);
    });
    child.stdout.once("close", () => {
      this.recordAgentExit(
        "pipe_close",
        child.exitCode ?? null,
        child.signalCode ?? null,
      );
    });
  }

  private recordAgentExit(
    reason: AgentDisconnectReason,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.lastAgentExit) {
      return;
    }
    this.lastAgentExit = {
      exitCode,
      signal,
      exitedAt: isoNow(),
      reason,
      unexpectedDuringPrompt: !this.closing && Boolean(this.activePrompt),
    };
  }

  private async terminateAgentProcess(child: AgentProcess): Promise<void> {
    if (!child.stdin.destroyed) {
      try {
        child.stdin.end();
      } catch {
        // best effort
      }
    }

    let exited = await waitForChildExit(child, AGENT_CLOSE_AFTER_STDIN_END_MS);
    if (!exited && isChildProcessRunning(child)) {
      try {
        child.kill("SIGTERM");
      } catch {
        // best effort
      }
      exited = await waitForChildExit(child, AGENT_CLOSE_TERM_GRACE_MS);
    }

    if (!exited && isChildProcessRunning(child)) {
      try {
        child.kill("SIGKILL");
      } catch {
        // best effort
      }
      exited = await waitForChildExit(child, AGENT_CLOSE_KILL_GRACE_MS);
    }

    this.detachAgentHandles(child, !exited);
  }

  private detachAgentHandles(agent: AgentProcess, unref: boolean): void {
    agent.stdin.destroy();
    agent.stdout.destroy();
    agent.stderr.destroy();
    if (unref) {
      try {
        agent.unref();
      } catch {
        // best effort
      }
    }
  }
}

const bridgeRegistry = new Map<string, CursorAcpBridge>();

function getBridge(cwd: string): CursorAcpBridge {
  const rootDir = resolve(cwd);
  let bridge = bridgeRegistry.get(rootDir);
  if (!bridge) {
    bridge = new CursorAcpBridge(rootDir);
    bridgeRegistry.set(rootDir, bridge);
  }
  return bridge;
}

export async function delegateToCursor(
  prompt: string,
  cwd: string,
): Promise<string> {
  const normalizedPrompt = String(prompt ?? "").trim();
  if (!normalizedPrompt) {
    throw new Error("delegateToCursor requires a non-empty prompt");
  }
  const rootDir = resolve(cwd);
  return await getBridge(rootDir).enqueuePrompt(normalizedPrompt);
}

export async function disposeCursorAgent(): Promise<void> {
  const bridges = Array.from(bridgeRegistry.values());
  bridgeRegistry.clear();
  await Promise.all(bridges.map((bridge) => bridge.dispose().catch(() => undefined)));
}
