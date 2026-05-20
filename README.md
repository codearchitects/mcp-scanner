# @codearchitects/mcp-scanner

Scan TypeScript projects for `@ExposeTool` decorated methods and automatically generate VS Code `contributes.languageModelTools` entries in `package.json`.

## Installation

```bash
# Global (provides `mcp-scanner` CLI)
npm install -g @codearchitects/mcp-scanner

# As a project dependency
npm install @codearchitects/mcp-scanner
```

## Quick Start

### 1. Decorate your methods

```typescript
import { ExposeTool } from '@codearchitects/mcp-scanner';

interface IGreetParams {
  /** The user's name. */
  name: string;
  /** Optional greeting style. */
  style?: 'formal' | 'casual';
}

class MyService {
  @ExposeTool({
    name: 'greetUser',
    displayName: 'Greet User',
    modelDescription: 'Say hello to a user by name with a chosen style.',
    icon: '$(smiley)',
  })
  greetUser(params: IGreetParams): string {
    return params.style === 'formal'
      ? `Good day, ${params.name}.`
      : `Hey ${params.name}!`;
  }
}
```

### 2. Run the scanner

```bash
# From your project root
mcp-scanner

# Or with options
mcp-scanner --project /path/to/project --tsconfig tsconfig.json

# Restrict scan only to a folder/subtree
mcp-scanner --project /path/to/project --tools-path src/tools

# Exclude one or more folders/subtrees from scan
mcp-scanner --project /path/to/project --exclude-path src/generated --exclude-path src/legacy

# Tag-scoped patching: only tools with this tag are replaced on rerun
mcp-scanner --project /path/to/project --tools-tag core

# Write to a specific package.json
mcp-scanner --project /path/to/project --package-json ../apps/vscode-ext/package.json

# Generate proxy methods into another library file
mcp-scanner --project /path/to/source-lib \
  --proxy-file ../apps/vscode-ext/src/services/generated-proxies.ts \
  --scaffold-template ../apps/vscode-ext/proxy-scaffold.ejs \
  --proxy-class ModelerToolsProxy

# Copy the default proxy scaffold template to customize it
mcp-scanner --init-proxy-file ./proxy-scaffold.ejs

# Dry run (preview without writing)
mcp-scanner --dry-run
```

### 3. Result in `package.json`

```json
{
  "contributes": {
    "languageModelTools": [
      { "name": "existingManualTool", "..." : "..." },
      {
        "name": "greetUser",
        "displayName": "Greet User",
        "modelDescription": "Say hello to a user by name with a chosen style.",
        "canBeReferencedInPrompt": true,
        "toolReferenceName": "greetUser",
        "icon": "$(smiley)",
        "inputSchema": {
          "type": "object",
          "properties": {
            "name": { "type": "string", "description": "The user's name." },
            "style": { "type": "string", "enum": ["formal", "casual"], "description": "Optional greeting style." }
          },
          "required": ["name"]
        }
      }
    ]
  }
}
```

`mcp-scanner` also writes `.mcp-scanner.state.json` in the project root to track which tools were generated in the previous run.
On re-run, only those previously generated tools are replaced, while manually-added tools are preserved.
If legacy marker strings are present (`____AUTOGEN_TOOLS_START____` / `____AUTOGEN_TOOLS_END____`), they are migrated automatically on the next run.

## VS Code Extension Integration

In your VS Code extension, register the Language Model Tool so users can invoke it from Copilot Chat:

```typescript
import { registerScanProjectToolsLmTool } from '@codearchitects/mcp-scanner/vscode';

export function activate(context: vscode.ExtensionContext) {
  // ... your extension setup ...

  // Register #scanProjectTools LM tool
  registerScanProjectToolsLmTool(context);
}
```

Then declare it in your extension's `package.json`:

```json
{
  "contributes": {
    "languageModelTools": [
      {
        "name": "scanProjectTools",
        "displayName": "Scan Project: @ExposeTool → package.json",
        "modelDescription": "Scan the current TypeScript project for methods decorated with @ExposeTool, generate JSON Schema from parameter interfaces, and update contributes.languageModelTools in package.json.",
        "canBeReferencedInPrompt": true,
        "toolReferenceName": "scanProjectTools",
        "icon": "$(search)",
        "inputSchema": {
          "type": "object",
          "properties": {
            "tsconfigPath": { "type": "string", "description": "tsconfig file name. Defaults to tsconfig.json." },
            "autoApply": { "type": "boolean", "description": "Apply changes without confirmation." }
          }
        }
      }
    ]
  }
}
```

## API

