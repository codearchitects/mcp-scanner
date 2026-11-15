/* ------------------------------------------------------------------ */
/*  Tool Scanner                                                       */
/*                                                                     */
/*  Parses TypeScript source files with the TS Compiler API,           */
/*  finds methods decorated with @ExposeTool, extracts their           */
/*  parameter interface and produces VS Code languageModelTools JSON.  */
/* ------------------------------------------------------------------ */

import * as path from 'path';
import * as ts from 'typescript';
import type { IToolAnnotations } from '../decorators';
import { literalToJson, readToolAnnotations } from './json-literal';

/* ------------------------------------------------------------------ */
/*  Public types                                                       */
/* ------------------------------------------------------------------ */

/**
 * Transport a tool can be published to.
 *
 * - `'lm'`  → `contributes.languageModelTools` in package.json (VS Code LM tool).
 * - `'mcp'` → MCP manifest sidecar consumed by embedded MCP servers.
 */
export type ToolTransport = 'lm' | 'mcp';

/**
 * A single tool definition ready to be written into
 * `contributes.languageModelTools` in package.json.
 */
export interface IScannedTool {
  /**
   * Unique tool identifier.
   */
  name: string;

  /**
   * User-facing tool label.
   */
  displayName: string;

  /**
   * Model-facing description used for tool selection.
   */
  modelDescription: string;

  /**
   * Whether tool can be referenced with `#` in prompts.
   */
  canBeReferencedInPrompt: boolean;

  /**
   * Prompt reference name of the tool.
   */
  toolReferenceName: string;

  /**
   * VS Code codicon identifier.
   */
  icon: string;

  /**
   * JSON Schema describing tool input.
   */
  inputSchema: Record<string, unknown>;

  /**
   * JSON Schema of the tool's structured result (MCP `outputSchema`), when it can be stated
   * truthfully: the explicit `outputSchema` option, or the type of the `structuredContent` property
   * of what the method returns. Its root is always an object. Absent when that type is missing, vague
   * or not an object — a diagnostic then names the tool (see {@link extractOutputSchema}).
   */
  outputSchema?: Record<string, unknown>;

  /**
   * The `annotations` option of the decorator (MCP `ToolAnnotations`), when it states any.
   */
  annotations?: IToolAnnotations;

  /**
   * Optional tool tags used for grouping/filtering.
   */
  tags?: string[];

  /**
   * Transports this tool should be published to. Always populated by the
   * scanner (defaults to `['lm']` when the decorator omits it).
   */
  transports: ToolTransport[];

  /**
   * Names of the MCP server groups this tool belongs to.
   * Only relevant when {@link transports} includes `'mcp'`.
   */
  mcpServers?: string[];
}

/**
 * Result returned by {@link scanProject}.
 */
export interface IScanResult {
  /**
   * All tools discovered across the project source files.
   */
  tools: IScannedTool[];
  /**
   * Source files that were scanned.
   */
  filesScanned: number;
  /**
   * Diagnostics / warnings encountered during scanning.
   */
  diagnostics: string[];
}

/**
 * Check whether a source file is inside any of the optional search subtrees.
 *
 * @param filePath Candidate source file path.
 * @param searchPaths Optional subtree root(s) used as filter.
 * @returns `true` when file is in scope for scanning.
 */
