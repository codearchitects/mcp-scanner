import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MCP_SERVER_GROUP,
  groupMcpToolsByServer,
  mcpServerGroupsOf,
  readMcpManifestFile,
  serializeMcpManifest,
  targetsMcp,
  writeMcpManifestFile,
} from '../../src/mcp-manifest';
import type { IScannedTool } from '../../src/scanner';
import { makeTempDir } from '../helpers/tmp';

function tool(
  name: string,
  transports: Array<'lm' | 'mcp'> = ['lm'],
  mcpServers?: string[],
): IScannedTool {
  return {
    name,
    displayName: name,
    modelDescription: `${name} desc`,
    canBeReferencedInPrompt: true,
    toolReferenceName: name,
    icon: '$(tools)',
    inputSchema: { type: 'object', properties: {} },
    transports,
    ...(mcpServers ? { mcpServers } : {}),
  };
}

describe('mcp-manifest', () => {
  it('detects mcp-targeting tools', () => {
    expect(targetsMcp(tool('a', ['mcp']))).toBe(true);
    expect(targetsMcp(tool('b', ['lm', 'mcp']))).toBe(true);
    expect(targetsMcp(tool('c', ['lm']))).toBe(false);
  });

  it('resolves server groups, defaulting when unnamed', () => {
    expect(mcpServerGroupsOf(tool('a', ['mcp']))).toEqual([DEFAULT_MCP_SERVER_GROUP]);
    expect(mcpServerGroupsOf(tool('b', ['mcp'], ['A', 'B']))).toEqual(['A', 'B']);
    expect(mcpServerGroupsOf(tool('c', ['mcp'], ['A', 'A']))).toEqual(['A']);
  });

  it('uses the fallback group when the tool declares no mcpServers', () => {
    // Explicit mcpServers always win over the fallback.
    expect(mcpServerGroupsOf(tool('a', ['mcp'], ['A']), 'caip')).toEqual(['A']);
    // Otherwise the fallback (e.g. the CLI --tools-tag) is used.
    expect(mcpServerGroupsOf(tool('b', ['mcp']), 'caip')).toEqual(['caip']);
    // Blank fallback falls back to the default group.
    expect(mcpServerGroupsOf(tool('c', ['mcp']), '  ')).toEqual([DEFAULT_MCP_SERVER_GROUP]);
  });

  it('groups tools under the fallback group when unnamed', () => {
    const groups = groupMcpToolsByServer([
      tool('t1', ['mcp']),
      tool('t2', ['mcp'], ['override']),
    ], 'caip');

    expect(groups.get('caip')?.map((t) => t.name)).toEqual(['t1']);
    expect(groups.get('override')?.map((t) => t.name)).toEqual(['t2']);
    expect(groups.has(DEFAULT_MCP_SERVER_GROUP)).toBe(false);
  });

  it('groups mcp tools by server, ignoring lm-only tools', () => {
    const groups = groupMcpToolsByServer([
      tool('lmOnly', ['lm']),
      tool('defaultMcp', ['mcp']),
      tool('a1', ['mcp'], ['A']),
      tool('ab', ['lm', 'mcp'], ['A', 'B']),
    ]);

    expect([...groups.keys()].sort()).toEqual(['A', 'B', DEFAULT_MCP_SERVER_GROUP].sort());
    expect(groups.get('A')?.map((t) => t.name)).toEqual(['a1', 'ab']);
    expect(groups.get('B')?.map((t) => t.name)).toEqual(['ab']);
    expect(groups.get(DEFAULT_MCP_SERVER_GROUP)?.map((t) => t.name)).toEqual(['defaultMcp']);
  });

  it('serializes a manifest with native inputSchema and no routing fields', () => {
    const content = serializeMcpManifest([tool('t1', ['mcp'], ['A'])], 'A');
    const parsed = JSON.parse(content) as {
      version: number;
      server: string;
      tools: Array<Record<string, unknown>>;
    };

    expect(parsed.version).toBe(1);
    expect(parsed.server).toBe('A');
    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tools[0].name).toBe('t1');
    expect(parsed.tools[0].inputSchema).toEqual({ type: 'object', properties: {} });
    expect(parsed.tools[0].transports).toBeUndefined();
    expect(parsed.tools[0].mcpServers).toBeUndefined();
  });

  it('writes and reads back a manifest file, creating parent dirs', () => {
    const root = makeTempDir();
    const manifestPath = path.join(root, 'nested', 'server-a.mcp.json');

    const res = writeMcpManifestFile(manifestPath, [tool('t1', ['mcp'])], 'serverA');
    expect(res.ok).toBe(true);
    expect(fs.existsSync(manifestPath)).toBe(true);

    const manifest = readMcpManifestFile(manifestPath);
    expect(manifest?.server).toBe('serverA');
    expect(manifest?.tools.map((t) => t.name)).toEqual(['t1']);
  });

  it('returns undefined when reading a missing or invalid manifest', () => {
    const root = makeTempDir();
    expect(readMcpManifestFile(path.join(root, 'nope.json'))).toBeUndefined();

    const bad = path.join(root, 'bad.json');
    fs.writeFileSync(bad, '{ not json', 'utf-8');
    expect(readMcpManifestFile(bad)).toBeUndefined();
  });
});