### `ExposeTool(options)` — Method Decorator

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `name` | `string` | ✅ | Unique tool name |
| `displayName` | `string` | ✅ | Human-readable label |
| `modelDescription` | `string` | ✅ | Description for the language model |
| `icon` | `string` | | VS Code codicon, e.g. `$(search)`. Default: `$(tools)` |
| `canBeReferencedInPrompt` | `boolean` | | Allow `#tool` references. Default: `true` |

### `Tool(options)` — Method Decorator

Used by code generators (e.g., proxy generation) to preserve tool metadata without exposing the method.
Accepts the same options as `@ExposeTool` but does not register the method as a tool.

`scanProject` recognises `@Tool` and derives `inputSchema` from the method parameter types exactly like `@ExposeTool` — so Library B (the proxy side) produces a fully-populated `contributes.languageModelTools` entry without any extra configuration.

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `name` | `string` | ✅ | Unique tool name |
| `displayName` | `string` | ✅ | Human-readable label |
| `modelDescription` | `string` | ✅ | Description for the language model |
| `icon` | `string` | | VS Code codicon, e.g. `$(search)`. Default: `$(tools)` |
| `canBeReferencedInPrompt` | `boolean` | | Allow `#tool` references. Default: `true` |

### `registerExposedTools(context, instances)` — Runtime Registration

Registers methods decorated with either `@ExposeTool` or `@Tool` as VS Code Language Model Tool handlers at runtime.
Duplicate tool names within the same activation are skipped with a warning.
This is useful for proxy-based architectures where generated proxy methods carry `@Tool` metadata.

### `scanProject(projectRoot, tsconfigFileName?, toolsSearchPath?, excludedSearchPaths?)` — Scanner

Returns `IScanResult` with discovered tools, file count, and diagnostics.

### `patchPackageJsonFile(path, tools, options?)` — File Patcher

Patches `package.json` on disk and updates `.mcp-scanner.state.json`.
When `options.toolTag` is set, patching is tag-scoped and state-file ownership is not used.

### `patchPackageJsonContent(raw, tools, previousGeneratedToolNames?, options?)` — String Patcher

Patches raw JSON string (for use with VS Code fs API or other runtimes).
Accepts an optional third argument with previously generated tool names.

Signature:

```ts
patchPackageJsonContent(
  raw: string,
  generatedTools: IScannedTool[],
  previousGeneratedToolNames?: string[],
  options?: { toolTag?: string },
): {
  content: string;
  result: IPatchResult;
  nextGeneratedToolNames: string[];
}
```

## CLI Options

```
mcp-scanner [options]

--project, -p <path>    Project root (default: cwd)
--tsconfig, -t <name>   tsconfig file name (default: tsconfig.json)
--tools-path, -s <path>
                      Restrict scanning to this path subtree.
                      Relative paths are resolved from --project.
--exclude-path, -i <path>
                      Exclude this path subtree from scanning.
                      Can be repeated. Relative paths are resolved from --project.
--tools-tag, -g <tag>
                      Tag generated tools and patch only tools with this tag.
                      If omitted, legacy state-based patching is used.
--package-json, -j <path>
                      package.json path to patch.
                      Relative paths are resolved from --project.
                      (default: <project>/package.json)
--proxy-file, -o <path>
                      Generate proxy methods into this file.
                      Relative paths are resolved from --project.
--proxy-class, -c <name>
                      Class name for generated proxies.
                      (default: GeneratedExposeToolProxies)
--scaffold-template, -x <path>
                      Custom EJS scaffold template for proxy generation.
                      Relative paths are resolved from --project.
--init-proxy-file <path>
                      Copy default complete proxy scaffold template.
                      Recommended extension: .ejs
--extra, -e <path> [tsconfig]
                        Additional project root to scan (repeatable)
--dry-run, -d           Preview without writing
--help, -h              Show help
```

## Proxy Generation (Monorepo)

When `@ExposeTool` methods live in one library but runtime command handlers live in another,
you can generate a proxy class in the target library.

### Usage

```bash
# Copy the default proxy scaffold template to start with
mcp-scanner --init-proxy-file ./proxy-scaffold.ejs

# Edit proxy-scaffold.ejs to customize (class layout, method body, imports)
# Then generate/update the TypeScript proxy file from that template
mcp-scanner --proxy-file ./MyProxyClass.ts \
  --proxy-class MyCustomClassName \
  --scaffold-template ./proxy-scaffold.ejs
```

### What is Generated

- One proxy method for each decorated source method.
- Original method JSDoc copied to each generated proxy method.
- Type imports required by method parameters/return type.
- Method body includes TODO comment with context and example.
- Reserved injection zones, so only generated sections are refreshed on re-run.

### Scaffold Template Variables

The scaffold template (EJS) has access to:

