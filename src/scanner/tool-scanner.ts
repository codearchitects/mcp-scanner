/* ------------------------------------------------------------------ */
/*  Tool Scanner                                                       */
/*                                                                     */
/*  Parses TypeScript source files with the TS Compiler API,           */
/*  finds methods decorated with @ExposeTool, extracts their           */
/*  parameter interface and produces VS Code languageModelTools JSON.  */
/* ------------------------------------------------------------------ */

import * as path from 'path';
import * as ts from 'typescript';

/* ------------------------------------------------------------------ */
/*  Public types                                                       */
/* ------------------------------------------------------------------ */

/**
 * A single tool definition ready to be written into
 * `contributes.languageModelTools` in package.json.
 */
export interface IScannedTool {
  name: string;
  displayName: string;
  modelDescription: string;
  canBeReferencedInPrompt: boolean;
  toolReferenceName: string;
  icon: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Result returned by {@link scanProject}.
 */
export interface IScanResult {
  /** All tools discovered across the project source files. */
  tools: IScannedTool[];
  /** Source files that were scanned. */
  filesScanned: number;
  /** Diagnostics / warnings encountered during scanning. */
  diagnostics: string[];
}

/* ------------------------------------------------------------------ */
/*  JSON Schema helpers                                                */
/* ------------------------------------------------------------------ */

/**
 * Convert a TypeScript type node into a JSON Schema fragment.
 * Handles primitives, arrays, literal types, unions, and interfaces/type-literals.
 */
function typeNodeToJsonSchema(
  typeNode: ts.TypeNode,
  checker: ts.TypeChecker,
  visited: Set<string> = new Set(),
): Record<string, unknown> {
  // --- TypeReference (interface name, type alias, generic) ---
  if (ts.isTypeReferenceNode(typeNode)) {
    const typeName = typeNode.typeName.getText();

    // Handle Array<T> generic syntax → JSON Schema { type: 'array', items: ... }
    if (typeName === 'Array' && typeNode.typeArguments && typeNode.typeArguments.length === 1) {
      return {
        type: 'array',
        items: typeNodeToJsonSchema(typeNode.typeArguments[0], checker, visited),
      };
    }

    // Avoid infinite recursion on circular types
    if (visited.has(typeName)) {
      return { type: 'object' };
    }
    visited.add(typeName);

    const symbol = checker.getSymbolAtLocation(typeNode.typeName);
    if (symbol) {
      const decl = symbol.declarations?.[0];
      if (decl && ts.isInterfaceDeclaration(decl)) {
        return interfaceDeclToSchema(decl, checker, visited);
      }
      if (decl && ts.isTypeAliasDeclaration(decl) && decl.type) {
        return typeNodeToJsonSchema(decl.type, checker, visited);
      }
    }

    // Fallback for common built-in types
    if (typeName === 'Record') {
      return { type: 'object' };
    }
    return { type: 'object' };
  }

  // --- Primitives ---
  if (typeNode.kind === ts.SyntaxKind.StringKeyword) {
    return { type: 'string' };
  }
  if (typeNode.kind === ts.SyntaxKind.NumberKeyword) {
    return { type: 'number' };
  }
  if (typeNode.kind === ts.SyntaxKind.BooleanKeyword) {
    return { type: 'boolean' };
  }

  // --- Array<T> or T[] ---
  if (ts.isArrayTypeNode(typeNode)) {
    return {
      type: 'array',
      items: typeNodeToJsonSchema(typeNode.elementType, checker, visited),
    };
  }

  // --- Union type (A | B) ---
  if (ts.isUnionTypeNode(typeNode)) {
    // Check if all members are literal strings -> produce enum
    const allStringLiterals = typeNode.types.every(
      (t) => ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal),
    );
    if (allStringLiterals) {
      return {
        type: 'string',
        enum: typeNode.types.map((t) => ((t as ts.LiteralTypeNode).literal as ts.StringLiteral).text),
      };
    }
    return {
      oneOf: typeNode.types.map((t) => typeNodeToJsonSchema(t, checker, visited)),
    };
  }

