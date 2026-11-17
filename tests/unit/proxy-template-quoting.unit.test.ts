import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * The default proxy template writes every text of a tool as a TypeScript literal that keeps it
 * whole: an apostrophe, a backslash or a line break in a description used to end the literal, and
 * the generated proxy did not compile.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ejs = require('ejs') as { render(template: string, data: object): string };
const TEMPLATE = fs.readFileSync(path.resolve(__dirname, '../../src/templates/proxy-scaffold.ejs'), 'utf8');

const TRICKY = {
  name: 'demoTree',
  displayName: "Demo: Tree's \\ view",
  modelDescription: "Returns the project's nodes; a path like C:\\models\\a, a quote \" and\na second line.",
};

function render(toolOptions: Record<string, unknown>): string {
  return ejs.render(TEMPLATE, {
    className: 'DemoTools',
    methods: [{ importStatements: [], jsDoc: '/** Demo. */', toolOptions, methodName: 'getTree', parameters: [], returnTypeText: 'Promise<unknown>', firstParameterName: undefined }],
  });
}

function read(source: string): { errors: string[]; options: Record<string, string> } {
  const file = ts.createSourceFile('proxy.ts', source, ts.ScriptTarget.ES2022, true);
  const errors = ((file as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '));
  const options: Record<string, string> = {};
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && ts.isStringLiteralLike(node.initializer)) {
      options[node.name.getText(file)] = node.initializer.text;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { errors, options };
}

describe('the default proxy template keeps every text of a tool whole', () => {
  it('compiles with apostrophes, backslashes, quotes and line breaks in the texts', () => {
    expect(read(render(TRICKY)).errors).toEqual([]);
  });

  it('carries each text exactly as declared', () => {
    expect(read(render(TRICKY)).options).toMatchObject(TRICKY);
  });

  it('writes a plain text as before', () => {
    expect(render({ name: 'plain', displayName: 'Plain', modelDescription: 'Reads.' })).toContain("modelDescription: 'Reads.',");
  });
});