function isWithinSearchPath(filePath: string, searchPaths?: string | string[]): boolean {
  const list = searchPaths == null ? [] : Array.isArray(searchPaths) ? searchPaths : [searchPaths];
  if (list.length === 0) {
    return true;
  }

  const resolvedFile = path.resolve(filePath);
  return list.some((searchPath) => {
    const resolvedSearch = path.resolve(searchPath);
    const relative = path.relative(resolvedSearch, resolvedFile);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
}

/**
 * Check whether a source file is inside one of the excluded subtrees.
 *
 * @param filePath Candidate source file path.
 * @param excludedPaths Subtree roots to exclude.
 * @returns `true` when file should be skipped.
 */
function isWithinExcludedPaths(filePath: string, excludedPaths: string[]): boolean {
  const resolvedFile = path.resolve(filePath);
  return excludedPaths.some((excludedPath) => {
    const resolvedExcluded = path.resolve(excludedPath);
    const relative = path.relative(resolvedExcluded, resolvedFile);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
}

/* ------------------------------------------------------------------ */
/*  JSON Schema helpers                                                */
/* ------------------------------------------------------------------ */

/**
 * Convert a TypeScript Type into a JSON Schema for object properties.
 * Used for resolving imported interfaces and complex types.
 *
 * @param type The resolved type.
 * @param checker Program type checker.
 * @param visited Circular-reference guard set.
 * @returns JSON Schema object with expanded properties.
 */
/**
 * Whether a type is `undefined` or a union with an `undefined` member.
 *
 * @param type The type to inspect.
 * @returns True when a value of the type may be undefined.
 */
function includesUndefined(type: ts.Type): boolean {
  if (type.flags & ts.TypeFlags.Undefined) {
    return true;
  }
  return !!(type.flags & ts.TypeFlags.Union) && (type as ts.UnionType).types.some((t) => t.flags & ts.TypeFlags.Undefined);
}

/**
 * The type of a property symbol: read at its declaration when it has one, otherwise (a synthetic
 * property of a mapped or intersection type) from the symbol itself.
 *
 * @param prop Property symbol.
 * @param owner The type the property belongs to.
 * @param checker Program type checker.
 * @returns The property's type.
 */
function propertyType(prop: ts.Symbol, owner: ts.Type, checker: ts.TypeChecker): ts.Type {
  const location = prop.valueDeclaration ?? prop.declarations?.[0] ?? (owner as { __location?: ts.Node }).__location;
  // `getTypeOfSymbol` is public from TypeScript 5.1; older checkers still resolve it at a location.
  const getTypeOfSymbol = (checker as { getTypeOfSymbol?: (symbol: ts.Symbol) => ts.Type }).getTypeOfSymbol;
  if (!prop.valueDeclaration && getTypeOfSymbol) {
    return getTypeOfSymbol.call(checker, prop);
  }
  return checker.getTypeOfSymbolAtLocation(prop, location as ts.Node);
}

/**
 * Whether a property travels as JSON. A method, a function-typed property, a private or protected
 * member (`private`, `protected`, `#name`) and an accessor of a class never do: `JSON.stringify`
 * writes an object's own enumerable fields, and drops functions. Publishing them would describe an
 * object nobody receives.
 *
 * @param prop Property symbol.
 * @param propType Its type.
 * @param checker Program type checker.
 * @returns `true` when the property is data.
 */
function isDataMember(prop: ts.Symbol, propType: ts.Type, checker: ts.TypeChecker): boolean {
  if (prop.name.startsWith('#')) {
    return false;
  }
  for (const decl of prop.declarations ?? []) {
    if (ts.isMethodDeclaration(decl) || ts.isMethodSignature(decl)) {
      return false;
    }
    if ((ts.isGetAccessorDeclaration(decl) || ts.isSetAccessorDeclaration(decl)) && ts.isClassLike(decl.parent)) {
      return false;
    }
    if (ts.getCombinedModifierFlags(decl as ts.Declaration) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) {
      return false;
    }
  }
  const value = checker.getNonNullableType(propType);
  return !(value.flags & ts.TypeFlags.Object
    && value.getProperties().length === 0
    && checker.getSignaturesOfType(value, ts.SignatureKind.Call).length > 0);
}

/**
 * The schema of a union's members (`undefined` already removed): an enum when every member is a
 * string literal, otherwise an `anyOf` where `true` and `false` together are one `boolean` and the
 * string literals together one enum.
 *
 * @param members The members of the union.
 * @param checker Program type checker.
 * @param visited Circular-reference guard set.
 * @returns JSON Schema fragment.
 */
function unionMembersToSchema(members: ts.Type[], checker: ts.TypeChecker, visited: Set<string>): Record<string, unknown> {
  if (members.length === 1) {
    return typeToJsonSchemaFromType(members[0], checker, visited);
  }
  if (members.every((t) => t.flags & ts.TypeFlags.StringLiteral)) {
    return { type: 'string', enum: members.map((t) => (t as ts.StringLiteralType).value) };
  }
  // `boolean` is `true | false` to the checker: both together are one boolean.
  const booleans = members.filter((t) => t.flags & ts.TypeFlags.BooleanLiteral);
  const isBoolean = booleans.length === 2;
  if (isBoolean && members.length === 2) {
    return { type: 'boolean' };
  }
  // The string literals of a mixed union (`IVerdict | 'defect' | 'gap'`) are one enum, in the
  // place of the first of them.
  const strings = members.filter((t) => t.flags & ts.TypeFlags.StringLiteral);
  const branches: Record<string, unknown>[] = [];
  for (const member of members) {
    if (strings.length > 1 && member.flags & ts.TypeFlags.StringLiteral) {
      if (member === strings[0]) {
        branches.push({ type: 'string', enum: strings.map((t) => (t as ts.StringLiteralType).value) });
      }
      continue;
    }
    if (isBoolean && member.flags & ts.TypeFlags.BooleanLiteral) {
      if (member === booleans[0]) {
        branches.push({ type: 'boolean' });
      }
      continue;
    }
    branches.push(typeToJsonSchemaFromType(member, checker, visited));
  }
  return { anyOf: branches };
}

/**
 * The recursive types met while one root schema is built: each is defined once under `$defs` and
 * referenced with `$ref` where it recurs (see {@link withDefinitions}).
 */
interface ISchemaDefinitions {
  /** The recursive types to define, by definition name, with the name the checker gives them. */
  types: Map<string, { type: ts.Type; typeName: string }>;
  /** The types already known to recur (from a first pass), by the checker's name: a `$ref` wherever they appear. */
  known: ReadonlySet<string>;
  /**
   * The next type converted is expanded even when it is known to recur: it is the root, or the
   * top level of the definition being built.
   */
  expandNext: boolean;
}

/** The definitions of the root schema being built; `undefined` outside {@link withDefinitions}. */
let currentDefinitions: ISchemaDefinitions | undefined;

/**
 * The name of a type under `$defs`: its name, with every character a JSON Pointer or a reader would
 * stumble on (`<`, `>`, spaces, `/`, `~`…) replaced.
 *
 * @param typeName The type's name, as the checker writes it.
 * @returns The definition name.
 */
function definitionName(typeName: string): string {
  const parts = typeName.split(/[^A-Za-z0-9.-]+/).filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join('_') : 'Type';
}

/**
 * What a recursive type is where it recurs: a reference to its definition. Outside
 * {@link withDefinitions} there is nowhere to define it, and the recursion is cut to an object.
 *
 * @param type The recursive type.
 * @param typeName Its name.
 * @returns The reference.
 */
function recursionTo(type: ts.Type, typeName: string): Record<string, unknown> {
  if (!currentDefinitions) {
    return { type: 'object' };
  }
  const name = definitionName(typeName);
  currentDefinitions.types.set(name, { type, typeName });
  return { $ref: `#/$defs/${name}` };
}

/**
 * Whether a type already known to recur is referenced here instead of expanded: everywhere but
 * the top level of its own definition.
 *
 * @param typeName The type's name.
 * @returns `true` when the type is to be a `$ref` here.
 */
function isReferencedHere(typeName: string): boolean {
  if (!currentDefinitions) {
    return false;
  }
  if (currentDefinitions.expandNext) {
    currentDefinitions.expandNext = false;
    return false;
  }
  return currentDefinitions.known.has(typeName);
}

/**
 * One pass of {@link withDefinitions}: the root schema, and the definition of every recursive type
 * it references — and of every one met while defining those.
 *
 * @param checker Program type checker.
 * @param build Builds the root schema.
 * @param known The types to reference wherever they appear.
 * @returns The root schema and its definitions.
 */
function definitionPass(
  checker: ts.TypeChecker,
  build: () => Record<string, unknown>,
  known: ReadonlySet<string>,
): { schema: Record<string, unknown>; defs: Record<string, Record<string, unknown>>; recurring: Set<string> } {
  const definitions: ISchemaDefinitions = { types: new Map(), known, expandNext: true };
  currentDefinitions = definitions;
  const schema = build();
  const defs: Record<string, Record<string, unknown>> = {};
  for (let pending = [...definitions.types]; pending.length > 0; pending = [...definitions.types].filter(([name]) => !(name in defs))) {
    for (const [name, { type }] of pending) {
      definitions.expandNext = true;
      defs[name] = typeToJsonSchemaFromType(type, checker, new Set());
    }
  }
  return { schema, defs, recurring: new Set([...definitions.types.values()].map((t) => t.typeName)) };
}

/**
 * Build a root schema, then define under `$defs` every recursive type it references. A recursive
 * type is expanded once, in its definition, and referenced with `$ref` everywhere else: a first
 * pass finds which types recur, a second builds the schema knowing them. Nothing is written when
 * nothing recurs.
 *
 * @param checker Program type checker.
 * @param build Builds the root schema.
 * @returns The root schema, with its `$defs` when it has any.
 */
function withDefinitions(checker: ts.TypeChecker, build: () => Record<string, unknown>): Record<string, unknown> {
  const outer = currentDefinitions;
  try {
    const first = definitionPass(checker, build, new Set());
    if (Object.keys(first.defs).length === 0) {
      return first.schema;
    }
    const { schema, defs } = definitionPass(checker, build, first.recurring);
    return { ...schema, $defs: defs };
  } finally {
    currentDefinitions = outer;
  }
}

function typeToJsonSchemaObject(
  type: ts.Type,
  checker: ts.TypeChecker,
  visited: Set<string>,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  const props = type.getProperties();
  for (const prop of props) {
    const propName = prop.name;
    
    // Get the type of this property. A property of a mapped type (Omit, Pick, Partial…) is
    // synthetic: it has no declaration of its own to read the type at.
    const propType = propertyType(prop, type, checker);
    if (!isDataMember(prop, propType, checker)) {
      continue;
    }

    // Check if optional: a property whose type includes undefined may be absent from the JSON
    // (undefined is never serialized); a mapped property says so through its symbol flags.
    let isOptional = includesUndefined(propType) || !!(prop.flags & ts.SymbolFlags.Optional);
    
    // Also check the declaration for ?: syntax
    if (!isOptional && prop.valueDeclaration) {
      isOptional = !!(prop.valueDeclaration as any).questionToken;
    }

    // If optional and type is a union with Undefined, extract the non-undefined type
    let propSchema: Record<string, unknown>;
    if (isOptional && propType.flags & ts.TypeFlags.Union) {
      const unionType = propType as ts.UnionType;
      const nonUndefinedTypes = unionType.types.filter((t) => !(t.flags & ts.TypeFlags.Undefined));
      
      if (nonUndefinedTypes.length === 1) {
        // Optional single type
        propSchema = typeToJsonSchemaFromType(nonUndefinedTypes[0], checker, visited);
      } else if (nonUndefinedTypes.length > 1) {
        // Optional union
        propSchema = unionMembersToSchema(nonUndefinedTypes, checker, visited);
      } else {
        // Only undefined (shouldn't happen, but handle it)
        propSchema = { type: 'object' };
      }
    } else {
      // Non-optional or not a union with undefined
      propSchema = typeToJsonSchemaFromType(propType, checker, visited);
    }

    // Extract JSDoc description
    const jsDocComment = prop.getDocumentationComment(checker);
    if (jsDocComment && jsDocComment.length > 0) {
      propSchema['description'] = jsDocComment.map((d) => d.text).join('');
    }

    properties[propName] = propSchema;
    if (!isOptional) {
      required.push(propName);
    }
  }

  // A map (`Record<string, V>`, an index signature): its keys are free, its values are V. A JSON
  // key is always a string, so a number-keyed signature says the same; a symbol key never travels.
  const index = checker.getIndexInfosOfType(type).find((info) => !(info.keyType.flags & ts.TypeFlags.ESSymbolLike));
  const additionalProperties = index ? typeToJsonSchemaFromType(index.type, checker, visited) : undefined;

  const schema: Record<string, unknown> = { type: 'object' };
  if (Object.keys(properties).length > 0 || !additionalProperties) {
    schema['properties'] = properties;
  }
  if (required.length > 0) {
    schema['required'] = required;
  }
  if (additionalProperties) {
    schema['additionalProperties'] = additionalProperties;
  }
  return schema;
}

/**
 * Convert a resolved Type to JSON Schema.
 * Handles primitives, arrays, unions, and object types.
 *
 * @param type The resolved type.
 * @param checker Program type checker.
 * @param visited Circular-reference guard set.
 * @returns JSON Schema fragment.
 */
function typeToJsonSchemaFromType(
  type: ts.Type,
  checker: ts.TypeChecker,
  visited: Set<string>,
): Record<string, unknown> {
  // --- unknown / any: any JSON value, which is the empty schema (not an object) ---
  if (type.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) {
    return {};
  }

  const typeName = checker.typeToString(type);

  // A type met again inside itself recurs: it is defined once and referenced here, as is a type
  // already known to recur, wherever it appears
  if (visited.has(typeName) || isReferencedHere(typeName)) {
    return recursionTo(type, typeName);
  }

  // --- String type ---
  if (type.flags & ts.TypeFlags.String) {
    return { type: 'string' };
  }

  // --- Number type ---
  if (type.flags & ts.TypeFlags.Number) {
    return { type: 'number' };
  }

  // --- Boolean type ---
  if (type.flags & ts.TypeFlags.Boolean) {
    return { type: 'boolean' };
  }

  // --- String literal type ---
  if (type.flags & ts.TypeFlags.StringLiteral) {
    const literalType = type as ts.StringLiteralType;
    return { type: 'string', enum: [literalType.value] };
  }

  // --- Number literal type ---
  if (type.flags & ts.TypeFlags.NumberLiteral) {
    const literalType = type as ts.NumberLiteralType;
    return { type: 'number', enum: [literalType.value] };
  }

  // --- Boolean literal type (true | false) ---
  if (type.flags & ts.TypeFlags.BooleanLiteral) {
    // Get the boolean value from the intrinsic name
    const isTrueLiteral = (type as any).intrinsicName === 'true';
    return { type: 'boolean', enum: [isTrueLiteral] };
  }

  // --- null: a JSON value of its own ---
  if (type.flags & ts.TypeFlags.Null) {
    return { type: 'null' };
  }

  // --- Union type (includes enums and boolean literals) ---
  if (type.flags & ts.TypeFlags.Union) {
    // undefined is never serialized to JSON: it makes a property optional (see
    // typeToJsonSchemaObject), it is not a branch of its own.
    const members = (type as ts.UnionType).types.filter((t) => !(t.flags & ts.TypeFlags.Undefined));
    // A named union (`type JsonValue = … | JsonValue[]`) can contain itself: it is guarded as an object is.
    return unionMembersToSchema(members, checker, type.aliasSymbol ? new Set(visited).add(typeName) : visited);
  }

  // --- Intersection of object types (`A & B`, `Omit<T, K> & { … }`): one object with every member's properties ---
  if (type.flags & ts.TypeFlags.Intersection && (type as ts.IntersectionType).types.every((t) => t.flags & ts.TypeFlags.Object)) {
    return typeToJsonSchemaObject(type, checker, new Set(visited).add(typeName));
  }

  // --- Object type (interface, class, type literal, or array) ---
  if (type.flags & ts.TypeFlags.Object) {
    // A list recurs through its element type, which is guarded itself; only a named list
    // (`type T = T[]`) can contain itself.
    if (!checker.isArrayType(type) || type.aliasSymbol) {
      visited = new Set(visited).add(typeName);
    }

    // A list, read-only (`readonly T[]`, `ReadonlyArray<T>`) or not: JSON has one kind of list
    if (checker.isArrayType(type)) {
      // It's an array - get the element type from type arguments
      const typeRef = type as ts.TypeReference;
      const typeArgs = checker.getTypeArguments(typeRef);
      // `never[]` (an empty array literal) can only ever be empty
      if (typeArgs && typeArgs.length > 0 && typeArgs[0].flags & ts.TypeFlags.Never) {
        return { type: 'array', maxItems: 0 };
      }
      if (typeArgs && typeArgs.length > 0) {
        return {
          type: 'array',
          items: typeToJsonSchemaFromType(typeArgs[0], checker, visited),
        };
      }
      return { type: 'array', items: { type: 'object' } };
    }

    // Regular object - expand properties
    return typeToJsonSchemaObject(type, checker, visited);
  }

  // --- Fallback ---
  return { type: 'object' };
}

/**
 * Convert a TypeScript type node into a JSON Schema fragment.
 * Handles primitives, arrays, literal types, unions, and interfaces/type-literals.
 *
 * @param typeNode Type node to convert.
 * @param checker Program type checker.
 * @param visited Circular-reference guard set.
 * @returns JSON Schema fragment for the provided type node.
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
    visited = new Set(visited).add(typeName);

    // First, try the original method: getSymbolAtLocation
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

    // FALLBACK: Try getTypeAtLocation for imported types
    try {
      const resolvedType = checker.getTypeAtLocation(typeNode);
      if (resolvedType && resolvedType.getProperties && resolvedType.getProperties().length > 0) {
        return typeToJsonSchemaFromType(resolvedType, checker, new Set(visited));
      }
    } catch {
      // Silently fail and use final fallback
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
      anyOf: typeNode.types.map((t) => typeNodeToJsonSchema(t, checker, visited)),
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
 *
 * @param decl Interface declaration node.
 * @param checker Program type checker.
 * @param visited Circular-reference guard set.
 * @returns JSON Schema object for the interface.
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
 *
 * @param node Inline type literal node.
 * @param checker Program type checker.
 * @param visited Circular-reference guard set.
 * @returns JSON Schema object for the inline type.
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

/**
 * Extract plain-text JSDoc description from a node.
 *
 * @param node AST node that may have JSDoc.
 * @returns JSDoc description text when available.
 */
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
 *
 * @param decorator Decorator node to inspect.
 * @returns Object literal argument for `@ExposeTool(...)` when matched.
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
 * Check whether a decorator call is `@Tool(...)` and extract the options object literal.
 *
 * @param decorator Decorator node to inspect.
 * @returns Object literal argument for `@Tool(...)` when matched.
 */
function getToolArgs(decorator: ts.Decorator): ts.ObjectLiteralExpression | undefined {
  if (!ts.isCallExpression(decorator.expression)) {
    return undefined;
  }
  const expr = decorator.expression.expression;
  const name = ts.isIdentifier(expr) ? expr.text : undefined;
  if (name !== 'Tool') {
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
 *
 * @param obj Object literal expression.
 * @param name Property name to read.
 * @returns String value when property exists and is a string literal.
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
 *
 * @param obj Object literal expression.
 * @param name Property name to read.
 * @returns Boolean value when property exists and is a boolean literal.
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

/**
 * Extract a string-array property (array literal of string literals) from an
 * object literal expression.
 *
 * @param obj Object literal expression.
 * @param name Property name to read.
 * @returns Array of string values when property exists and is an array literal.
 */
function getStringArrayProperty(obj: ts.ObjectLiteralExpression, name: string): string[] | undefined {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && prop.name && ts.isIdentifier(prop.name) && prop.name.text === name) {
      if (!ts.isArrayLiteralExpression(prop.initializer)) {
        return undefined;
      }
      const values: string[] = [];
      for (const element of prop.initializer.elements) {
        if (ts.isStringLiteral(element)) {
          values.push(element.text);
        }
      }
      return values;
    }
  }
  return undefined;
}

/**
 * Normalize an authored `transports` array into a valid, de-duplicated list,
 * falling back to a default when omitted or empty/invalid.
 *
 * @param authored Raw values read from the decorator.
 * @param fallback Default transports applied when nothing valid was authored.
 * @returns Validated transport list.
 */
function normalizeTransports(authored: string[] | undefined, fallback: ToolTransport[]): ToolTransport[] {
  if (!authored) {
    return [...fallback];
  }
  const valid = authored.filter((t): t is ToolTransport => t === 'lm' || t === 'mcp');
  const unique = Array.from(new Set(valid));
  return unique.length > 0 ? unique : [...fallback];
}

/* ------------------------------------------------------------------ */
/*  Parameter type extraction                                          */
/* ------------------------------------------------------------------ */

/**
 * Strip `undefined` branches from a possibly-union type.
 *
 * An optional parameter (`params?: IFoo` or `params: IFoo = {}`) resolves to
 * `IFoo | undefined` under the checker. For root input schemas the `undefined`
 * branch is meaningless — it must be dropped so the object branch(es) can be
 * used directly and the root can stay `{ type: "object" }`.
 *
 * @param type Resolved parameter type.
 * @returns Non-undefined branches of the type.
 */
function stripUndefinedBranches(type: ts.Type): ts.Type[] {
  if (type.flags & ts.TypeFlags.Union) {
    const unionType = type as ts.UnionType;
    return unionType.types.filter((t) => !(t.flags & ts.TypeFlags.Undefined));
  }
  if (type.flags & ts.TypeFlags.Undefined) {
    return [];
  }
  return [type];
}

/**
 * Merge multiple object-typed JSON Schema branches into a single object schema.
 *
 * Semantics:
 * - `properties` is the union across branches (first-seen definition wins).
 * - `required` is the intersection: a property required in only some branches
 *   becomes optional in the merge — which is what an optional root parameter
 *   should mean anyway.
 *
 * @param branches Object-typed schema branches.
 * @returns Merged root object schema.
 */
/**
 * The schema accepting what either schema accepts: one of them when they are equal, otherwise an
 * `anyOf` of their distinct alternatives (an existing `anyOf` is flattened, not nested).
 *
 * @param a A schema.
 * @param b Another schema.
 * @returns The union of the two.
 */
function unionOfSchemas(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const alternatives = (schema: Record<string, unknown>): Record<string, unknown>[] =>
    Array.isArray(schema.anyOf) && Object.keys(schema).length === 1 ? (schema.anyOf as Record<string, unknown>[]) : [schema];
  let distinct: Record<string, unknown>[] = [];
  for (const alternative of [...alternatives(a), ...alternatives(b)]) {
    if (!distinct.some((seen) => JSON.stringify(seen) === JSON.stringify(alternative))) {
      distinct.push(alternative);
    }
  }
  // `true` in one branch and `false` in another: together, a boolean.
  const literal = (s: Record<string, unknown>, value: boolean): boolean =>
    s.type === 'boolean' && Array.isArray(s.enum) && s.enum.length === 1 && s.enum[0] === value && Object.keys(s).length === 2;
  if (distinct.some((s) => literal(s, true)) && distinct.some((s) => literal(s, false))) {
    const at = distinct.findIndex((s) => literal(s, true) || literal(s, false));
    distinct = distinct.filter((s, i) => i === at || !(literal(s, true) || literal(s, false)));
    distinct[at] = { type: 'boolean' };
  }
  return distinct.length === 1 ? distinct[0] : { anyOf: distinct };
}

function mergeObjectSchemaBranches(
  branches: Record<string, unknown>[],
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const requiredSets: Set<string>[] = [];

  for (const branch of branches) {
    const props = (branch.properties as Record<string, unknown> | undefined) ?? {};
    for (const [key, value] of Object.entries(props)) {
      properties[key] = key in properties ? unionOfSchemas(properties[key] as Record<string, unknown>, value as Record<string, unknown>) : value;
    }
    const req = branch.required;
    requiredSets.push(new Set(Array.isArray(req) ? (req as string[]) : []));
  }

  const schema: Record<string, unknown> = { type: 'object', properties };
  if (requiredSets.length > 0) {
    const [first, ...rest] = requiredSets;
    const intersection = Array.from(first).filter((k) => rest.every((s) => s.has(k)));
    if (intersection.length > 0) {
      schema.required = intersection;
    }
  }
  // A branch that is a map says what its other fields are: the merge keeps it, the union of what
  // the branches say, for the fields none of them declares.
  const extra = branches
    .map((branch) => branch.additionalProperties)
    .filter((value): value is Record<string, unknown> => typeof value === 'object' && value !== null);
  if (extra.length > 0) {
    schema.additionalProperties = extra.reduce((all, one) => unionOfSchemas(all, one));
  }
  return schema;
}

/**
 * Guarantee a JSON Schema is a valid MCP root inputSchema.
 *
 * The MCP spec requires `inputSchema.type === "object"` at the root. Strict
 * clients (e.g. Claude Code) drop the entire `tools/list` response when even
 * one tool violates this. This normalizer folds any surviving root-level
 * `anyOf` of object branches into a merged object schema, and coerces any
 * other unexpected shape into an empty object schema so the manifest stays
 * well-formed no matter which conversion path produced the input.
 *
 * @param schema Raw schema produced by conversion.
 * @returns Root schema shaped as `{ type: "object", properties: ... }`.
 */
function normalizeRootObjectSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema && schema.type === 'object') {
    if ('properties' in schema) {
      return schema;
    }
    return { ...schema, properties: {} };
  }

  if (schema && Array.isArray((schema as { anyOf?: unknown[] }).anyOf)) {
    const branches = (schema as { anyOf: unknown[] }).anyOf.filter(
      (b): b is Record<string, unknown> =>
        typeof b === 'object' && b !== null && (b as Record<string, unknown>).type === 'object',
    );
    if (branches.length === 1) {
      return normalizeRootObjectSchema(branches[0]);
    }
    if (branches.length > 1) {
      return mergeObjectSchemaBranches(branches);
    }
  }

  return { type: 'object', properties: {} };
}

/**
 * The inputSchema of a tool that takes no argument: only an empty object is accepted, as MCP
 * recommends (`{ "type": "object", "additionalProperties": false }`).
 */
const NO_ARGUMENT_SCHEMA: Readonly<Record<string, unknown>> = { type: 'object', additionalProperties: false };

/**
 * True when a parameter type states no field at all: every non-undefined branch is an object type
 * with no property and no index signature (`{}`, an empty interface). `Record<string, unknown>`
 * is not one: its index signature accepts any field.
 *
 * @param type Resolved parameter type.
 * @param checker Program type checker.
 * @returns `true` when the tool takes no argument.
 */
function takesNoArgument(type: ts.Type, checker: ts.TypeChecker): boolean {
  const branches = stripUndefinedBranches(type);
  return branches.length > 0 && branches.every((t) =>
    !!(t.flags & ts.TypeFlags.Object)
    && !checker.isArrayType(t)
    && t.getProperties().length === 0
    && checker.getIndexInfosOfType(t).length === 0
    && checker.getSignaturesOfType(t, ts.SignatureKind.Call).length === 0);
}

/**
 * Given a method declaration, find its first parameter's type node and
 * produce a JSON Schema from it.
 *
 * The root schema is always normalized to `{ type: "object", properties: ... }`
 * — an optional parameter (`?:` or initializer) only means every property is
 * optional; it must not change the root shape.
 *
 * @param method Method declaration.
 * @param checker Program type checker.
 * @returns JSON Schema for first parameter type (root guaranteed `type: "object"`).
 */
function extractInputSchema(
  method: ts.MethodDeclaration,
  checker: ts.TypeChecker,
): Record<string, unknown> {
  const firstParam = method.parameters[0];
  if (!firstParam) {
    return { ...NO_ARGUMENT_SCHEMA };
  }
  if (!firstParam.type) {
    return { type: 'object', properties: {} };
  }
  if (takesNoArgument(checker.getTypeAtLocation(firstParam), checker)) {
    return { ...NO_ARGUMENT_SCHEMA };
  }

  // The recursive types of the parameter are defined under the root's $defs.
  let schema = withDefinitions(checker, () => normalizeRootObjectSchema(parameterSchema(firstParam, checker)));

  // An optional-marker parameter (`params?: IFoo`) means every property is
  // optional at the boundary — the whole payload is optional, so no root
  // property can be required. A default initializer (`params: IFoo = {}`) is
  // NOT treated the same: the caller still passes an IFoo, so required is
  // preserved (matches the "unchanged behaviour" acceptance criterion).
  if (firstParam.questionToken && 'required' in schema) {
    const { required: _required, ...rest } = schema;
    schema = rest;
  }

  return schema;
}

/**
 * The JSON Schema of a parameter's type, before the root is normalized.
 *
 * @param firstParam The parameter, which has a type annotation.
 * @param checker Program type checker.
 * @returns JSON Schema fragment.
 */
function parameterSchema(firstParam: ts.ParameterDeclaration, checker: ts.TypeChecker): Record<string, unknown> {
  // Try to resolve using the Type API first (handles imported types better).
  let schema: Record<string, unknown> | undefined;
  try {
    const resolvedType = checker.getTypeAtLocation(firstParam);
    if (resolvedType) {
      const branches = stripUndefinedBranches(resolvedType);
      if (branches.length === 0) {
        schema = { type: 'object', properties: {} };
      } else if (branches.length === 1) {
        schema = typeToJsonSchemaFromType(branches[0], checker, new Set());
      } else {
        const branchSchemas = branches.map((t) => typeToJsonSchemaFromType(t, checker, new Set()));
        const objectBranches = branchSchemas.filter((s) => s && s.type === 'object');
        schema = objectBranches.length > 0
          ? mergeObjectSchemaBranches(objectBranches)
          : { type: 'object', properties: {} };
      }
    }
  } catch {
    // Fallback to TypeNode-based resolution.
  }

  return schema ?? typeNodeToJsonSchema(firstParam.type as ts.TypeNode, checker);
}

/* ------------------------------------------------------------------ */
/*  Output schema                                                      */
/* ------------------------------------------------------------------ */

/**
 * Find a property of a decorator's options object.
 *
 * @param obj Decorator options object literal.
 * @param name Property name.
 * @returns The property's initializer, or `undefined` when absent.
 */
function getPropertyInitializer(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && prop.name && ts.isIdentifier(prop.name) && prop.name.text === name) {
      return prop.initializer;
    }
  }
  return undefined;
}

