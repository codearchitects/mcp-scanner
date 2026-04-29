import * as path from 'path';
import * as ts from 'typescript';

/**
 * Proxy method parameter metadata.
 */
export interface IProxyParameter {
  /**
   * Parameter name as used in generated signature.
   */
  name: string;

  /**
   * Textual TypeScript type for the parameter.
   */
  typeText: string;

  /**
   * Whether parameter is optional.
   */
  optional: boolean;
}

/**
 * Proxy-capable method metadata extracted from source.
 */
export interface IProxyMethod {
  /**
   * Tool name declared in `@ExposeTool({ name })`.
   */
  toolName: string;

  /**
   * Source method name.
   */
  methodName: string;

  /**
   * Source class name.
   */
  className: string;

  /**
   * Absolute path to source file containing the method.
   */
  sourceFilePath: string;

  /**
   * Optional raw JSDoc block extracted from source method.
   */
  jsDoc?: string;

  /**
   * Return type text extracted from source method.
   */
  returnTypeText: string;

  /**
   * Parameter metadata extracted from source method.
   */
  parameters: IProxyParameter[];

  /**
   * Import statements required by method signature.
   */
  importStatements: string[];

  /**
   * Locally exported type names referenced by method signature.
   */
  localTypeNames: string[];
}

/**
 * Proxy scanner result payload.
 */
export interface IProxyScanResult {
  /**
   * Methods discovered for proxy generation.
   */
  methods: IProxyMethod[];

  /**
   * Number of source files actually scanned.
   */
  filesScanned: number;

  /**
   * Diagnostics produced during proxy scanning.
   */
  diagnostics: string[];
}

/**
 * Internal mapping for imported type bindings.
 */
interface IImportBinding {
  /**
   * Import module specifier.
   */
  moduleSpecifier: string;

  /**
   * Import style for this binding.
   */
  kind: 'default' | 'named' | 'namespace';

  /**
   * Imported symbol name from module.
   */
  importedName?: string;

  /**
   * Local symbol name used in source file.
   */
  localName: string;
}

/**
 * Check whether file is under optional search subtree.
 *
 * @param filePath Candidate file path.
 * @param searchPath Optional subtree root.
 * @returns `true` when file should be scanned.
 */
function isWithinSearchPath(filePath: string, searchPath?: string): boolean {
  if (!searchPath) {
    return true;
  }

  const resolvedFile = path.resolve(filePath);
  const resolvedSearch = path.resolve(searchPath);
  const relative = path.relative(resolvedSearch, resolvedFile);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Extract `@ExposeTool({...})` options object from a decorator.
 *
 * @param decorator Decorator AST node.
 * @returns Options object literal when decorator is `ExposeTool`.
 */
function getExposeToolArgs(decorator: ts.Decorator): ts.ObjectLiteralExpression | undefined {
  if (!ts.isCallExpression(decorator.expression)) {
    return undefined;
  }

  const expression = decorator.expression.expression;
  if (!ts.isIdentifier(expression) || expression.text !== 'ExposeTool') {
    return undefined;
  }

  const firstArg = decorator.expression.arguments[0];
  return firstArg && ts.isObjectLiteralExpression(firstArg) ? firstArg : undefined;
}

/**
 * Read string property from object literal.
 *
 * @param obj Object literal expression.
 * @param name Property name.
 * @returns String property value when found.
 */
function getStringProperty(obj: ts.ObjectLiteralExpression, name: string): string | undefined {
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name) || prop.name.text !== name) {
      continue;
    }

    if (ts.isStringLiteral(prop.initializer)) {
      return prop.initializer.text;
    }
  }

  return undefined;
}

/**
 * Extract nearest JSDoc block preceding a method.
 *
 * @param sourceFile Source file containing method.
 * @param method Method declaration.
 * @returns Raw JSDoc text when available.
 */
function getMethodJsDoc(sourceFile: ts.SourceFile, method: ts.MethodDeclaration): string | undefined {
  const ranges = ts.getLeadingCommentRanges(sourceFile.getFullText(), method.getFullStart()) ?? [];
  for (let i = ranges.length - 1; i >= 0; i--) {
    const range = ranges[i];
    const text = sourceFile.getFullText().slice(range.pos, range.end).trim();
    if (text.startsWith('/**')) {
      return text;
    }
  }
  return undefined;
}

/**
 * Collect referenced type names from a type node tree.
 *
 * @param typeNode Root type node.
 * @param names Set receiving discovered type names.
 */
function collectTypeReferenceNames(typeNode: ts.TypeNode, names: Set<string>): void {
  const visit = (node: ts.Node): void => {
    if (ts.isTypeReferenceNode(node)) {
      const typeName = node.typeName;
      if (ts.isIdentifier(typeName)) {
        names.add(typeName.text);
      } else if (ts.isQualifiedName(typeName)) {
        let left: ts.EntityName = typeName;
        while (ts.isQualifiedName(left)) {
          left = left.left;
        }
        if (ts.isIdentifier(left)) {
          names.add(left.text);
        }
      }
    }

    if (ts.isExpressionWithTypeArguments(node) && ts.isIdentifier(node.expression)) {
      names.add(node.expression.text);
    }

    if (ts.isImportTypeNode(node) && node.qualifier && ts.isIdentifier(node.qualifier)) {
      names.add(node.qualifier.text);
    }

    ts.forEachChild(node, visit);
  };

  visit(typeNode);
}

