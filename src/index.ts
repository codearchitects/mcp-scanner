/* ------------------------------------------------------------------ */
/*  mcp-scanner — public API                                           */
/*                                                                     */
/*  Exports:                                                           */
/*    Decorator:  ExposeTool, getExposedTools, IExposeToolOptions       */
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
export { ExposeTool, getExposedTools } from './decorators';
export type { IExposeToolEntry, IExposeToolOptions } from './decorators';

/**
 * Scanner exports.
 */
// Scanner
export { scanProject } from './scanner';
export type { IScannedTool, IScanResult } from './scanner';

/**
 * Patcher exports.
 */
// Patcher
export { AUTOGEN_STATE_FILE, MARKER_END, MARKER_START, patchPackageJsonContent, patchPackageJsonFile } from './patcher';
export type { IPatchResult } from './patcher';

