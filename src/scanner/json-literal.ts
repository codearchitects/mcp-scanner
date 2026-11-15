/* ------------------------------------------------------------------ */
/*  JSON literals in decorator options                                 */
/* ------------------------------------------------------------------ */

import * as ts from 'typescript';
import type { IToolAnnotations } from '../decorators';

/** The supported MCP `ToolAnnotations` fields, with the JSON type each must have. */
const ANNOTATION_FIELDS: Record<keyof IToolAnnotations, 'boolean'> = {
  readOnlyHint: 'boolean',
};

/**
 * Read an `annotations` decorator option: the supported `ToolAnnotations` fields of the right type,
 * and the keys it drops (unsupported, or of the wrong type).
 *
 * @param expr The option's initializer.
 * @returns `undefined` when it is not an object literal; otherwise the kept annotations (absent
 *   when none is kept) and the dropped keys.
 */
export function readToolAnnotations(expr: ts.Expression): { annotations?: IToolAnnotations; dropped: string[] } | undefined {
  const read = literalToJson(expr);
  const value = read?.value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const annotations: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    const expected = (ANNOTATION_FIELDS as Record<string, string | undefined>)[key];
    if (expected !== undefined && typeof field === expected) {
      annotations[key] = field;
    } else {
      dropped.push(key);
    }
  }
  return Object.keys(annotations).length > 0
    ? { annotations: annotations as IToolAnnotations, dropped }
    : { dropped };
}

/**
 * Read a JSON literal written in the source — an object, array, string, number, boolean or `null`,
 * possibly wrapped in parentheses or `as` / `satisfies`.
 *
 * @param expr Expression to read.
 * @returns The value, or `undefined` when the expression is not a pure JSON literal.
 */
export function literalToJson(expr: ts.Expression): { value: unknown } | undefined {
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) {
    return literalToJson(expr.expression);
  }
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return { value: expr.text };
  }
  if (ts.isNumericLiteral(expr)) {
    return { value: Number(expr.text) };
  }
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(expr.operand)) {
    return { value: -Number(expr.operand.text) };
  }
  if (expr.kind === ts.SyntaxKind.TrueKeyword) {
    return { value: true };
  }
  if (expr.kind === ts.SyntaxKind.FalseKeyword) {
    return { value: false };
  }
  if (expr.kind === ts.SyntaxKind.NullKeyword) {
    return { value: null };
  }
  if (ts.isArrayLiteralExpression(expr)) {
    const values: unknown[] = [];
    for (const element of expr.elements) {
      const read = literalToJson(element);
      if (!read) {
        return undefined;
      }
      values.push(read.value);
    }
    return { value: values };
  }
  if (ts.isObjectLiteralExpression(expr)) {
    const record: Record<string, unknown> = {};
    for (const prop of expr.properties) {
      if (!ts.isPropertyAssignment(prop)) {
        return undefined;
      }
      const key = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) || ts.isNumericLiteral(prop.name)
        ? prop.name.text
        : undefined;
      const read = key === undefined ? undefined : literalToJson(prop.initializer);
      if (key === undefined || !read) {
        return undefined;
      }
      record[key] = read.value;
    }
    return { value: record };
  }
  return undefined;
}