/**
 * Read the `annotations` option of a decorator, reporting every key it drops.
 *
 * @param obj Decorator options object literal.
 * @param toolName Tool name, for the diagnostics.
 * @param diagnostics Accumulator for scan diagnostics.
 * @returns The kept annotations, or `undefined` when the option is absent or states none.
 */
function readAnnotationsOption(
  obj: ts.ObjectLiteralExpression,
  toolName: string,
  diagnostics: string[],
): IToolAnnotations | undefined {
  const initializer = getPropertyInitializer(obj, 'annotations');
  if (!initializer) {
    return undefined;
  }
  const read = readToolAnnotations(initializer);
  if (!read) {
    diagnostics.push(`${toolName}: annotations ignored — the option must be an object literal of MCP ToolAnnotations.`);
    return undefined;
  }
  for (const key of read.dropped) {
    diagnostics.push(`${toolName}: annotations.${key} ignored — the only supported annotation is readOnlyHint (boolean).`);
  }
  return read.annotations;
}

/** What {@link extractOutputSchema} concluded: a schema, or why none can be written. */
type IOutputSchemaVerdict = { schema: Record<string, unknown> } | { reason: string };

/** True for a JSON Schema whose root is an object. */
function isObjectRootSchema(schema: unknown): boolean {
  return typeof schema === 'object' && schema !== null && !Array.isArray(schema)
    && (schema as Record<string, unknown>).type === 'object';
}

