import * as ejs from 'ejs';
import * as fs from 'fs';
import * as path from 'path';
import type { IProxyMethod } from './proxy-scanner';

/**
 * Directory where bundled template assets are located at runtime.
 */
const TEMPLATES_DIR = path.join(__dirname, 'templates');

/**
 * Fallback class name for generated proxy files.
 */
const DEFAULT_CLASS_NAME = 'GeneratedExposeToolProxies';

/**
 * Marker that bounds auto-generated import statements.
 */
export const IMPORTS_MARKER_START = '// <mcp-scanner:proxy-imports:start>';

/**
 * Marker that bounds auto-generated import statements.
 */
export const IMPORTS_MARKER_END = '// <mcp-scanner:proxy-imports:end>';

/**
 * Marker that bounds auto-generated class declaration line.
 */
export const CLASS_MARKER_START = '// <mcp-scanner:proxy-class:start>';

/**
 * Marker that bounds auto-generated class declaration line.
 */
export const CLASS_MARKER_END = '// <mcp-scanner:proxy-class:end>';

/**
 * Marker that bounds auto-generated method implementations.
 */
export const METHODS_MARKER_START = '// <mcp-scanner:proxy-methods:start>';

/**
 * Marker that bounds auto-generated method implementations.
 */
export const METHODS_MARKER_END = '// <mcp-scanner:proxy-methods:end>';

/**
 * Options for generating or updating a proxy file.
 */
export interface IGenerateProxyFileOptions {
  /**
   * Output path of generated proxy file.
   */
  outputFilePath: string;

  /**
   * Optional class name for generated proxy class.
   */
  className?: string;

  /**
   * Optional custom EJS scaffold template path.
   */
  scaffoldTemplatePath?: string;

  /**
   * Optional source project root used as package fallback.
   */
  sourceProjectRoot?: string;
}

/**
 * Result status for proxy generation.
 */
export interface IGenerateProxyResult {
  /**
   * Whether generation or patching succeeded.
   */
  ok: boolean;

  /**
   * Human-readable generation status.
   */
  message: string;
}

/**
 * Convert a Windows path to POSIX separators.
 *
 * @param value Path string.
 * @returns Normalized POSIX-like path.
 */
function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/');
}

/**
 * Remove TypeScript source extensions from a file path.
 *
 * @param filePath Input file path.
 * @returns Path without `.ts/.tsx/.mts/.cts/.d.ts` extension.
 */
function stripTypeScriptExtension(filePath: string): string {
  return filePath.replace(/\.(d\.)?[cm]?tsx?$/i, '');
}

/**
 * Build relative module specifier from an output file to a source file.
 *
 * @param fromFilePath Generated file path.
 * @param toFilePath Source file path.
 * @returns Relative module specifier.
 */
function toRelativeModuleSpecifier(fromFilePath: string, toFilePath: string): string {
  const fromDir = path.dirname(fromFilePath);
  const relativePath = toPosixPath(path.relative(fromDir, stripTypeScriptExtension(toFilePath)));
  return relativePath.startsWith('.') ? relativePath : `./${relativePath}`;
}

/**
 * Find nearest `package.json` from a path by traversing parents.
 *
 * @param startPath Starting file or folder path.
 * @returns Absolute `package.json` path when found.
 */
