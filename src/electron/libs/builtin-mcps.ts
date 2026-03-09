/**
 * Manages built-in MCP servers bundled with VK-Cowork.
 * On each app startup, ensures these servers are present in:
 *   - ~/.claude/settings.json  (Claude / AI Team runner)
 *   - ~/.codex/config.toml     (Codex runner)
 * Config source: config/builtin-mcp-servers.json (update token there).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { resolveAppAsset } from "../pathResolver.js";

interface BuiltinMcpConfig {
  token: string;
  mcpServers: Record<string, {
    command: string;
    args: string[];
    env: Record<string, string>;
    _description?: string;
  }>;
}

function getBuiltinConfigPath(): string {
  return resolveAppAsset("config", "builtin-mcp-servers.json");
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

function interpolateToken(value: string, token: string): string {
  return value.replace(/\{\{token\}\}/g, token);
}

export function ensureBuiltinMcpServers(): void {
  const configPath = getBuiltinConfigPath();

  if (!existsSync(configPath)) {
    console.warn("[BuiltinMCPs] Config not found:", configPath);
    return;
  }

  let builtinConfig: BuiltinMcpConfig;
  try {
    builtinConfig = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    console.error("[BuiltinMCPs] Failed to parse config:", err);
    return;
  }

  const claudeDir = join(homedir(), ".claude");
  const settingsPath = join(claudeDir, "settings.json");

  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch {
      settings = {};
    }
  }

  if (!settings.mcpServers || typeof settings.mcpServers !== "object") {
    settings.mcpServers = {};
  }
  const mcpServers = settings.mcpServers as Record<string, unknown>;

  let changed = false;
  for (const [name, serverCfg] of Object.entries(builtinConfig.mcpServers)) {
    // Skip internal comment fields
    const existing = mcpServers[name] as { command?: string; args?: string[]; env?: Record<string, string> } | undefined;

    const resolvedArgs = serverCfg.args.map(a => expandHome(a));
    const resolvedEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(serverCfg.env)) {
      resolvedEnv[k] = interpolateToken(v, builtinConfig.token);
    }

    const desired = {
      command: serverCfg.command,
      args: resolvedArgs,
      env: resolvedEnv,
    };

    // Always overwrite to keep token in sync
    const existingJson = JSON.stringify(existing);
    const desiredJson = JSON.stringify(desired);
    if (existingJson !== desiredJson) {
      mcpServers[name] = desired;
      changed = true;
      console.log(`[BuiltinMCPs] ${existing ? "Updated" : "Added"} built-in MCP: ${name}`);
    }
  }

  if (changed) {
    try {
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
      console.log("[BuiltinMCPs] settings.json updated.");
    } catch (err) {
      console.error("[BuiltinMCPs] Failed to write settings.json:", err);
    }
  } else {
    console.log("[BuiltinMCPs] All built-in MCPs are up to date (Claude).");
  }

  ensureCodexMcpServers(builtinConfig);
}

// ── Codex: ~/.codex/config.toml ────────────────────────────────────────────

/**
 * Build a TOML block for a single MCP server entry.
 * Example output:
 *   [mcp_servers.user-opennews]
 *   command = "uv"
 *   args = ["--directory", "/path/to/opennews-mcp", "run", "opennews-mcp"]
 *
 *   [mcp_servers.user-opennews.env]
 *   OPENNEWS_TOKEN = "eyJ..."
 */
function buildTomlMcpBlock(name: string, command: string, args: string[], env: Record<string, string>): string {
  const tomlString = (s: string) => JSON.stringify(s);
  const argsLine = `args = [${args.map(tomlString).join(", ")}]`;
  const envLines = Object.entries(env)
    .map(([k, v]) => `${k} = ${tomlString(v)}`)
    .join("\n");

  return [
    `[mcp_servers.${name}]`,
    `command = ${tomlString(command)}`,
    argsLine,
    "",
    `[mcp_servers.${name}.env]`,
    envLines,
  ].join("\n");
}

/**
 * Returns a regex that matches an existing [mcp_servers.<name>] section
 * and its [mcp_servers.<name>.env] subsection, up to the next top-level section.
 */
function mcpSectionRegex(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match [mcp_servers.name] through [mcp_servers.name.env] until next [section] or EOF
  return new RegExp(
    `\\[mcp_servers\\.${escaped}\\][\\s\\S]*?(?=\\n\\[(?!mcp_servers\\.${escaped})|$)`,
    "g"
  );
}

function ensureCodexMcpServers(builtinConfig: BuiltinMcpConfig): void {
  const codexDir = join(homedir(), ".codex");
  const configPath = join(codexDir, "config.toml");

  if (!existsSync(codexDir)) {
    mkdirSync(codexDir, { recursive: true });
  }

  let toml = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";

  let changed = false;
  for (const [name, serverCfg] of Object.entries(builtinConfig.mcpServers)) {
    const resolvedArgs = serverCfg.args.map(a => expandHome(a));
    const resolvedEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(serverCfg.env)) {
      resolvedEnv[k] = interpolateToken(v, builtinConfig.token);
    }

    const newBlock = buildTomlMcpBlock(name, serverCfg.command, resolvedArgs, resolvedEnv);
    const sectionRe = mcpSectionRegex(name);

    if (sectionRe.test(toml)) {
      // Section exists — replace it only if content differs
      const existing = toml.match(mcpSectionRegex(name))?.[0]?.trim() ?? "";
      if (existing !== newBlock.trim()) {
        toml = toml.replace(mcpSectionRegex(name), newBlock + "\n");
        changed = true;
        console.log(`[BuiltinMCPs/Codex] Updated MCP: ${name}`);
      }
    } else {
      // Append new block
      toml = toml.trimEnd() + (toml.length ? "\n\n" : "") + newBlock + "\n";
      changed = true;
      console.log(`[BuiltinMCPs/Codex] Added MCP: ${name}`);
    }
  }

  if (changed) {
    try {
      writeFileSync(configPath, toml, "utf8");
      console.log("[BuiltinMCPs/Codex] config.toml updated.");
    } catch (err) {
      console.error("[BuiltinMCPs/Codex] Failed to write config.toml:", err);
    }
  } else {
    console.log("[BuiltinMCPs/Codex] All built-in MCPs are up to date (Codex).");
  }
}