/**
 * Why a non-object root is refused. MCP 2025-11-25 and earlier type `structuredContent` and the
 * `outputSchema` root as a JSON object; MCP 2026-07-28 allows any JSON value, but an object root is
 * valid in every version, so it is the only root this scanner writes.
 */
const OBJECT_ROOT_REASON =
  'an outputSchema root must be a JSON object, which every MCP version accepts (2025-11-25 and earlier '
  + 'require it): wrap the data in an object';

/**
 * The outputSchema of a tool: its explicit `outputSchema` option when given, otherwise the JSON
 * Schema of the type of the `structuredContent` property of what the method returns (a Promise is
 * unwrapped), built exactly as an inputSchema is.
 *
 * A server that publishes an outputSchema MUST return results that conform to it, so no schema is
 * written — and the verdict says why — when the return type has no `structuredContent`, or its type
 * is `unknown`, `any`, `never`, an empty object or an index signature only (`Record<string,
 * unknown>`): such a schema would state nothing. A type that is not an object — a list, a
 * primitive — gets no schema either: the root is always an object (see {@link OBJECT_ROOT_REASON}).
 *
 * @param method Method declaration.
 * @param checker Program type checker.
 * @param explicit The `outputSchema` option's initializer, when the decorator has one.
 * @returns The schema, or the reason none is written.
 */
