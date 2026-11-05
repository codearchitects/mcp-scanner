/* ------------------------------------------------------------------ */
/*  JSON literals in decorator options                                 */
/* ------------------------------------------------------------------ */

import * as ts from 'typescript';

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
