# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project follows Semantic Versioning.

## [1.1.1]

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

[1.1.1]: https://github.com/codearchitects/mcp-scanner/releases/tag/v1.1.1
[1.1.0]: https://github.com/codearchitects/mcp-scanner/releases/tag/v1.1.0
[1.0.3]: https://github.com/codearchitects/mcp-scanner/releases/tag/v1.0.3