function extractOutputSchema(
  method: ts.MethodDeclaration,
  checker: ts.TypeChecker,
  explicit: ts.Expression | undefined,
): IOutputSchemaVerdict {
  if (explicit) {
    return explicitOutputSchema(explicit);
  }
  const data = structuredContentType(method, checker);
  return 'reason' in data ? data : dataOutputSchema(data.type, checker);
}

/**
 * The verdict on an explicit `outputSchema` option.
 *
 * @param explicit The option's initializer.
 * @returns The schema, or why it is refused.
 */
function explicitOutputSchema(explicit: ts.Expression): IOutputSchemaVerdict {
  const read = literalToJson(explicit);
  if (!read) {
    return { reason: 'the explicit outputSchema option must be a JSON Schema object written as a literal in the decorator' };
  }
  return isObjectRootSchema(read.value)
    ? { schema: read.value as Record<string, unknown> }
    : { reason: `the explicit outputSchema option was refused: its root is not { "type": "object" }; ${OBJECT_ROOT_REASON}` };
}

/**
 * The type of the `structuredContent` property of what a method returns (a Promise unwrapped,
 * `undefined` removed), or why there is none worth a schema (`any`, `unknown`, `never`).
 *
 * @param method Method declaration.
 * @param checker Program type checker.
 * @returns The data type, or the reason no schema can be written.
 */
