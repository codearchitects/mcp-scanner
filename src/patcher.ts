/* ------------------------------------------------------------------ */
/*  Package.json patcher                                               */
/*                                                                     */
/*  Replaces only previously generated languageModelTools entries,      */
/*  preserving manually-added tools via sidecar state tracking.         */
/* ------------------------------------------------------------------ */

import * as fs from 'fs';
import * as path from 'path';
import type { IScannedTool } from './scanner';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

export const MARKER_START = '____AUTOGEN_TOOLS_START____';
export const MARKER_END   = '____AUTOGEN_TOOLS_END____';
export const AUTOGEN_STATE_FILE = '.mcp-scanner.state.json';

/* ------------------------------------------------------------------ */
/*  Result type                                                        */
/* ------------------------------------------------------------------ */

export interface IPatchResult {
  ok: boolean;
  message: string;
}

interface IAutoGenState {
  version: 1;
  generatedToolNames: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getToolName(entry: unknown): string | undefined {
  if (!isRecord(entry)) {
    return undefined;
  }
  const name = entry.name;
  return typeof name === 'string' ? name : undefined;
}

function parseStateContent(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return [];
    }
    const names = parsed.generatedToolNames;
    if (!Array.isArray(names)) {
      return [];
    }
    return names.filter((n): n is string => typeof n === 'string');
  } catch {
    return [];
  }
}

function makeStateContent(generatedToolNames: string[]): string {
  const uniqueNames = Array.from(new Set(generatedToolNames));
  const state: IAutoGenState = {
    version: 1,
    generatedToolNames: uniqueNames,
  };
  return `${JSON.stringify(state, null, 2)}\n`;
}

/* ------------------------------------------------------------------ */
/*  Core patching logic (operates on raw string)                       */
/* ------------------------------------------------------------------ */

/**
 * Patch the raw content of a package.json string, replacing only
 * previously generated tools.
 *
 * @param raw The current package.json text.
 * @param generatedTools The tools to inject.
 * @param previousGeneratedToolNames The tool names generated in the previous run.
 * @returns The new package.json text and a status message.
 */
export function patchPackageJsonContent(
  raw: string,
  generatedTools: IScannedTool[],
  previousGeneratedToolNames: string[] = [],
): { content: string; result: IPatchResult; nextGeneratedToolNames: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      content: raw,
      result: { ok: false, message: 'package.json is not valid JSON.' },
      nextGeneratedToolNames: previousGeneratedToolNames,
    };
  }

  if (!isRecord(parsed)) {
    return {
      content: raw,
      result: { ok: false, message: 'package.json root must be a JSON object.' },
      nextGeneratedToolNames: previousGeneratedToolNames,
    };
  }

  const root = parsed as Record<string, unknown>;

  const contributesRaw = root.contributes;
  const contributes: Record<string, unknown> = isRecord(contributesRaw) ? contributesRaw : {};

  const existingArrayRaw = contributes.languageModelTools;
  const existingTools = Array.isArray(existingArrayRaw) ? existingArrayRaw : [];

  const startMarkerIndex = existingTools.findIndex((entry) => entry === MARKER_START);
  const endMarkerIndex = existingTools.findIndex((entry, index) => index > startMarkerIndex && entry === MARKER_END);

  const previousGeneratedSet = new Set(previousGeneratedToolNames);
  const manualTools: unknown[] = [];

  for (let i = 0; i < existingTools.length; i++) {
    const entry = existingTools[i];

    if (entry === MARKER_START || entry === MARKER_END) {
      continue;
    }

    const insideLegacyBlock = startMarkerIndex !== -1 && endMarkerIndex !== -1 && i > startMarkerIndex && i < endMarkerIndex;
    if (insideLegacyBlock) {
      continue;
    }

    const entryName = getToolName(entry);
    if (entryName && previousGeneratedSet.has(entryName)) {
      continue;
    }

    manualTools.push(entry);
  }

  const generatedEntries: unknown[] = generatedTools.map((tool) => ({ ...tool }));
  contributes.languageModelTools = [...manualTools, ...generatedEntries];

  root.contributes = contributes;

  const nextGeneratedToolNames = generatedTools.map((tool) => tool.name);

  return {
    content: `${JSON.stringify(root, null, 2)}\n`,
    result: { ok: true, message: `Patched package.json with ${generatedTools.length} auto-generated tool(s).` },
    nextGeneratedToolNames,
  };
}

/* ------------------------------------------------------------------ */
/*  File-system convenience (for CLI and Node.js usage)                */
/* ------------------------------------------------------------------ */

/**
 * Patch a package.json file on disk.
 *
 * @param packageJsonPath Absolute path to package.json.
 * @param generatedTools The tools to inject.
 */
export function patchPackageJsonFile(packageJsonPath: string, generatedTools: IScannedTool[]): IPatchResult {
  if (!fs.existsSync(packageJsonPath)) {
    return { ok: false, message: `File not found: ${packageJsonPath}` };
  }

  const stateFilePath = path.join(path.dirname(packageJsonPath), AUTOGEN_STATE_FILE);

  let previousGeneratedToolNames: string[] = [];
  if (fs.existsSync(stateFilePath)) {
    previousGeneratedToolNames = parseStateContent(fs.readFileSync(stateFilePath, 'utf-8'));
  }

  const raw = fs.readFileSync(packageJsonPath, 'utf-8');
  const { content, result, nextGeneratedToolNames } = patchPackageJsonContent(
    raw,
    generatedTools,
    previousGeneratedToolNames,
  );

  if (result.ok) {
    fs.writeFileSync(packageJsonPath, content, 'utf-8');
    fs.writeFileSync(stateFilePath, makeStateContent(nextGeneratedToolNames), 'utf-8');
  }

  return result;
}
