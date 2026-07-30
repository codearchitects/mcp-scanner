/* ------------------------------------------------------------------ */
/*  mcp-scanner — public API                                           */
/*                                                                     */
/*  Exports:                                                           */
/*    Decorator:  ExposeTool, getExposedTools, Tool, getTools, IExposeToolOptions, IToolOptions       */
/*    Scanner:    scanProject, IScannedTool, IScanResult                */
/*    Patcher:    patchPackageJsonFile, patchPackageJsonContent         */
/*                                                                     */
/*  VS Code integration is exported from "mcp-scanner/vscode":         */
/*    registerScanProjectToolsLmTool                                   */
/* ------------------------------------------------------------------ */

/**
 * Decorator exports.
 */
// Decorator
export { ExposeTool, getExposedTools, Tool, getTools } from './decorators';
export type { IExposeToolEntry, IExposeToolOptions, IToolEntry, IToolOptions } from './decorators';

/**
 * Scanner exports.
 */
// Scanner
export { scanProject } from './scanner';
export type { IScannedTool, IScanOptions, IScanResult, ToolTransport } from './scanner';

/**
 * Patcher exports.
 */
// Patcher
export { AUTOGEN_STATE_FILE, MARKER_END, MARKER_START, patchPackageJsonContent, patchPackageJsonFile } from './patcher';
export type { IPatchResult } from './patcher';

/**
 * MCP manifest exports.
 */
// MCP manifest
export {
  DEFAULT_MCP_SERVER_GROUP,
  MCP_MANIFEST_FILE,
  assertValidMcpInputSchemas,
  groupMcpToolsByServer,
  mcpServerGroupsOf,
  readMcpManifestFile,
  serializeMcpManifest,
  targetsMcp,
  writeMcpManifestFile,
} from './mcp-manifest';
export type { IMcpManifest, IMcpManifestResult, IMcpManifestTool } from './mcp-manifest';

