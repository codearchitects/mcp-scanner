import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { scanProject } from '../../src/scanner';
import type { IScanOptions, IScannedTool } from '../../src/scanner';
import { makeTempDir, writeFile } from '../helpers/tmp';

/**
 * outputSchema derivation: the schema of a tool's structured result, read from the type of the
 * `structuredContent` property of what the method returns (a Promise is unwrapped). When that type
 * is missing, vague (`unknown`, `any`, an index signature only) or not an object, no schema is
 * written and a diagnostic names the tool — MCP requires an object root, and a server MUST return
 * data that conforms to the schema it publishes, so no schema is better than a false one.
 */

const PRELUDE = `
function ExposeTool(_: unknown): MethodDecorator { return () => undefined; }
function Tool(_: unknown): MethodDecorator { return () => undefined; }
interface IText { type: 'text'; text: string }
interface IMcpToolResult<T = unknown> {
  content?: IText[];
  structuredContent?: T;
  isError?: boolean;
}
interface IData {
  /** how many items */
  count: number;
  items: string[];
  note?: string;
}
`;

function scan(body: string, options: IScanOptions = {}, topLevel = ''): { tools: IScannedTool[]; diagnostics: string[] } {
  const root = makeTempDir();
  writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'commonjs', strict: true, experimentalDecorators: true },
    include: ['src/**/*.ts'],
  }));
  writeFile(path.join(root, 'src', 'tools.ts'), `${PRELUDE}\n${topLevel}\nclass Tools {\n${body}\n}\n`);
  const result = scanProject(root, 'tsconfig.json', undefined, [], { defaultTransport: ['mcp'], ...options });
  return { tools: result.tools, diagnostics: result.diagnostics };
}

function tool(name: string, returnType: string, extraOptions = ''): string {
  return `
  @ExposeTool({ name: '${name}', displayName: '${name}', modelDescription: '${name}'${extraOptions} })
  async ${name}(): ${returnType} { throw new Error('fixture'); }`;
}

const DATA_SCHEMA = {
  type: 'object',
  properties: {
    count: { type: 'number', description: 'how many items' },
    items: { type: 'array', items: { type: 'string' } },
    note: { type: 'string' },
  },
  required: ['count', 'items'],
};

describe('outputSchema derived from the structured result type', () => {
  it('derives it from Promise<IMcpToolResult<T>>', () => {
    const { tools, diagnostics } = scan(tool('asyncData', 'Promise<IMcpToolResult<IData>>'));

    expect(diagnostics).toEqual([]);
    expect(tools[0].outputSchema).toEqual(DATA_SCHEMA);
  });

  it('derives it from a synchronous IMcpToolResult<T>', () => {
    const { tools } = scan(`
  @ExposeTool({ name: 'syncData', displayName: 'syncData', modelDescription: 'syncData' })
  syncData(): IMcpToolResult<IData> { throw new Error('fixture'); }`);

    expect(tools[0].outputSchema).toEqual(DATA_SCHEMA);
  });

  it('derives it from an inline object type, such as a confirmation { message }', () => {
    const { tools } = scan(tool('confirm', 'Promise<IMcpToolResult<{ message: string }>>'));

    expect(tools[0].outputSchema).toEqual({
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    });
  });

  it('derives it on the @Tool path too', () => {
    const { tools } = scan(`
  @Tool({ name: 'proxied', displayName: 'proxied', modelDescription: 'proxied' })
  async proxied(): Promise<IMcpToolResult<IData>> { throw new Error('fixture'); }`);

    expect(tools[0].outputSchema).toEqual(DATA_SCHEMA);
  });

  it('keeps every repeated type of a schema: a second string[] is an array, not an object', () => {
    const { tools } = scan(`
  @ExposeTool({ name: 'twoLists', displayName: 'twoLists', modelDescription: 'twoLists' })
  async twoLists(params: { steps: string[]; traces?: string[] }): Promise<IMcpToolResult<{ a: string[]; b: string[] }>> { throw new Error('fixture'); }`);

    const input = tools[0].inputSchema as { properties: Record<string, unknown> };
    expect(input.properties.traces).toEqual({ type: 'array', items: { type: 'string' } });
    const output = tools[0].outputSchema as { properties: Record<string, unknown> };
    expect(output.properties.b).toEqual({ type: 'array', items: { type: 'string' } });
  });
});

describe('an explicit outputSchema option', () => {
  it('wins over the derived one', () => {
    const { tools, diagnostics } = scan(tool('explicit', 'Promise<IMcpToolResult<IData>>',
      `, outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }`));

    expect(diagnostics).toEqual([]);
    expect(tools[0].outputSchema).toEqual({ type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] });
  });

  it('is refused, with a diagnostic, when its root is not an object', () => {
    const { tools, diagnostics } = scan(tool('explicitArray', 'Promise<IMcpToolResult<IData>>',
      `, outputSchema: { type: 'array', items: { type: 'string' } }`));

    expect(tools[0].outputSchema).toBeUndefined();
    expect(diagnostics.join('\n')).toMatch(/explicitArray.*outputSchema.*object/);
  });
});

