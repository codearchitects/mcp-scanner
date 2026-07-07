/* ------------------------------------------------------------------ */
/*  MCP manifest sidecar                                               */
/*                                                                     */
/*  Emits scanned tools that target the `mcp` transport into a         */
/*  dedicated, fully-generated JSON sidecar. Unlike package.json,      */
/*  this file is entirely owned by mcp-scanner and regenerated on      */
/*  every run. A project may split tools across multiple named MCP     */
/*  server groups, each written to its own manifest file.              */
/* ------------------------------------------------------------------ */

import * as fs from 'fs';
import * as path from 'path';
import type { IScannedTool } from './scanner';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/**
 * Default MCP manifest file name.
 */
export const MCP_MANIFEST_FILE = '.mcp-scanner.mcp.json';

/**
 * Server group assigned to `mcp` tools that do not name any server.
 */
export const DEFAULT_MCP_SERVER_GROUP = 'default';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/**
 * A single tool entry inside an MCP manifest — everything an MCP server
 * needs to answer `tools/list` and dispatch `tools/call`.
 */
export interface IMcpManifestTool {
  /**
   * Unique tool identifier.
   */
  name: string;

  /**
   * User-facing tool label.
   */
  displayName: string;

  /**
   * Model-facing description used for tool selection.
   */
  modelDescription: string;

  /**
   * VS Code codicon identifier (carried for parity with LM tools).
   */
  icon: string;

  /**
   * Whether tool can be referenced with `#` in prompts.
   */
  canBeReferencedInPrompt: boolean;

  /**
   * JSON Schema describing tool input (native MCP `inputSchema` format).
   */
  inputSchema: Record<string, unknown>;

  /**
   * Optional tool tags used for grouping/filtering.
   */
  tags?: string[];
}

/**
 * Serialized MCP manifest document.
 */
export interface IMcpManifest {
  /**
   * Manifest schema version.
   */
  version: 1;

  /**
   * Name of the MCP server group this manifest belongs to.
   */
  server: string;

  /**
   * Tools exposed by this MCP server group.
   */
  tools: IMcpManifestTool[];
}

/**
 * Result of an MCP manifest write operation.
 */
export interface IMcpManifestResult {
  /**
   * Whether the write completed successfully.
   */
  ok: boolean;

  /**
   * Human-readable status message.
   */
  message: string;
}

/* ------------------------------------------------------------------ */
/*  Grouping                                                           */
/* ------------------------------------------------------------------ */

/**
 * Determine whether a scanned tool targets the MCP transport.
 *
 * @param tool Scanned tool.
 * @returns `true` when the tool should be published over MCP.
 */
export function targetsMcp(tool: IScannedTool): boolean {
  return tool.transports.includes('mcp');
}

/**
 * Resolve the MCP server groups a tool belongs to.
 *
 * Precedence: an explicit `mcpServers` on the tool wins; otherwise the provided
 * `fallbackGroup` is used (e.g. the CLI `--tools-tag`); otherwise `'default'`.
 *
 * @param tool Scanned tool.
 * @param fallbackGroup Group applied when the tool declares no `mcpServers`.
 * @returns Non-empty list of server group names.
 */
export function mcpServerGroupsOf(
  tool: IScannedTool,
  fallbackGroup: string = DEFAULT_MCP_SERVER_GROUP,
): string[] {
  const named = (tool.mcpServers ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
  if (named.length > 0) {
    return Array.from(new Set(named));
  }

  const fallback = fallbackGroup.trim();
  return [fallback.length > 0 ? fallback : DEFAULT_MCP_SERVER_GROUP];
}

/**
 * Group MCP-targeting tools by their server group name.
 *
 * A tool that names multiple servers appears under each of them. Tools without
 * an explicit `mcpServers` fall into `fallbackGroup` (typically the CLI tag).
 *
 * @param tools Scanned tools (mixed transports allowed).
 * @param fallbackGroup Group applied to tools that declare no `mcpServers`.
 * @returns Map from server group name to its tools.
 */
export function groupMcpToolsByServer(
  tools: IScannedTool[],
  fallbackGroup: string = DEFAULT_MCP_SERVER_GROUP,
): Map<string, IScannedTool[]> {
  const groups = new Map<string, IScannedTool[]>();

  for (const tool of tools) {
    if (!targetsMcp(tool)) {
      continue;
    }

    for (const group of mcpServerGroupsOf(tool, fallbackGroup)) {
      const list = groups.get(group) ?? [];
      list.push(tool);
      groups.set(group, list);
    }
  }

  return groups;
}

/* ------------------------------------------------------------------ */
/*  Serialization                                                      */
/* ------------------------------------------------------------------ */

/**
 * Project a scanned tool into a manifest tool entry.
 *
 * @param tool Scanned tool.
 * @returns Manifest tool entry (transport/server routing fields stripped).
 */
function toManifestTool(tool: IScannedTool): IMcpManifestTool {
  return {
    name: tool.name,
    displayName: tool.displayName,
    modelDescription: tool.modelDescription,
    icon: tool.icon,
    canBeReferencedInPrompt: tool.canBeReferencedInPrompt,
    inputSchema: tool.inputSchema,
    ...(tool.tags && tool.tags.length > 0 ? { tags: tool.tags } : {}),
  };
}

/**
 * Serialize an MCP manifest to formatted JSON text.
 *
 * @param tools Tools belonging to the server group.
 * @param serverName MCP server group name.
 * @returns Formatted manifest JSON (trailing newline included).
 */
export function serializeMcpManifest(
  tools: IScannedTool[],
  serverName: string = DEFAULT_MCP_SERVER_GROUP,
): string {
  const manifest: IMcpManifest = {
    version: 1,
    server: serverName,
    tools: tools.map(toManifestTool),
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/* ------------------------------------------------------------------ */
/*  File-system convenience                                            */
/* ------------------------------------------------------------------ */

/**
 * Write an MCP manifest file to disk, creating parent directories as needed.
 *
 * The manifest is fully generated and overwrites any existing file.
 *
 * @param manifestPath Absolute path to the manifest file.
 * @param tools Tools belonging to the server group.
 * @param serverName MCP server group name.
 * @returns Write operation result.
 */
export function writeMcpManifestFile(
  manifestPath: string,
  tools: IScannedTool[],
  serverName: string = DEFAULT_MCP_SERVER_GROUP,
): IMcpManifestResult {
  try {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, serializeMcpManifest(tools, serverName), 'utf-8');
    return {
      ok: true,
      message: `Wrote MCP manifest '${serverName}' with ${tools.length} tool(s) to ${manifestPath}.`,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Failed to write MCP manifest ${manifestPath}: ${message}` };
  }
}

/**
 * Read and validate an MCP manifest file (runtime helper for MCP servers).
 *
 * @param manifestPath Absolute path to the manifest file.
 * @returns Parsed manifest, or `undefined` when missing or invalid.
 */
export function readMcpManifestFile(manifestPath: string): IMcpManifest | undefined {
  if (!fs.existsSync(manifestPath)) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    if (!Array.isArray(record.tools)) {
      return undefined;
    }
    return {
      version: 1,
      server: typeof record.server === 'string' ? record.server : DEFAULT_MCP_SERVER_GROUP,
      tools: record.tools as IMcpManifestTool[],
    };
  } catch {
    return undefined;
  }
}