  // --- Literal types ---
  if (ts.isLiteralTypeNode(typeNode)) {
    if (ts.isStringLiteral(typeNode.literal)) {
      return { type: 'string', enum: [typeNode.literal.text] };
    }
    if (ts.isNumericLiteral(typeNode.literal)) {
      return { type: 'number', enum: [Number(typeNode.literal.text)] };
    }
    if (typeNode.literal.kind === ts.SyntaxKind.TrueKeyword || typeNode.literal.kind === ts.SyntaxKind.FalseKeyword) {
      return { type: 'boolean' };
    }
  }

  // --- Inline object type { foo: string; bar: number } ---
  if (ts.isTypeLiteralNode(typeNode)) {
    return typeLiteralToSchema(typeNode, checker, visited);
  }

  // Fallback
  return { type: 'object' };
}

/**
 * Convert an interface declaration to a JSON Schema object.
 */
function interfaceDeclToSchema(
  decl: ts.InterfaceDeclaration,
  checker: ts.TypeChecker,
  visited: Set<string>,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const member of decl.members) {
    if (ts.isPropertySignature(member) && member.name) {
      const propName = member.name.getText();
      const isOptional = !!member.questionToken;
      const propSchema: Record<string, unknown> = member.type
        ? typeNodeToJsonSchema(member.type, checker, visited)
        : { type: 'object' };

      // Extract JSDoc description
      const jsDocComment = getJsDocDescription(member);
      if (jsDocComment) {
        propSchema['description'] = jsDocComment;
      }

      properties[propName] = propSchema;
      if (!isOptional) {
        required.push(propName);
      }
    }
  }

  const schema: Record<string, unknown> = { type: 'object', properties };
  if (required.length > 0) {
    schema['required'] = required;
  }
  return schema;
}

/**
 * Convert an inline type literal to a JSON Schema object.
 */
function typeLiteralToSchema(
  node: ts.TypeLiteralNode,
  checker: ts.TypeChecker,
  visited: Set<string>,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const member of node.members) {
    if (ts.isPropertySignature(member) && member.name) {
      const propName = member.name.getText();
      const isOptional = !!member.questionToken;
      const propSchema: Record<string, unknown> = member.type
        ? typeNodeToJsonSchema(member.type, checker, visited)
        : { type: 'object' };

      const jsDocComment = getJsDocDescription(member);
      if (jsDocComment) {
        propSchema['description'] = jsDocComment;
      }

      properties[propName] = propSchema;
      if (!isOptional) {
        required.push(propName);
      }
    }
  }

  const schema: Record<string, unknown> = { type: 'object', properties };
  if (required.length > 0) {
    schema['required'] = required;
  }
  return schema;
}

/* ------------------------------------------------------------------ */
/*  JSDoc extraction                                                   */
/* ------------------------------------------------------------------ */

function getJsDocDescription(node: ts.Node): string | undefined {
  const jsDocs = (node as any).jsDoc as ts.JSDoc[] | undefined;
  if (!jsDocs || jsDocs.length === 0) {
    return undefined;
  }
  const comment = jsDocs[0].comment;
  if (typeof comment === 'string') {
    return comment;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/*  Decorator detection                                                */
/* ------------------------------------------------------------------ */

/**
 * Check whether a decorator call is `@ExposeTool(...)` and extract the options object literal.
 */
function getExposeToolArgs(decorator: ts.Decorator): ts.ObjectLiteralExpression | undefined {
  if (!ts.isCallExpression(decorator.expression)) {
    return undefined;
  }
  const expr = decorator.expression.expression;
  const name = ts.isIdentifier(expr) ? expr.text : undefined;
  if (name !== 'ExposeTool') {
    return undefined;
  }
  const firstArg = decorator.expression.arguments[0];
  if (firstArg && ts.isObjectLiteralExpression(firstArg)) {
    return firstArg;
  }
  return undefined;
}

/**
 * Extract a string property from an object literal expression.
 */
function getStringProperty(obj: ts.ObjectLiteralExpression, name: string): string | undefined {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && prop.name && ts.isIdentifier(prop.name) && prop.name.text === name) {
      if (ts.isStringLiteral(prop.initializer)) {
        return prop.initializer.text;
      }
    }
  }
  return undefined;
}