function structuredContentType(method: ts.MethodDeclaration, checker: ts.TypeChecker): { type: ts.Type } | { reason: string } {
  const signature = checker.getSignatureFromDeclaration(method);
  if (!signature) {
    return { reason: 'its return type could not be resolved' };
  }
  const returned = checker.getReturnTypeOfSignature(signature);
  const awaited = checker.getAwaitedType(returned) ?? returned;
  const property = awaited.getProperty('structuredContent');
  if (!property) {
    return { reason: `its return type ${checker.typeToString(returned)} has no structuredContent` };
  }
  // Checked on the raw type: NonNullable<unknown> is {}, which would hide an unknown.
  const declared = checker.getTypeOfSymbolAtLocation(property, method);
  if (declared.flags & ts.TypeFlags.Any) {
    return { reason: 'the type of its structuredContent is any; give the result type a concrete object type' };
  }
  if (declared.flags & ts.TypeFlags.Unknown) {
    return { reason: 'the type of its structuredContent is unknown; give the result type a concrete object type' };
  }
  const type = checker.getNonNullableType(declared);
  if (type.flags & ts.TypeFlags.Never) {
    return { reason: 'the type of its structuredContent is never' };
  }
  return { type };
}

/**
 * The verdict on a data type: its JSON Schema, unless it states no field (an empty object, an
 * index signature only) or it is not an object.
 *
 * @param data The type of `structuredContent`.
 * @param checker Program type checker.
 * @returns The schema, or the reason none is written.
 */
