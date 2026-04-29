/* ------------------------------------------------------------------ */
/*  scanProjectTools — VS Code Language Model Tool                     */
/*                                                                     */
/*  Scans the current project's TypeScript sources for methods         */
/*  decorated with @ExposeTool, builds the JSON Schema for each tool,  */
/*  and offers to patch the project's package.json                     */
/*  `contributes.languageModelTools` section.                          */
/* ------------------------------------------------------------------ */

import * as vscode from 'vscode';
import { AUTOGEN_STATE_FILE, patchPackageJsonContent } from '../patcher';
import type { IScannedTool } from '../scanner';
import { scanProject } from '../scanner';

/* ------------------------------------------------------------------ */
/*  VS Code fs-based patcher                                           */
/* ------------------------------------------------------------------ */

/**
 * Patch workspace `package.json` using VS Code file system APIs.
 *
 * @param workspaceFolderUri Workspace root URI.
 * @param packageJsonUri Package manifest URI.
 * @param generatedTools Generated tools to write.
 * @returns Patch result object.
 */
async function patchPackageJsonVscode(
  workspaceFolderUri: vscode.Uri,
  packageJsonUri: vscode.Uri,
  generatedTools: IScannedTool[],
): Promise<{ ok: boolean; message: string }> {
  const stateUri = vscode.Uri.joinPath(workspaceFolderUri, AUTOGEN_STATE_FILE);

  let previousGeneratedToolNames: string[] = [];
  try {
    const stateRaw = Buffer.from(await vscode.workspace.fs.readFile(stateUri)).toString('utf-8');
    const parsed = JSON.parse(stateRaw) as { generatedToolNames?: unknown };
    if (Array.isArray(parsed.generatedToolNames)) {
      previousGeneratedToolNames = parsed.generatedToolNames.filter((n): n is string => typeof n === 'string');
    }
  } catch {
    // No state file yet, or invalid content: treat as first run.
  }

  const raw = Buffer.from(await vscode.workspace.fs.readFile(packageJsonUri)).toString('utf-8');
  const { content, result, nextGeneratedToolNames } = patchPackageJsonContent(
    raw,
    generatedTools,
    previousGeneratedToolNames,
  );

  if (result.ok) {
    await vscode.workspace.fs.writeFile(packageJsonUri, Buffer.from(content, 'utf-8'));
    const state = {
      version: 1,
      generatedToolNames: Array.from(new Set(nextGeneratedToolNames)),
    };
    await vscode.workspace.fs.writeFile(stateUri, Buffer.from(`${JSON.stringify(state, null, 2)}\n`, 'utf-8'));
  }

  return result;
}

/* ------------------------------------------------------------------ */
/*  Registration                                                       */
/* ------------------------------------------------------------------ */

/**
 * Register the `scanProjectTools` Language Model Tool with VS Code.
 *
 * This tool is invoked from Copilot Chat (e.g. `#scanProjectTools`) and:
 * 1. Scans the workspace project for `@ExposeTool` decorated methods.
 * 2. Builds the `languageModelTools` JSON entries with `inputSchema` derived
 *    from each method's parameter interface.
 * 3. Asks the user whether to patch `package.json`.
 * 4. Patches using sidecar state so manually-added tools are preserved.
 *
 * @returns Disposable to unregister the tool.
 */
export function registerScanProjectToolsLmTool(
  context: vscode.ExtensionContext,
): vscode.Disposable | undefined {
  if (!vscode.lm || typeof vscode.lm.registerTool !== 'function') {
    console.log('[mcp-scanner] vscode.lm.registerTool not available — skipping');
    return undefined;
  }

  /**
   * Input schema accepted by the `scanProjectTools` LM tool.
   */
  interface IScanToolInput {
    /**
     * Optional: workspace-relative path to tsconfig. Defaults to `tsconfig.json`.
     */
    tsconfigPath?: string;
    /**
     * If true, automatically apply changes without asking.
     */
    autoApply?: boolean;
  }

  const disposable = vscode.lm.registerTool<IScanToolInput>('scanProjectTools', {

    async prepareInvocation(
      options: vscode.LanguageModelToolInvocationPrepareOptions<IScanToolInput>,
    ) {
      const autoApply = options.input?.autoApply ?? false;
      if (autoApply) {
        return {
          invocationMessage: 'Scanning project for @ExposeTool methods and updating package.json...',
        };
      }
      return {
        invocationMessage: 'Scanning project for @ExposeTool methods...',
        confirmationMessages: {
          title: 'Scan Project Tools',
          message: new vscode.MarkdownString(
            'This will scan your TypeScript project for `@ExposeTool` decorated methods and update `package.json` `contributes.languageModelTools`. Manually-added tools are preserved while previously generated tools are replaced.\n\nProceed?',
          ),
        },
      };
    },

    async invoke(
      options: vscode.LanguageModelToolInvocationOptions<IScanToolInput>,
      _token: vscode.CancellationToken,
    ) {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(JSON.stringify({ error: 'No workspace folder open.' })),
        ]);
      }

      const projectRoot = workspaceFolder.uri.fsPath;
      const tsconfigName = options.input?.tsconfigPath ?? 'tsconfig.json';

      // 1. Scan
      const scanResult = scanProject(projectRoot, tsconfigName);

      if (scanResult.tools.length === 0 && scanResult.diagnostics.length === 0) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(JSON.stringify({
            summary: 'No @ExposeTool decorated methods found.',
            filesScanned: scanResult.filesScanned,
          }, null, 2)),
        ]);
      }

      // 2. Show summary
      const summary = {
        toolsFound: scanResult.tools.length,
        filesScanned: scanResult.filesScanned,
        diagnostics: scanResult.diagnostics,
        tools: scanResult.tools.map((t) => ({ name: t.name, displayName: t.displayName })),
      };

      // 3. Patch package.json
      const packageJsonUri = vscode.Uri.joinPath(workspaceFolder.uri, 'package.json');
      try {
        await vscode.workspace.fs.stat(packageJsonUri);
      } catch {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(JSON.stringify({
            ...summary,
            error: 'No package.json found in workspace root.',
          }, null, 2)),
        ]);
      }

      const patchResult = await patchPackageJsonVscode(workspaceFolder.uri, packageJsonUri, scanResult.tools);

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(JSON.stringify({
          ...summary,
          patch: patchResult,
          generatedTools: scanResult.tools,
        }, null, 2)),
      ]);
    },
  });

  context.subscriptions.push(disposable);
  return disposable;
}
