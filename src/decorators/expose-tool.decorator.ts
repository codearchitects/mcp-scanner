import 'reflect-metadata';

/* ------------------------------------------------------------------ */
/*  Metadata key used to store tool definitions on the class prototype */
/* ------------------------------------------------------------------ */
const EXPOSE_TOOL_KEY = Symbol('expose-tool');

/**
 * Options for the {@link ExposeTool} method decorator.
 * Each decorated method becomes a VS Code Language Model Tool entry.
 */
export interface IExposeToolOptions {
  /**
   * Unique tool name (used as `name` and `toolReferenceName` in package.json).
   */
  name: string;
  /**
   * Human-readable label shown in the Copilot Chat tool picker.
   */
  displayName: string;
  /**
   * Description sent to the language model so it knows when to call this tool.
   */
  modelDescription: string;
  /**
   * VS Code codicon identifier, e.g. `$(search)`. Defaults to `$(tools)`.
   */
  icon?: string;
  /**
   * Whether the tool can be referenced in a prompt with `#`. Defaults to `true`.
   */
  canBeReferencedInPrompt?: boolean;
}

/**
 * Internal record stored per decorated method.
 */
export interface IExposeToolEntry extends IExposeToolOptions {
  /**
   * Name of the decorated method on the class.
   */
  methodName: string;
}

/**
 * Method decorator that marks a method for automatic VS Code Language Model Tool generation.
 *
 * Usage:
 * ```ts
 * class MyService {
 *   @ExposeTool({
 *     name: 'greetUser',
 *     displayName: 'Greet User',
 *     modelDescription: 'Say hello to a user by name.',
 *     icon: '$(smiley)',
 *   })
 *   greetUser(params: IGreetUserParams): string { ... }
 * }
 * ```
 *
 * The scanner reads these entries (via {@link getExposedTools}) and the parameter
 * interface (`IGreetUserParams`) to produce the `inputSchema` automatically.
 *
 * @param options - Tool metadata written into `package.json contributes.languageModelTools`.
 * @returns Method decorator storing metadata on the class constructor.
 */
export function ExposeTool(options: IExposeToolOptions): MethodDecorator {
  return (target: Object, propertyKey: string | symbol, _descriptor: PropertyDescriptor) => {
    const existing: IExposeToolEntry[] = Reflect.getMetadata(EXPOSE_TOOL_KEY, target.constructor) ?? [];
    existing.push({ ...options, methodName: String(propertyKey) });
    Reflect.defineMetadata(EXPOSE_TOOL_KEY, existing, target.constructor);
  };
}

/**
 * Retrieve all {@link IExposeToolEntry} entries registered on a class via {@link ExposeTool}.
 * @param target The class constructor.
 * @returns Registered tool metadata entries for the target class.
 */
export function getExposedTools(target: Function): IExposeToolEntry[] {
  return Reflect.getMetadata(EXPOSE_TOOL_KEY, target) ?? [];
}
