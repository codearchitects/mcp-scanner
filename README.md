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

### `scanProject(projectRoot, tsconfigFileName?)` — Scanner

Returns `IScanResult` with discovered tools, file count, and diagnostics.

### `patchPackageJsonFile(path, tools)` — File Patcher

Patches `package.json` on disk and updates `.mcp-scanner.state.json`.

### `patchPackageJsonContent(raw, tools)` — String Patcher

Patches raw JSON string (for use with VS Code fs API or other runtimes).
Accepts an optional third argument with previously generated tool names.

Signature:

```ts
patchPackageJsonContent(
  raw: string,
  generatedTools: IScannedTool[],
  previousGeneratedToolNames?: string[],
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
--extra, -e <path> [tsconfig]
                        Additional project root to scan (repeatable)
--dry-run, -d           Preview without writing
--help, -h              Show help
```

## How It Works

1. Loads the project's `tsconfig.json` and creates a TypeScript program
2. Walks the AST of every non-declaration source file
3. Finds `@ExposeTool(...)` decorated methods on classes
4. Extracts the decorator's options object (name, displayName, modelDescription, icon)
5. Resolves the first parameter's type into a JSON Schema (`inputSchema`)
   - Interfaces → `{ type: "object", properties: {...}, required: [...] }`
   - String unions → `{ type: "string", enum: [...] }`
   - Arrays, nested types, JSDoc descriptions — all handled
6. Replaces previously generated tools in `package.json` `contributes.languageModelTools`
7. Persists generated ownership to `.mcp-scanner.state.json`

## License

MIT - see LICENSE.