function findNearestPackageJson(startPath: string): string | undefined {
  let current = startPath;
  if (!fs.existsSync(current) || !fs.statSync(current).isDirectory()) {
    current = path.dirname(current);
  }

  while (true) {
    const candidate = path.join(current, 'package.json');
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

/**
 * Read package name from a `package.json` file.
 *
 * @param packageJsonPath Optional path to `package.json`.
 * @returns Package name when available and valid.
 */
function tryReadPackageName(packageJsonPath?: string): string | undefined {
  if (!packageJsonPath) {
    return undefined;
  }

  try {
    const raw = fs.readFileSync(packageJsonPath, 'utf-8');
    const json = JSON.parse(raw) as { name?: unknown };
    return typeof json.name === 'string' && json.name.trim().length > 0 ? json.name.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Convert package name into root module specifier.
 *
 * @param packageName Package name.
 * @returns Module specifier rooted at package name.
 */
function toPackageModuleSpecifier(packageName: string): string {
  return packageName;
}

/**
 * Resolve module specifier for local exported types.
 *
 * Uses package import in cross-package scenarios and relative import otherwise.
 *
 * @param outputFilePath Generated proxy file path.
 * @param sourceFilePath Source method file path.
 * @param sourceProjectRoot Optional source root fallback.
 * @returns Module specifier used in `import type` statement.
 */
function resolveLocalTypeModuleSpecifier(
  outputFilePath: string,
  sourceFilePath: string,
  sourceProjectRoot?: string,
): string {
  const outputPackageJson = findNearestPackageJson(outputFilePath);
  const outputPackageRoot = outputPackageJson ? path.dirname(outputPackageJson) : undefined;

  const sourcePackageJson = findNearestPackageJson(sourceFilePath)
    ?? (sourceProjectRoot ? path.join(sourceProjectRoot, 'package.json') : undefined);
  const sourcePackageRoot = sourcePackageJson && fs.existsSync(sourcePackageJson)
    ? path.dirname(sourcePackageJson)
    : undefined;
  const sourcePackageName = tryReadPackageName(sourcePackageJson);

  const isCrossPackage = !!sourcePackageRoot && !!outputPackageRoot
    && path.resolve(sourcePackageRoot) !== path.resolve(outputPackageRoot);

  if (isCrossPackage && sourcePackageName) {
    return toPackageModuleSpecifier(sourcePackageName);
  }

  return toRelativeModuleSpecifier(outputFilePath, sourceFilePath);
}

/**
 * Merge local exported type imports into method import statements.
 *
 * @param methods Scanned proxy methods.
 * @param outputFilePath Generated proxy file path.
 * @param sourceProjectRoot Optional source root fallback.
 * @returns Methods enriched with synthetic local type imports.
 */
function addLocalTypeImports(
  methods: IProxyMethod[],
  outputFilePath: string,
  sourceProjectRoot?: string,
): IProxyMethod[] {
  const localImportsBySource = new Map<string, string>();

  for (const method of methods) {
    if (!method.localTypeNames || method.localTypeNames.length === 0) {
      continue;
    }

    if (!localImportsBySource.has(method.sourceFilePath)) {
      const typeNames = Array.from(
        new Set(
          methods
            .filter((candidate) => candidate.sourceFilePath === method.sourceFilePath)
            .flatMap((candidate) => candidate.localTypeNames ?? []),
        ),
      ).sort((a, b) => a.localeCompare(b));

      if (typeNames.length > 0) {
        const moduleSpecifier = resolveLocalTypeModuleSpecifier(
          outputFilePath,
          method.sourceFilePath,
          sourceProjectRoot,
        );
        localImportsBySource.set(
          method.sourceFilePath,
          `import type { ${typeNames.join(', ')} } from '${moduleSpecifier}';`,
        );
      }
    }
  }

  return methods.map((method) => {
    const localImport = localImportsBySource.get(method.sourceFilePath);
    if (!localImport) {
      return method;
    }

    const importStatements = Array.from(new Set([...method.importStatements, localImport]))
      .sort((a, b) => a.localeCompare(b));

    return {
      ...method,
      importStatements,
    };
  });
}

/**
 * Replace content between two marker lines.
 *
 * @param content Full document content.
 * @param startMarker Start marker text.
 * @param endMarker End marker text.
 * @param replacement Replacement content.
 * @returns Updated content with marker region replaced.
 */
function replaceBetweenMarkers(
  content: string,
  startMarker: string,
  endMarker: string,
  replacement: string,
): string {
  const startIndex = content.indexOf(startMarker);
  const endIndex = content.indexOf(endMarker);

  if (startIndex === -1 || endIndex === -1) {
    throw new Error(`Missing markers: ${startMarker} / ${endMarker}`);
  }

  if (endIndex < startIndex) {
    throw new Error(`Invalid marker order: ${startMarker} before ${endMarker}`);
  }

  const before = content.slice(0, startIndex + startMarker.length);
  const after = content.slice(endIndex);
  const normalizedReplacement = replacement.trim().length > 0
    ? `\n${replacement.trim()}\n`
    : '\n';

  return `${before}${normalizedReplacement}${after}`;
}

/**
 * Extract content between two marker lines.
 *
 * @param content Full document content.
 * @param startMarker Start marker text.
 * @param endMarker End marker text.
 * @returns Trimmed content between markers.
 */
function extractBetweenMarkers(
  content: string,
  startMarker: string,
  endMarker: string,
): string {
  const startIndex = content.indexOf(startMarker);
  const endIndex = content.indexOf(endMarker);

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error(`Template missing or invalid markers: ${startMarker} / ${endMarker}`);
  }

  const sectionStart = startIndex + startMarker.length;
  return content.slice(sectionStart, endIndex).trim();
}

/**
 * Generate or update a proxy file from scanned methods.
 *
 * @param methods Scanned methods.
 * @param options Generation options.
 * @returns Generation result.
 */
export function generateProxyFile(methods: IProxyMethod[], options: IGenerateProxyFileOptions): IGenerateProxyResult {
  const className = options.className?.trim() || DEFAULT_CLASS_NAME;
  const methodsWithImports = addLocalTypeImports(methods, options.outputFilePath, options.sourceProjectRoot);
  const scaffoldTemplate = options.scaffoldTemplatePath
    ? fs.readFileSync(options.scaffoldTemplatePath, 'utf-8')
    : getDefaultScaffoldTemplateContent();

  if (!scaffoldTemplate) {
    return {
      ok: false,
      message: 'Default scaffold template not found in package.',
    };
  }

  const rendered = renderProxyFileFromScaffoldTemplate(methodsWithImports, scaffoldTemplate, className);
  const outputDir = path.dirname(options.outputFilePath);
  fs.mkdirSync(outputDir, { recursive: true });

  if (!fs.existsSync(options.outputFilePath)) {
    fs.writeFileSync(options.outputFilePath, rendered, 'utf-8');
    return {
      ok: true,
      message: `Created new proxy file with injection markers: ${options.outputFilePath}`,
    };
  }

  const existing = fs.readFileSync(options.outputFilePath, 'utf-8');
  if (!existing.includes(METHODS_MARKER_START) || !existing.includes(METHODS_MARKER_END)) {
    return {
      ok: false,
      message: `Existing file must define method injection markers (${METHODS_MARKER_START} / ${METHODS_MARKER_END}) to avoid full overwrite.`,
    };
  }

  let next = existing;
  try {
    const renderedImports = extractBetweenMarkers(rendered, IMPORTS_MARKER_START, IMPORTS_MARKER_END);
    const renderedClass = extractBetweenMarkers(rendered, CLASS_MARKER_START, CLASS_MARKER_END);
    const renderedMethods = extractBetweenMarkers(rendered, METHODS_MARKER_START, METHODS_MARKER_END);

    if (existing.includes(IMPORTS_MARKER_START) && existing.includes(IMPORTS_MARKER_END)) {
      next = replaceBetweenMarkers(next, IMPORTS_MARKER_START, IMPORTS_MARKER_END, renderedImports);
    }
    if (existing.includes(CLASS_MARKER_START) && existing.includes(CLASS_MARKER_END)) {
      next = replaceBetweenMarkers(next, CLASS_MARKER_START, CLASS_MARKER_END, renderedClass);
    }
    next = replaceBetweenMarkers(next, METHODS_MARKER_START, METHODS_MARKER_END, renderedMethods);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message };
  }

  fs.writeFileSync(options.outputFilePath, next, 'utf-8');
  return {
    ok: true,
    message: `Updated injection zones in ${options.outputFilePath}`,
  };
}

/**
 * Get bundled default scaffold template content.
 *
 * @returns Scaffold template text or empty string when missing.
 */
export function getDefaultScaffoldTemplateContent(): string {
  const templatePath = path.join(TEMPLATES_DIR, 'proxy-scaffold.ejs');
  if (fs.existsSync(templatePath)) {
    return fs.readFileSync(templatePath, 'utf-8');
  }
  return '';
}

/**
 * Copy bundled default scaffold template to a local file.
 *
 * @param outputPath Destination path.
 * @returns Nothing.
 */
export function copyDefaultScaffoldTemplateToLocal(outputPath: string): void {
  const templateContent = getDefaultScaffoldTemplateContent();
  if (!templateContent) {
    throw new Error('Default scaffold template not found in package.');
  }
  const outputDir = path.dirname(outputPath);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, templateContent, 'utf-8');
}

/**
 * EJS context used by the scaffold renderer.
 */
interface IProxyScaffoldRenderContext {
  /**
   * Class name rendered into scaffold.
   */
  className: string;

  /**
   * Method metadata rendered into scaffold loops.
   */
  methods: Array<{
    /**
     * Decorator tool name.
     */
    toolName: string;

    /**
     * Method name.
     */
    methodName: string;

    /**
     * Return type text.
     */
    returnTypeText: string;

    /**
     * Optional original method JSDoc.
     */
    jsDoc?: string;

    /**
     * Parameter descriptors for rendering method signature.
     */
    parameters: Array<{ name: string; typeText: string; optional: boolean }>;

    /**
     * Convenience field for generated bridge TODO block.
     */
    firstParameterName?: string;

    /**
     * Import statements required by this method.
     */
    importStatements: string[];
  }>;
}

/**
 * Render a scaffold template using scanned method metadata.
 *
 * @param methods Methods to render.
 * @param scaffoldTemplate EJS scaffold content.
 * @param className Class name to render.
 * @returns Rendered TypeScript file content.
 */
export function renderProxyFileFromScaffoldTemplate(
  methods: IProxyMethod[],
  scaffoldTemplate: string,
  className: string,
): string {
  const ctx: IProxyScaffoldRenderContext = {
    className,
    methods: methods.map((method) => ({
      toolName: method.toolName,
      methodName: method.methodName,
      returnTypeText: method.returnTypeText,
      jsDoc: method.jsDoc,
      parameters: method.parameters,
      firstParameterName: method.parameters[0]?.name,
      importStatements: method.importStatements,
    })),
  };

  return ejs.render(scaffoldTemplate, ctx, { rmWhitespace: false });
}
