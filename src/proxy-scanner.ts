import * as path from 'path';
import * as ts from 'typescript';

export interface IProxyParameter {
  name: string;
  typeText: string;
  optional: boolean;
}

export interface IProxyMethod {
  toolName: string;
  methodName: string;
  className: string;
  sourceFilePath: string;
  jsDoc?: string;
  returnTypeText: string;
  parameters: IProxyParameter[];
  importStatements: string[];
  localTypeNames: string[];
}

export interface IProxyScanResult {
  methods: IProxyMethod[];
  filesScanned: number;
  diagnostics: string[];
}

interface IImportBinding {
  moduleSpecifier: string;
  declarationText: string;
}

function isWithinSearchPath(filePath: string, searchPath?: string): boolean {
  if (!searchPath) {
    return true;
  }

  const resolvedFile = path.resolve(filePath);
  const resolvedSearch = path.resolve(searchPath);
  const relative = path.relative(resolvedSearch, resolvedFile);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

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

function normalizeToTypeImport(declarationText: string): string {
  if (declarationText.startsWith('import type ')) {
    return declarationText;
  }

  if (!declarationText.startsWith('import ')) {
    return declarationText;
  }

  return declarationText.replace(/^import\s+/, 'import type ');
}

function collectImportsMap(sourceFile: ts.SourceFile): Map<string, IImportBinding> {
  const imports = new Map<string, IImportBinding>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) {
      continue;
    }

    const moduleSpecifier = ts.isStringLiteral(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text
      : '';

    const declarationText = normalizeToTypeImport(statement.getText(sourceFile));

    if (statement.importClause.name) {
      imports.set(statement.importClause.name.text, { moduleSpecifier, declarationText });
    }

    const namedBindings = statement.importClause.namedBindings;
    if (!namedBindings) {
      continue;
    }

    if (ts.isNamespaceImport(namedBindings)) {
      imports.set(namedBindings.name.text, { moduleSpecifier, declarationText });
      continue;
    }

    for (const element of namedBindings.elements) {
      imports.set(element.name.text, { moduleSpecifier, declarationText });
    }
  }

  return imports;
}

function hasExportModifier(node: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
}

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

function getParameterName(paramName: ts.BindingName, index: number): string {
  if (ts.isIdentifier(paramName)) {
    return paramName.text;
  }

  return `params${index + 1}`;
}

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

function toMethodImportData(
  method: ts.MethodDeclaration,
  importsMap: Map<string, IImportBinding>,
  exportedTypeNames: Set<string>,
): { importStatements: string[]; localTypeNames: string[] } {
  const referenceNames = collectMethodTypeReferenceNames(method);

  const declarationsByModule = new Map<string, string>();
  const localTypeNames = new Set<string>();

  for (const name of referenceNames) {
    const binding = importsMap.get(name);
    if (binding) {
      declarationsByModule.set(binding.moduleSpecifier, binding.declarationText);
      continue;
    }

    if (exportedTypeNames.has(name)) {
      localTypeNames.add(name);
    }
  }

  return {
    importStatements: Array.from(declarationsByModule.values()).sort((a, b) => a.localeCompare(b)),
    localTypeNames: Array.from(localTypeNames).sort((a, b) => a.localeCompare(b)),
  };
}

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
