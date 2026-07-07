import 'reflect-metadata';

/* ------------------------------------------------------------------ */
/*  Metadata key used to store non-exposed tool definitions on methods */
/* ------------------------------------------------------------------ */
const TOOL_KEY = Symbol('tool');

/**
 * Options for the {@link Tool} method decorator.
 *
 * Same structure as {@link IExposeToolOptions}, used to preserve metadata
 * on proxy-generated methods without exposing them as tools.
 */
export interface IToolOptions {
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
  /**
   * Transports this tool should be published to.
   *
   * - `'lm'` → written into `contributes.languageModelTools` (VS Code LM tool).
   * - `'mcp'` → written into an MCP manifest sidecar for embedded MCP servers.
   *
   * Defaults to `['lm']`, preserving the historical behavior.
   */
  transports?: Array<'lm' | 'mcp'>;
  /**
   * Names of the MCP server groups this tool belongs to.
   *
   * Only meaningful when `transports` includes `'mcp'`. Lets a single project
   * split tools across multiple MCP servers, each emitted into its own named
   * manifest file. When omitted, the tool falls into the default MCP server group.
   */
  mcpServers?: string[];
}

/**
 * Internal record stored per decorated method.
 */
export interface IToolEntry extends IToolOptions {
  /**
   * Name of the decorated method on the class.
   */
  methodName: string;
}

/**
 * Method decorator that marks a method with tool metadata without exposing it.
 *
 * This decorator is used by code generators (e.g., proxy generation) to preserve
 * the original tool metadata in proxy methods, without causing the proxy to be
 * exposed as a tool itself.
 *
 * Usage:
 * ```ts
 * class ProxyService {
 *   @Tool({
 *     name: 'greetUser',
 *     displayName: 'Greet User',
 *     modelDescription: 'Say hello to a user by name.',
 *     icon: '$(smiley)',
 *   })
 *   greetUser(params: IGreetUserParams): string { ... }
 * }
 * ```
 *
 * @param options - Tool metadata to preserve on the method.
 * @returns Method decorator storing metadata on the class constructor.
 */
export function Tool(options: IToolOptions): MethodDecorator {
  return (target: Object, propertyKey: string | symbol, _descriptor: PropertyDescriptor) => {
    const existing: IToolEntry[] = Reflect.getMetadata(TOOL_KEY, target.constructor) ?? [];
    existing.push({ ...options, methodName: String(propertyKey) });
    Reflect.defineMetadata(TOOL_KEY, existing, target.constructor);
  };
}

/**
 * Retrieve all {@link IToolEntry} entries registered on a class via {@link Tool}.
 * @param target The class constructor.
 * @returns Registered tool metadata entries for the target class.
 */
export function getTools(target: Function): IToolEntry[] {
  return Reflect.getMetadata(TOOL_KEY, target) ?? [];
}
