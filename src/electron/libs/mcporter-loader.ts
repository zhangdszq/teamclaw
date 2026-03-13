/**
 * Reads config/mcporter.json and converts each server entry into
 * McpServerConfig objects the Claude Agent SDK can consume directly.
 *
 * mcporter.json format (managed by `mcporter config add`):
 *   { "mcpServers": { "name": { "baseUrl": "https://..." } } }
 *
 * Each entry becomes McpHttpServerConfig { type: "http", url }.
 * Results are cached; call invalidateMcporterCache() when the file changes.
 */
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, existsSync } from "fs";
import { resolveAppAsset } from "../pathResolver.js";

interface McporterEntry {
  baseUrl: string;
  headers?: Record<string, string>;
}

interface McporterConfig {
  mcpServers?: Record<string, McporterEntry>;
}

let _cached: Record<string, McpServerConfig> | null = null;

function getMcporterConfigPath(): string {
  return resolveAppAsset("config", "mcporter.json");
}

export function loadMcporterServers(): Record<string, McpServerConfig> {
  if (_cached) return _cached;

  const configPath = getMcporterConfigPath();
  if (!existsSync(configPath)) {
    _cached = {};
    return _cached;
  }

  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as McporterConfig;
    const result: Record<string, McpServerConfig> = {};
    for (const [name, entry] of Object.entries(raw.mcpServers ?? {})) {
      if (!entry.baseUrl) continue;
      result[name] = {
        type: "http" as const,
        url: entry.baseUrl,
        ...(entry.headers && { headers: entry.headers }),
      };
    }
    _cached = result;
    console.log(`[mcporter-loader] Loaded ${Object.keys(result).length} HTTP MCP server(s):`, Object.keys(result).join(", ") || "(none)");
    return result;
  } catch (err) {
    console.warn("[mcporter-loader] Failed to parse mcporter.json:", err);
    _cached = {};
    return _cached;
  }
}

export function invalidateMcporterCache(): void {
  _cached = null;
}

export { getMcporterConfigPath };