/**
 * Extract a boolean property from an object literal expression.
 */
function getBooleanProperty(obj: ts.ObjectLiteralExpression, name: string): boolean | undefined {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && prop.name && ts.isIdentifier(prop.name) && prop.name.text === name) {
      if (prop.initializer.kind === ts.SyntaxKind.TrueKeyword) {
        return true;
      }
      if (prop.initializer.kind === ts.SyntaxKind.FalseKeyword) {
        return false;
      }
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/*  Parameter type extraction                                          */
/* ------------------------------------------------------------------ */

/**
 * Given a method declaration, find its first parameter's type node and
 * produce a JSON Schema from it.
 */
function extractInputSchema(
  method: ts.MethodDeclaration,
  checker: ts.TypeChecker,
): Record<string, unknown> {
  const firstParam = method.parameters[0];
  if (!firstParam || !firstParam.type) {
    return { type: 'object', properties: {} };
  }
  return typeNodeToJsonSchema(firstParam.type, checker);
}

/* ------------------------------------------------------------------ */
/*  Main scanner                                                       */
/* ------------------------------------------------------------------ */

/**
 * Scan a TypeScript project for `@ExposeTool` decorated methods.
 *
 * @param projectRoot Absolute path to the project root (where tsconfig.json lives).
 * @param tsconfigFileName Optional tsconfig file name. Defaults to `tsconfig.json`.
 * @returns Discovered tools + diagnostics.
 */
export function scanProject(projectRoot: string, tsconfigFileName = 'tsconfig.json'): IScanResult {
  const diagnostics: string[] = [];
  const tools: IScannedTool[] = [];

  const configPath = ts.findConfigFile(projectRoot, ts.sys.fileExists, tsconfigFileName);
  if (!configPath) {
    diagnostics.push(`Could not find ${tsconfigFileName} in ${projectRoot}`);
    return { tools, filesScanned: 0, diagnostics };
  }

  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    diagnostics.push(`Error reading ${configPath}: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n')}`);
    return { tools, filesScanned: 0, diagnostics };
  }

  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath));
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();

  let filesScanned = 0;

  for (const sourceFile of program.getSourceFiles()) {
    // Skip node_modules and declaration files
    if (sourceFile.isDeclarationFile) {
      continue;
    }
    if (sourceFile.fileName.includes('node_modules')) {
      continue;
    }

    filesScanned++;
    ts.forEachChild(sourceFile, (node) => visitNode(node, checker, tools, diagnostics));
  }

  return { tools, filesScanned, diagnostics };
}

/**
 * Recursively visit AST nodes looking for class declarations with
 * `@ExposeTool` decorated methods.
 */
function visitNode(
  node: ts.Node,
  checker: ts.TypeChecker,
  tools: IScannedTool[],
  diagnostics: string[],
): void {
  if (ts.isClassDeclaration(node)) {
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

        const name = getStringProperty(argsObj, 'name');
        const displayName = getStringProperty(argsObj, 'displayName');
        const modelDescription = getStringProperty(argsObj, 'modelDescription');

        if (!name || !displayName || !modelDescription) {
          const className = node.name?.getText() ?? '<anonymous>';
          const methodName = member.name?.getText() ?? '<unknown>';
          diagnostics.push(
            `@ExposeTool on ${className}.${methodName}: missing required property (name, displayName, or modelDescription).`,
          );
          continue;
        }

        const icon = getStringProperty(argsObj, 'icon') ?? '$(tools)';
        const canBeReferencedInPrompt = getBooleanProperty(argsObj, 'canBeReferencedInPrompt') ?? true;
        const inputSchema = extractInputSchema(member, checker);

        tools.push({
          name,
          displayName,
          modelDescription,
          canBeReferencedInPrompt,
          toolReferenceName: name,
          icon,
          inputSchema,
        });
      }
    }
  }

  // Recurse into nested nodes (e.g., modules)
  ts.forEachChild(node, (child) => visitNode(child, checker, tools, diagnostics));
}