describe('no outputSchema, and a diagnostic naming the tool, when the data type says nothing usable', () => {
  it.each([
    ['untyped', 'Promise<IMcpToolResult>', /untyped.*unknown/],
    ['explicitUnknown', 'Promise<IMcpToolResult<unknown>>', /explicitUnknown.*unknown/],
    ['anyData', 'Promise<IMcpToolResult<any>>', /anyData.*any/],
    ['emptyData', 'Promise<IMcpToolResult<{}>>', /emptyData.*empty object/],
    ['recordData', 'Promise<IMcpToolResult<Record<string, unknown>>>', /recordData.*index signature/],
    ['listData', 'Promise<IMcpToolResult<IData[]>>', /listData.*not an object/],
    ['textData', 'Promise<IMcpToolResult<string>>', /textData.*not an object/],
    ['plainString', 'Promise<string>', /plainString.*structuredContent/],
  ])('%s (%s)', (name, returnType, reason) => {
    const { tools, diagnostics } = scan(tool(name, returnType));

    expect(tools[0].outputSchema).toBeUndefined();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatch(reason);
  });

  it('stays silent for a tool that is not published over MCP', () => {
    const { tools, diagnostics } = scan(tool('lmOnly', 'Promise<string>', `, transports: ['lm']`));

    expect(tools[0].outputSchema).toBeUndefined();
    expect(diagnostics).toEqual([]);
  });
});

describe('a refused root names why', () => {
  it('says an object root is valid in every MCP version, and to wrap the data', () => {
    const { diagnostics } = scan(tool('listData', 'Promise<IMcpToolResult<IData[]>>'));

    expect(diagnostics[0]).toMatch(/every MCP version/);
    expect(diagnostics[0]).toMatch(/2025-11-25/);
    expect(diagnostics[0]).toMatch(/wrap the data in an object/);
  });
});

describe('outputSchema of composed data types', () => {
  const STAMPED = `
type Stamped<T> = T extends unknown
  ? Omit<T, 'warnings' | 'elapsedMs'> & {
    /** what the call noticed */
    warnings: string[];
    /** how long it took */
    elapsedMs: number;
  }
  : never;
`;

  it('expands an intersection of object types into one object', () => {
    const { tools } = scan(tool('intersected', 'Promise<IMcpToolResult<IData & { elapsedMs: number }>>'));
    const schema = tools[0].outputSchema as { properties: Record<string, unknown>; required: string[] };

    expect(Object.keys(schema.properties).sort()).toEqual(['count', 'elapsedMs', 'items', 'note']);
    expect(schema.required.sort()).toEqual(['count', 'elapsedMs', 'items']);
  });

  it('expands the properties of a mapped type such as Omit, keeping their optionality and descriptions', () => {
    const { tools } = scan(tool('omitted', "Promise<IMcpToolResult<Omit<IData, 'items'> & { warnings?: string[] }>>"));

    expect(tools[0].outputSchema).toEqual({
      type: 'object',
      properties: {
        count: { type: 'number', description: 'how many items' },
        note: { type: 'string' },
        warnings: { type: 'array', items: { type: 'string' } },
      },
      required: ['count'],
    });
  });

  it('expands a distributive alias over an object, as a tool stamping its data writes it', () => {
    const { tools, diagnostics } = scan(tool('stamped', 'Promise<IMcpToolResult<Stamped<{ document: string; changed: string[] }>>>'), {}, STAMPED);
    const schema = tools[0].outputSchema as { properties: Record<string, { description?: string }>; required: string[] };

    expect(diagnostics.join('\n')).not.toMatch(/stamped/);
    expect(Object.keys(schema.properties).sort()).toEqual(['changed', 'document', 'elapsedMs', 'warnings']);
    expect(schema.required.sort()).toEqual(['changed', 'document', 'elapsedMs', 'warnings']);
    expect(schema.properties.elapsedMs.description).toBe('how long it took');
  });
});

describe('properties that may be undefined or null', () => {
  it('makes a property typed `T | undefined` optional, without an undefined branch, and keeps null as null', () => {
    const { tools } = scan(tool('loose', 'Promise<IMcpToolResult<{ id: string; description: string | undefined; parent: string | null; size: number | string | undefined }>>'));

    expect(tools[0].outputSchema).toEqual({
      type: 'object',
      properties: {
        id: { type: 'string' },
        description: { type: 'string' },
        parent: { anyOf: [{ type: 'null' }, { type: 'string' }] },
        size: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      },
      required: ['id', 'parent'],
    });
  });
});

describe('outputSchema of results whose branches differ', () => {
  it('keeps every branch of a field that differs between the branches of a result', () => {
    const { tools } = scan(tool('branches', 'Promise<IMcpToolResult<{ passed: true; projects: never[]; done: string } | { passed: boolean; projects: string[]; done: string }>>'));
    const schema = tools[0].outputSchema as { properties: Record<string, unknown>; required: string[] };

    expect(schema.properties.passed).toEqual({ anyOf: [{ type: 'boolean', enum: [true] }, { type: 'boolean' }] });
    expect(schema.properties.projects).toEqual({ anyOf: [{ type: 'array', maxItems: 0 }, { type: 'array', items: { type: 'string' } }] });
    expect(schema.properties.done).toEqual({ type: 'string' });
    expect(schema.required.sort()).toEqual(['done', 'passed', 'projects']);
  });

  it('accepts any JSON value for a field typed unknown or any', () => {
    const { tools } = scan(tool('opaque', 'Promise<IMcpToolResult<{ commandId: string; result: unknown; raw: any }>>'));
    const schema = tools[0].outputSchema as { properties: Record<string, unknown> };

    expect(schema.properties.result).toEqual({});
    expect(schema.properties.raw).toEqual({});
  });
});