- `className`: The class name (set via `--proxy-class` or from template)
- `methods`: Array of method objects with:
  - `toolName`: Tool name from `@ExposeTool({ name })`
  - `toolOptions`: Complete metadata object from `@ExposeTool({ displayName, modelDescription, icon, canBeReferencedInPrompt })`
  - `methodName`: Source method name
  - `returnTypeText`: Return type text
  - `jsDoc`: JSDoc comment from source
  - `parameters`: Array of `{ name, typeText, optional }`
  - `firstParameterName`: First parameter name if present
  - `importStatements`: Array of required import statements

**Default scaffold template** (view/customize with `--init-proxy-file`):

```ejs
/* eslint-disable @typescript-eslint/no-unused-vars */
/* This file is auto-generated by mcp-scanner. */

// <mcp-scanner:proxy-imports:start>
import { Tool } from 'mcp-scanner';
<%- methods.flatMap(m => m.importStatements).filter((v, i, a) => a.indexOf(v) === i).sort().join('\n') %>
// <mcp-scanner:proxy-imports:end>

// <mcp-scanner:proxy-class:start>
export class <%- className %> {
// <mcp-scanner:proxy-class:end>
  // <mcp-scanner:proxy-methods:start>
  // JSDoc comment
  // @Tool decorator with metadata
  // public async method(...) { ... }
  // <mcp-scanner:proxy-methods:end>
}
```

You can also build your own template using the same EJS syntax and variable context.

Notes:

- Use `--package-json` and `--proxy-file` together when source and target libraries differ.
- Use `--tools-tag` when multiple generators write to the same `languageModelTools` array.
- On first run, if the proxy file does not exist, `mcp-scanner` creates it with markers.
- On subsequent runs, only marker sections (imports, class, methods) are updated; manual code outside markers is preserved.
- If the target file exists but has no method markers, generation stops to avoid destructive overwrite.
- For local exported types declared in source files, generation uses package imports when source and target are in different packages (derived from the nearest source `package.json` name per file, including `--extra` projects), otherwise relative imports are used.
- Local types must be `export`ed by the source package entrypoint to be importable from another package.

Injection markers used by the generator:

```ts
// <mcp-scanner:proxy-imports:start>
// ...auto-generated imports...
// <mcp-scanner:proxy-imports:end>

// <mcp-scanner:proxy-class:start>
// ...class declaration...
// <mcp-scanner:proxy-class:end>

// <mcp-scanner:proxy-methods:start>
// ...auto-generated methods...
// <mcp-scanner:proxy-methods:end>
```

## Preserving Tool Metadata in Proxies

When generating proxy methods, `mcp-scanner` automatically applies the `@Tool` decorator to preserve all original tool metadata (displayName, modelDescription, icon, canBeReferencedInPrompt).

### Why `@Tool` and not `@ExposeTool`?

- **`@ExposeTool`** exposes the method as a tool, which would cause the _proxy_ method to appear in `languageModelTools` in addition to the original. This is not desired.
- **`@Tool`** preserves metadata without exposure, allowing language model tools and MCP servers to access the complete tool definition without the proxy being registered as a separate tool.

### Example Generated Proxy

Given a source library method:

```typescript
class MyLibrary {
  @ExposeTool({
    name: 'processData',
    displayName: 'Process Data',
    modelDescription: 'Transforms data according to rules.',
    icon: '$(gear)',
  })
  processData(params: IDataParams): Promise<string> { ... }
}
```

The generated proxy preserves the metadata:

```typescript
class MyProxyClass {
  /**
   * Transforms data according to rules.
   */
  @Tool({
    name: 'processData',
    displayName: 'Process Data',
    modelDescription: 'Transforms data according to rules.',
    icon: '$(gear)',
  })
  public async processData(params: IDataParams): Promise<string> {
    // TODO: Replace with your implementation
    return await this._bridge.dispatch('processData', params);
  }
}
```

The `@Tool` decorator is automatically imported from `mcp-scanner` in the proxy file's imports section.


## How It Works

1. Loads the project's `tsconfig.json` and creates a TypeScript program
2. Walks the AST of every non-declaration source file
3. Finds `@ExposeTool(...)` decorated methods on classes
4. Extracts the decorator's options object (name, displayName, modelDescription, icon)
5. Resolves the first parameter's type into a JSON Schema (`inputSchema`)
   - Interfaces → `{ type: "object", properties: {...}, required: [...] }`
   - String unions → `{ type: "string", enum: [...] }`
   - Mixed-type unions (e.g. `string | number | boolean`) → `{ anyOf: [...] }`
   - Arrays, nested types, JSDoc descriptions — all handled
6. Replaces previously generated tools in `package.json` `contributes.languageModelTools`
7. Persists generated ownership to `.mcp-scanner.state.json`

## License

MIT - see LICENSE.
