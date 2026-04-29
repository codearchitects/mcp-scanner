import * as ejs from 'ejs';
import * as fs from 'fs';
import * as path from 'path';
import type { IProxyMethod } from './proxy-scanner';

const TEMPLATES_DIR = path.join(__dirname, 'templates');
const DEFAULT_CLASS_NAME = 'GeneratedExposeToolProxies';
export const IMPORTS_MARKER_START = '// <mcp-scanner:proxy-imports:start>';
export const IMPORTS_MARKER_END = '// <mcp-scanner:proxy-imports:end>';
export const CLASS_MARKER_START = '// <mcp-scanner:proxy-class:start>';
export const CLASS_MARKER_END = '// <mcp-scanner:proxy-class:end>';
export const METHODS_MARKER_START = '// <mcp-scanner:proxy-methods:start>';
export const METHODS_MARKER_END = '// <mcp-scanner:proxy-methods:end>';

export interface IGenerateProxyFileOptions {
  outputFilePath: string;
  className?: string;
  scaffoldTemplatePath?: string;
  sourceProjectRoot?: string;
}

export interface IGenerateProxyResult {
  ok: boolean;
  message: string;
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/');
}

function stripTypeScriptExtension(filePath: string): string {
  return filePath.replace(/\.(d\.)?[cm]?tsx?$/i, '');
}

function toRelativeModuleSpecifier(fromFilePath: string, toFilePath: string): string {
  const fromDir = path.dirname(fromFilePath);
  const relativePath = toPosixPath(path.relative(fromDir, stripTypeScriptExtension(toFilePath)));
  return relativePath.startsWith('.') ? relativePath : `./${relativePath}`;
}

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

function toPackageModuleSpecifier(packageName: string): string {
  return packageName;
}

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

export function getDefaultScaffoldTemplateContent(): string {
  const templatePath = path.join(TEMPLATES_DIR, 'proxy-scaffold.ejs');
  if (fs.existsSync(templatePath)) {
    return fs.readFileSync(templatePath, 'utf-8');
  }
  return '';
}

export function copyDefaultScaffoldTemplateToLocal(outputPath: string): void {
  const templateContent = getDefaultScaffoldTemplateContent();
  if (!templateContent) {
    throw new Error('Default scaffold template not found in package.');
  }
  const outputDir = path.dirname(outputPath);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, templateContent, 'utf-8');
}

interface IProxyScaffoldRenderContext {
  className: string;
  methods: Array<{
    toolName: string;
    methodName: string;
    returnTypeText: string;
    jsDoc?: string;
    parameters: Array<{ name: string; typeText: string; optional: boolean }>;
    firstParameterName?: string;
    importStatements: string[];
  }>;
}

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