function dataOutputSchema(data: ts.Type, checker: ts.TypeChecker): IOutputSchemaVerdict {
  const dataName = checker.typeToString(data);
  const isList = checker.isArrayType(data) || checker.isTupleType(data);
  if (!isList && data.flags & ts.TypeFlags.Object && data.getProperties().length === 0) {
    const kind = checker.getIndexInfosOfType(data).length > 0 ? 'an index signature only' : 'an empty object type';
    return { reason: `the type of its structuredContent (${dataName}) is ${kind}, which states no field` };
  }

  let refused = false;
  // The recursive types of the data are defined under the root's $defs.
  const schema = withDefinitions(checker, () => {
    const converted: Record<string, unknown> = typeToJsonSchemaFromType(data, checker, new Set());
    if (isObjectRootSchema(converted)) {
      return converted;
    }
    const branches = Array.isArray(converted.anyOf) ? converted.anyOf : [];
    if (branches.length > 0 && branches.every(isObjectRootSchema)) {
      return mergeObjectSchemaBranches(branches as Record<string, unknown>[]);
    }
    refused = true;
    return converted;
  });
  if (!refused) {
    return { schema };
  }
  const what = isList ? 'not an object but a list' : 'not an object';
  return { reason: `the type of its structuredContent (${dataName}) is ${what}; ${OBJECT_ROOT_REASON}` };
}

/**
 * Apply an outputSchema verdict to a scanned tool: set the schema, or — for a tool published over
 * MCP — report why none was written.
 *
 * @param tool Scanned tool being built.
 * @param verdict What {@link extractOutputSchema} concluded.
 * @param diagnostics Accumulator for scan diagnostics.
 */
function applyOutputSchema(tool: IScannedTool, verdict: IOutputSchemaVerdict, diagnostics: string[]): void {
  if ('schema' in verdict) {
    tool.outputSchema = verdict.schema;
  } else if (tool.transports.includes('mcp')) {
    diagnostics.push(`${tool.name}: no outputSchema written — ${verdict.reason}.`);
  }
}