/**
 * Convert import declaration text to `import type` form.
 *
 * @param declarationText Original import text.
 * @returns Type-only import text where applicable.
 */
function normalizeToTypeImport(declarationText: string): string {
  if (declarationText.startsWith('import type ')) {
    return declarationText;
  }

  if (!declarationText.startsWith('import ')) {
    return declarationText;
  }

  return declarationText.replace(/^import\s+/, 'import type ');
}

/**
 * Build map of imported identifiers to their declaration text.
 *
 * @param sourceFile Source file to inspect.
 * @returns Map from identifier to import binding details.
 */
function collectImportsMap(sourceFile: ts.SourceFile): Map<string, IImportBinding> {
  const imports = new Map<string, IImportBinding>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) {
      continue;
    }

    const moduleSpecifier = ts.isStringLiteral(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text
      : '';

    if (statement.importClause.name) {
      imports.set(statement.importClause.name.text, {
        moduleSpecifier,
        kind: 'default',
        localName: statement.importClause.name.text,
      });
    }

    const namedBindings = statement.importClause.namedBindings;
    if (!namedBindings) {
      continue;
    }

    if (ts.isNamespaceImport(namedBindings)) {
      imports.set(namedBindings.name.text, {
        moduleSpecifier,
        kind: 'namespace',
        localName: namedBindings.name.text,
      });
      continue;
    }

    for (const element of namedBindings.elements) {
      imports.set(element.name.text, {
        moduleSpecifier,
        kind: 'named',
        importedName: element.propertyName?.text ?? element.name.text,
        localName: element.name.text,
      });
    }
  }

  return imports;
}

/**
 * Build minimal import statements from referenced bindings.
 *
 * @param bindings Bindings used by method signature.
 * @returns Type-only import statements containing only used symbols.
 */
function toImportStatements(bindings: IImportBinding[]): string[] {
  const byModule = new Map<string, IImportBinding[]>();

  for (const binding of bindings) {
    const list = byModule.get(binding.moduleSpecifier) ?? [];
    list.push(binding);
    byModule.set(binding.moduleSpecifier, list);
  }

  const statements: string[] = [];

  for (const [moduleSpecifier, moduleBindings] of byModule) {
    const defaultImport = moduleBindings.find((binding) => binding.kind === 'default')?.localName;
    const namespaceImport = moduleBindings.find((binding) => binding.kind === 'namespace')?.localName;
    const namedBindings = moduleBindings
      .filter((binding): binding is IImportBinding & { kind: 'named'; importedName: string } =>
        binding.kind === 'named' && typeof binding.importedName === 'string',
      )
      .sort((a, b) => a.localName.localeCompare(b.localName));

    if (namespaceImport) {
      statements.push(`import type * as ${namespaceImport} from '${moduleSpecifier}';`);
      continue;
    }

    const namedClause = namedBindings.length > 0
      ? `{ ${namedBindings.map((binding) => (
        binding.importedName === binding.localName
          ? binding.importedName
          : `${binding.importedName} as ${binding.localName}`
      )).join(', ')} }`
      : '';

    if (defaultImport && namedClause) {
      statements.push(`import type ${defaultImport}, ${namedClause} from '${moduleSpecifier}';`);
      continue;
    }

    if (defaultImport) {
      statements.push(`import type ${defaultImport} from '${moduleSpecifier}';`);
      continue;
    }

    if (namedClause) {
      statements.push(`import type ${namedClause} from '${moduleSpecifier}';`);
    }
  }

  return statements.sort((a, b) => a.localeCompare(b));
}

/**
 * Check whether declaration carries `export` modifier.
 *
 * @param node Declaration node.
 * @returns `true` if declaration is exported.
 */
function hasExportModifier(node: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
}

/**
 * Collect exported type names declared in a source file.
 *
 * @param sourceFile Source file to inspect.
 * @returns Set of exported interface/type/enum/class names.
 */
function collectExportedTypeNames(sourceFile: ts.SourceFile): Set<string> {
  const exported = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (!hasExportModifier(statement)) {
      continue;
    }

    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) {
      exported.add(statement.name.text);
      continue;
    }

    if (ts.isClassDeclaration(statement) && statement.name) {
      exported.add(statement.name.text);
    }
  }

  return exported;
}

/**
 * Resolve generated parameter name from binding syntax.
 *
 * @param paramName Parameter binding name.
 * @param index Parameter index.
 * @returns Identifier name or synthetic fallback.
 */
function getParameterName(paramName: ts.BindingName, index: number): string {
  if (ts.isIdentifier(paramName)) {
    return paramName.text;
  }

  return `params${index + 1}`;
}

/**
 * Convert method parameters into proxy parameter metadata.
 *
 * @param method Method declaration.
 * @param sourceFile Source file for text extraction.
 * @returns Proxy parameter descriptors.
 */
