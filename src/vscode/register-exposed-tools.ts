/* ------------------------------------------------------------------ */
/*  registerExposedTools — runtime bridge                              */
/*                                                                     */
/*  Given one or more class instances whose methods are decorated      */
/*  with @ExposeTool or @Tool, this function registers each decorated  */
/*  method as a VS Code Language Model Tool via vscode.lm.registerTool(). */
/*                                                                     */
/*  This is the RUNTIME counterpart to the CLI scanner:               */
/*    - CLI scanner  → writes tool declarations into package.json     */
/*    - this function → registers the actual tool handlers at runtime */
/* ------------------------------------------------------------------ */

import * as vscode from 'vscode';
import { getExposedTools, getTools, type IExposeToolEntry, type IToolEntry } from '../decorators';

/**
 * Register all `@ExposeTool` and `@Tool` decorated methods from one or more
 * class instances as VS Code Language Model Tools.
 *
 * Each decorated method becomes a tool that Copilot Chat can invoke.
 * The method receives the input parameters as its first argument and
 * must return a value (or Promise) that will be serialized as the
 * tool result.
 *
 * Usage in extension.ts:
 * ```ts
 * import { registerExposedTools } from 'mcp-scanner/vscode';
 * import { CalculatorToolsDemo } from './services/calculator-tools-demo';
 *
 * export function activate(context: vscode.ExtensionContext) {
 *   registerExposedTools(context, [new CalculatorToolsDemo()]);
 * }
 * ```
 *
 * @param context The VS Code extension context (disposables are pushed here).
 * @param instances One or more class instances with `@ExposeTool`/`@Tool` methods.
 * @returns Array of disposables for all registered tools.
 */
export function registerExposedTools(
  context: vscode.ExtensionContext,
  instances: object[],
): vscode.Disposable[] {
  if (!vscode.lm || typeof vscode.lm.registerTool !== 'function') {
    console.log('[mcp-scanner] vscode.lm.registerTool not available — skipping runtime registration');
    return [];
  }

  const disposables: vscode.Disposable[] = [];
  const registeredToolNames = new Set<string>();

  for (const instance of instances) {
    const ctor = instance.constructor;
    const exposedEntries: IExposeToolEntry[] = getExposedTools(ctor);
    const toolEntries: IToolEntry[] = getTools(ctor);
    const entries: Array<IExposeToolEntry | IToolEntry> = [...exposedEntries, ...toolEntries];

    if (entries.length === 0) {
      console.log(`[mcp-scanner] No @ExposeTool/@Tool methods found on ${ctor.name}`);
      continue;
    }

    for (const entry of entries) {
      if (registeredToolNames.has(entry.name)) {
        console.warn(
          `[mcp-scanner] Tool "${entry.name}" already registered in this activation — skipping duplicate on ${ctor.name}.${entry.methodName}`,
        );
        continue;
      }

      const method = (instance as Record<string, Function>)[entry.methodName];
      if (typeof method !== 'function') {
        console.warn(`[mcp-scanner] Method "${entry.methodName}" not found on ${ctor.name}`);
        continue;
      }

      const boundMethod = method.bind(instance);

      const disposable = vscode.lm.registerTool<Record<string, unknown>>(entry.name, {
        async prepareInvocation(
          _options: vscode.LanguageModelToolInvocationPrepareOptions<Record<string, unknown>>,
        ) {
          return {
            invocationMessage: `Running ${entry.displayName}...`,
          };
        },

        async invoke(
          options: vscode.LanguageModelToolInvocationOptions<Record<string, unknown>>,
          _token: vscode.CancellationToken,
        ) {
          try {
            const input = options.input ?? {};
            const result = await Promise.resolve(boundMethod(input));

            const text = result !== undefined && result !== null
              ? (typeof result === 'string' ? result : JSON.stringify(result, null, 2))
              : 'Done.';

            return new vscode.LanguageModelToolResult([
              new vscode.LanguageModelTextPart(text),
            ]);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            return new vscode.LanguageModelToolResult([
              new vscode.LanguageModelTextPart(JSON.stringify({ error: message })),
            ]);
          }
        },
      });

      disposables.push(disposable);
      context.subscriptions.push(disposable);
      registeredToolNames.add(entry.name);
      console.log(`[mcp-scanner] Registered LM tool: ${entry.name} (${ctor.name}.${entry.methodName})`);
    }
  }

  return disposables;
}