/* ------------------------------------------------------------------ */
/*  Main scanner                                                       */
/* ------------------------------------------------------------------ */

/**
 * Options controlling {@link scanProject} behavior.
 */
export interface IScanOptions {
  /**
   * Transports applied to tools whose decorator omits `transports`.
   * Defaults to `['lm']`, preserving the historical behavior.
   */
  defaultTransport?: ToolTransport[];
}

/**
 * Scan a TypeScript project for `@ExposeTool` decorated methods.
 *
 * @param projectRoot Absolute path to the project root (where tsconfig.json lives).
 * @param tsconfigFileName Optional tsconfig file name. Defaults to `tsconfig.json`.
 * @param toolsSearchPath Optional path(s) to restrict scanning to specific subtree(s).
 * @param excludedSearchPaths Optional paths to exclude from scanning.
 * @param options Optional scan behavior switches.
 * @returns Discovered tools + diagnostics.
 */
export function scanProject(
  projectRoot: string,
  tsconfigFileName = 'tsconfig.json',
  toolsSearchPath?: string | string[],
  excludedSearchPaths: string[] = [],
  options: IScanOptions = {},
): IScanResult {
  const defaultTransport: ToolTransport[] = options.defaultTransport && options.defaultTransport.length > 0
    ? options.defaultTransport
    : ['lm'];
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
    if (!isWithinSearchPath(sourceFile.fileName, toolsSearchPath)) {
      continue;
    }
    if (isWithinExcludedPaths(sourceFile.fileName, excludedSearchPaths)) {
      continue;
    }

    filesScanned++;
    ts.forEachChild(sourceFile, (node) => visitNode(node, checker, tools, diagnostics, defaultTransport));
  }

  return { tools, filesScanned, diagnostics };
}

/**
 * Recursively visit AST nodes looking for class declarations with
 * `@ExposeTool` decorated methods.
 *
 * @param node Current AST node.
 * @param checker Program type checker.
 * @param tools Accumulator for discovered tools.
 * @param diagnostics Accumulator for scan diagnostics.
 */
function visitNode(
  node: ts.Node,
  checker: ts.TypeChecker,
  tools: IScannedTool[],
  diagnostics: string[],
  defaultTransport: ToolTransport[],
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
        // --- @ExposeTool path: derive schema from parameter type ---
        const exposeArgsObj = getExposeToolArgs(decorator);
        if (exposeArgsObj) {
          const name = getStringProperty(exposeArgsObj, 'name');
          const displayName = getStringProperty(exposeArgsObj, 'displayName');
          const modelDescription = getStringProperty(exposeArgsObj, 'modelDescription');

          if (!name || !displayName || !modelDescription) {
            const className = node.name?.getText() ?? '<anonymous>';
            const methodName = member.name?.getText() ?? '<unknown>';
            diagnostics.push(
              `@ExposeTool on ${className}.${methodName}: missing required property (name, displayName, or modelDescription).`,
            );
            continue;
          }

          const icon = getStringProperty(exposeArgsObj, 'icon') ?? '$(tools)';
          const canBeReferencedInPrompt = getBooleanProperty(exposeArgsObj, 'canBeReferencedInPrompt') ?? true;
          const transports = normalizeTransports(getStringArrayProperty(exposeArgsObj, 'transports'), defaultTransport);
          const mcpServers = getStringArrayProperty(exposeArgsObj, 'mcpServers');
          const annotations = readAnnotationsOption(exposeArgsObj, name, diagnostics);
          const inputSchema = extractInputSchema(member, checker);

          const scanned: IScannedTool = {
            name,
            displayName,
            modelDescription,
            canBeReferencedInPrompt,
            toolReferenceName: name,
            icon,
            inputSchema,
            transports,
            ...(mcpServers && mcpServers.length > 0 ? { mcpServers } : {}),
            ...(annotations ? { annotations } : {}),
          };
          applyOutputSchema(
            scanned,
            extractOutputSchema(member, checker, getPropertyInitializer(exposeArgsObj, 'outputSchema')),
            diagnostics,
          );
          tools.push(scanned);
          continue;
        }

        // --- @Tool path: derive schema from parameter types (same as @ExposeTool) ---
        const toolArgsObj = getToolArgs(decorator);
        if (toolArgsObj) {
          const name = getStringProperty(toolArgsObj, 'name');
          const displayName = getStringProperty(toolArgsObj, 'displayName');
          const modelDescription = getStringProperty(toolArgsObj, 'modelDescription');

          if (!name || !displayName || !modelDescription) {
            // @Tool without required fields → skip silently (may be partial proxy)
            continue;
          }

          const icon = getStringProperty(toolArgsObj, 'icon') ?? '$(tools)';
          const canBeReferencedInPrompt = getBooleanProperty(toolArgsObj, 'canBeReferencedInPrompt') ?? true;
          const transports = normalizeTransports(getStringArrayProperty(toolArgsObj, 'transports'), defaultTransport);
          const mcpServers = getStringArrayProperty(toolArgsObj, 'mcpServers');
          const annotations = readAnnotationsOption(toolArgsObj, name, diagnostics);
          const inputSchema = extractInputSchema(member, checker);

          const scanned: IScannedTool = {
            name,
            displayName,
            modelDescription,
            canBeReferencedInPrompt,
            toolReferenceName: name,
            icon,
            inputSchema,
            transports,
            ...(mcpServers && mcpServers.length > 0 ? { mcpServers } : {}),
            ...(annotations ? { annotations } : {}),
          };
          applyOutputSchema(
            scanned,
            extractOutputSchema(member, checker, getPropertyInitializer(toolArgsObj, 'outputSchema')),
            diagnostics,
          );
          tools.push(scanned);
        }
      }
    }
  }

  // Recurse into nested nodes (e.g., modules)
  ts.forEachChild(node, (child) => visitNode(child, checker, tools, diagnostics, defaultTransport));
}