function toProxyParameter(method: ts.MethodDeclaration, sourceFile: ts.SourceFile): IProxyParameter[] {
  const output: IProxyParameter[] = [];

  for (let i = 0; i < method.parameters.length; i++) {
    const param = method.parameters[i];
    output.push({
      name: getParameterName(param.name, i),
      typeText: param.type ? param.type.getText(sourceFile) : 'unknown',
      optional: !!param.questionToken || !!param.initializer,
    });
  }

  return output;
}

/**
 * Collect all referenced type names used by method signature.
 *
 * @param method Method declaration.
 * @returns Referenced type names.
 */
function collectMethodTypeReferenceNames(method: ts.MethodDeclaration): Set<string> {
  const referenceNames = new Set<string>();

  for (const param of method.parameters) {
    if (param.type) {
      collectTypeReferenceNames(param.type, referenceNames);
    }
  }

  if (method.type) {
    collectTypeReferenceNames(method.type, referenceNames);
  }

  return referenceNames;
}

/**
 * Build import data for a method signature.
 *
 * @param method Method declaration.
 * @param importsMap Imported identifiers map.
 * @param exportedTypeNames Locally exported type names.
 * @returns Import statements and local type references.
 */
function toMethodImportData(
  method: ts.MethodDeclaration,
  importsMap: Map<string, IImportBinding>,
  exportedTypeNames: Set<string>,
): { importStatements: string[]; localTypeNames: string[] } {
  const referenceNames = collectMethodTypeReferenceNames(method);

  const usedBindings = new Map<string, IImportBinding>();
  const localTypeNames = new Set<string>();

  for (const name of referenceNames) {
    const binding = importsMap.get(name);
    if (binding) {
      usedBindings.set(`${binding.moduleSpecifier}:${binding.kind}:${binding.localName}`, binding);
      continue;
    }

    if (exportedTypeNames.has(name)) {
      localTypeNames.add(name);
    }
  }

  return {
    importStatements: toImportStatements(Array.from(usedBindings.values())),
    localTypeNames: Array.from(localTypeNames).sort((a, b) => a.localeCompare(b)),
  };
}

/**
 * Scan project sources and extract proxy metadata for `@ExposeTool` methods.
 *
 * @param projectRoot Project root folder.
 * @param tsconfigFileName Tsconfig file name.
 * @param toolsSearchPath Optional subtree filter.
 * @returns Proxy scan result.
 */
export function scanProjectForProxies(
  projectRoot: string,
  tsconfigFileName = 'tsconfig.json',
  toolsSearchPath?: string,
): IProxyScanResult {
  const diagnostics: string[] = [];
  const methods: IProxyMethod[] = [];

  const configPath = ts.findConfigFile(projectRoot, ts.sys.fileExists, tsconfigFileName);
  if (!configPath) {
    diagnostics.push(`Could not find ${tsconfigFileName} in ${projectRoot}`);
    return { methods, filesScanned: 0, diagnostics };
  }

  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    diagnostics.push(`Error reading ${configPath}: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n')}`);
    return { methods, filesScanned: 0, diagnostics };
  }

  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath));
  const program = ts.createProgram(parsed.fileNames, parsed.options);

  let filesScanned = 0;

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile || sourceFile.fileName.includes('node_modules')) {
      continue;
    }
    if (!isWithinSearchPath(sourceFile.fileName, toolsSearchPath)) {
      continue;
    }

    filesScanned++;
    const importsMap = collectImportsMap(sourceFile);
    const exportedTypeNames = collectExportedTypeNames(sourceFile);

    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node)) {
        const className = node.name?.getText(sourceFile) ?? '<anonymous>';

        for (const member of node.members) {
          if (!ts.isMethodDeclaration(member)) {
            continue;
          }

          const decorators = ts.getDecorators(member);
          if (!decorators) {
            continue;
          }

          for (const decorator of decorators) {
            const argsObj = getExposeToolArgs(decorator);
            if (!argsObj) {
              continue;
            }

            const toolName = getStringProperty(argsObj, 'name');
            if (!toolName) {
              const methodName = member.name?.getText(sourceFile) ?? '<unknown>';
              diagnostics.push(
                `@ExposeTool on ${className}.${methodName}: missing required property 'name'.`,
              );
              continue;
            }

            const methodName = member.name?.getText(sourceFile) ?? 'unnamedMethod';
            const returnTypeText = member.type ? member.type.getText(sourceFile) : 'Promise<unknown>';
            const methodImportData = toMethodImportData(member, importsMap, exportedTypeNames);

            methods.push({
              toolName,
              methodName,
              className,
              sourceFilePath: sourceFile.fileName,
              jsDoc: getMethodJsDoc(sourceFile, member),
              returnTypeText,
              parameters: toProxyParameter(member, sourceFile),
              importStatements: methodImportData.importStatements,
              localTypeNames: methodImportData.localTypeNames,
            });
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(sourceFile, visit);
  }

  return { methods, filesScanned, diagnostics };
}
