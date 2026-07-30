# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project follows Semantic Versioning.

## [1.2.3] - 2026-07-30

### Fixed
- Fixed illegal root-level `anyOf` `inputSchema` emitted for tools whose first parameter was an optional object (`params?: IFoo` or `params: IFoo = {}`). The TypeScript checker resolved such parameters to `IFoo | undefined`, and the union branch of the JSON Schema converter produced `{ "anyOf": [ … ] }` at the ROOT — violating the MCP spec (`inputSchema.type === "object"`) and causing strict clients (e.g. Claude Code) to reject the ENTIRE `tools/list` response, hiding every tool of the affected server.
- `extractInputSchema` now strips the `undefined` branch before conversion, uses the single remaining object branch directly, or merges multiple object branches (union of `properties`, intersection of `required`). The root is always normalized to `{ "type": "object", "properties": … }`. Nested unions inside properties are unaffected — only the ROOT is constrained.

### Added
- Added `assertValidMcpInputSchemas(tools)` post-generation validation gate exported from `@codearchitects/mcp-scanner`. `serializeMcpManifest` and the CLI now invoke it: on violation the scan fails with a clear error naming the offending tool and its schema, making the whole bug class impossible to ship silently no matter which conversion path produced it.

## [1.2.2] - 2026-07-08

### Added
- `--tools-path` / `-s` is now repeatable: multiple subtrees can be scanned in a single run. This lets several source subtrees feed one MCP manifest without separate invocations overwriting each other. `scanProject`/`scanProjectForProxies` now accept `string | string[]` for the search path.

## [1.2.1] - 2026-07-07

### Added
- Added `--skip-package-json` / `-k` CLI option to skip patching `package.json`. Useful when only generating proxy files or writing MCP manifests without modifying the package manifest.

## [1.2.0] - 2026-07-07

### Added
- Added a `transports` option (`'lm' | 'mcp'`) to `@ExposeTool`/`@Tool` so a tool can be published as a VS Code Language Model tool, as an MCP tool, or both. Defaults to `['lm']`, preserving existing behavior.
- Added an `mcpServers` option to route tools into one or more **named MCP server groups**, enabling multiple MCP servers within a single project.
- MCP server group resolution now falls back to the CLI `--tools-tag` when a tool declares no `mcpServers`, so tag-scoped scans (`-g <tag>`) route to the matching MCP server without decorator changes. Precedence: `mcpServers` → `--tools-tag` → `default`.
- Added MCP manifest generation: `'mcp'`-targeting tools are written to a fully-generated JSON sidecar (default `.mcp-scanner.mcp.json`), carrying the native MCP `inputSchema`, instead of `package.json`.
- Added CLI options `--mcp-manifest, -m <[name=]path>` (repeatable, binds a server group to its manifest file) and `--default-transport <lm|mcp|both>`.
- Added public API: `writeMcpManifestFile`, `serializeMcpManifest`, `readMcpManifestFile`, `groupMcpToolsByServer`, `mcpServerGroupsOf`, `targetsMcp`, `MCP_MANIFEST_FILE`, `DEFAULT_MCP_SERVER_GROUP`, plus types `IMcpManifest`, `IMcpManifestTool`, `IMcpManifestResult`, `IScanOptions`, `ToolTransport`.
- Added an optional `options` argument to `scanProject` (`defaultTransport`).

### Changed
- `patchPackageJsonContent`/`patchPackageJsonFile` now only write tools targeting the `'lm'` transport into `contributes.languageModelTools`, and strip internal routing fields (`transports`, `mcpServers`) from manifest entries. Tools without `transports` are treated as `'lm'`, so behavior is unchanged for existing projects.
- `registerExposedTools` now registers only tools targeting the `'lm'` transport; `'mcp'`-only tools are skipped.

## [1.1.5] - 2026-05-20

### Fixed
- Changed JSON Schema generation for mixed-type unions (`string | number | boolean`) from `oneOf` to `anyOf`, fixing validation errors when LM tools pass boolean values to primitive union parameters.

## [1.1.4] - 2026-04-30

### Added
- Added `--exclude-path` / `-i` CLI option (repeatable) to exclude one or more folders/subtrees from scanning.
- Applied exclusion filtering consistently to both tool scanning (`scanProject`) and proxy metadata scanning (`scanProjectForProxies`).

### Documentation
- Updated README usage examples and CLI options list to document `--exclude-path`.
- Updated scanner API signature docs to include optional exclusion paths.

## [1.1.3] - 2026-04-29

### Fixed
- Fixed handling of imported interfaces and types, ensuring accurate schema generation even for complex types.

## [1.1.2] - 2026-04-29

### Added
- `scanProject` now recognises `@Tool` decorated methods in addition to `@ExposeTool`, deriving `inputSchema` from the method parameter types using the TypeScript compiler — enabling Library B (proxy) to produce a correct `contributes.languageModelTools` entry with a fully-populated schema.
- `registerExposedTools` now registers methods decorated with `@Tool` alongside `@ExposeTool`, with duplicate-name protection across the same activation.

### Fixed
- Fixed incorrect package name in the generated proxy scaffold: `@Tool` is now imported from `@codearchitects/mcp-scanner` instead of the bare `mcp-scanner` specifier.
- Exported Tool decorator and getTools function

## [1.1.1] - 2026-04-29

### Added
- Added functions to extract and replace module specifiers in import statements.
- Added `@Tool` decorator to store method metadata without exposing proxy methods as tools.

### Changed
- Implemented relative import rewriting for generated proxy files.
- Enhanced proxy generation to include tool metadata in generated methods.
- Updated proxy scaffold template to conditionally emit `@Tool` based on available method metadata.
- Extended runtime LM tool registration to support both `@ExposeTool` and `@Tool` decorated methods.

### Fixed
- Ensured grouped imports retain only symbols actually used by generated proxy method signatures.

## [1.1.0] - 2026-04-29

### Added
- Added `--package-json` / `-j` option to patch a custom `package.json` path (resolved relative to `--project` when needed).
- Added proxy generation capabilities to `mcp-scanner`, including scaffold-based output, marker-driven updates and imports resolution for signature types to auto-import local exported types used by generated methods.
- Added `--scaffold-template` / `-x` to use a custom EJS scaffold template for generated proxy files.
- Added `--tools-path` / `-s` option to restrict scanning to a specific folder/subtree.
- Added `--tools-tag` / `-g` option for tag-scoped patching of generated tools in `contributes.languageModelTools`.
- Added unit and integration test suites covering scanner, patcher, proxy scanner/generator, and CLI flows.
- Added coverage reporting and CI threshold enforcement (`npm run test:coverage`, `npm run test:ci`).
- Added CI workflow for push/pull request validation and publish-time quality checks.

### Documentation
- Expanded and normalized JSDoc coverage across source modules.
- Updated README for new CLI options and generation/patching behavior.

## [1.0.3] - 2026-04-21

### Added
- Initial release baseline.

[1.1.5]: https://github.com/codearchitects/mcp-scanner/releases/tag/v1.1.5
[1.1.4]: https://github.com/codearchitects/mcp-scanner/releases/tag/v1.1.4
[1.1.3]: https://github.com/codearchitects/mcp-scanner/releases/tag/v1.1.3
[1.1.2]: https://github.com/codearchitects/mcp-scanner/releases/tag/v1.1.2
[1.1.1]: https://github.com/codearchitects/mcp-scanner/releases/tag/v1.1.1
[1.1.0]: https://github.com/codearchitects/mcp-scanner/releases/tag/v1.1.0
[1.0.3]: https://github.com/codearchitects/mcp-scanner/releases/tag/v1.0.3
