import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { scanProject } from '../../src/scanner';
import type { IScannedTool } from '../../src/scanner';
import { makeTempDir, writeFile } from '../helpers/tmp';

/**
 * A published schema describes the data as it travels as JSON: only the members that reach JSON,
 * the value type of a map, a read-only list as a list, a recursive type defined once and
 * referenced, a boolean as a boolean. Each case is checked on the outputSchema and, where the
 * same conversion serves it, on the inputSchema.
 */

const PRELUDE = `
function ExposeTool(_: unknown): MethodDecorator { return () => undefined; }
interface IText { type: 'text'; text: string }
interface IMcpToolResult<T> {
  content?: IText[];
  structuredContent?: T;
  isError?: boolean;
}
`;

function scan(topLevel: string, body: string): { tools: IScannedTool[]; diagnostics: string[] } {
  const root = makeTempDir();
  writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'commonjs', strict: true, experimentalDecorators: true },
    include: ['src/**/*.ts'],
  }));
  writeFile(path.join(root, 'src', 'tools.ts'), `${PRELUDE}\n${topLevel}\nclass Tools {\n${body}\n}\n`);
  const result = scanProject(root, 'tsconfig.json', undefined, [], { defaultTransport: ['mcp'] });
  return { tools: result.tools, diagnostics: result.diagnostics };
}

function outputOf(topLevel: string, dataType: string): Record<string, any> {
  const { tools, diagnostics } = scan(topLevel, `
  @ExposeTool({ name: 'demo', displayName: 'demo', modelDescription: 'demo' })
  async demo(): Promise<IMcpToolResult<${dataType}>> { throw new Error('fixture'); }`);
  expect(diagnostics).toEqual([]);
  return tools[0].outputSchema as Record<string, any>;
}

function inputOf(topLevel: string, paramsType: string): Record<string, any> {
  const { tools } = scan(topLevel, `
  @ExposeTool({ name: 'demo', displayName: 'demo', modelDescription: 'demo' })
  async demo(params: ${paramsType}): Promise<IMcpToolResult<{ ok: boolean }>> { throw new Error('fixture'); }`);
  return tools[0].inputSchema as Record<string, any>;
}

describe('only the data members of a type are published', () => {
  const MODEL = `
class Resolver { resolve(): string { return ''; } }
class Model {
  /** The id. */
  id = '';
  name?: string;
  private _resolver?: Resolver;
  protected _scope?: Resolver;
  #secret = 1;
  onChange?: () => void;
  resolveOne(): string { return ''; }
  get label(): string { return this.name ?? ''; }
}`;

  // A getter of a class lives on its prototype, and JSON.stringify writes only an object's own fields.
  it('publishes the properties that reach JSON and no method, function, accessor, private or protected member', () => {
    const schema = outputOf(MODEL, '{ model: Model }');
    const model = schema.properties.model;

    expect(Object.keys(model.properties).sort()).toEqual(['id', 'name']);
    expect(model.required).toEqual(['id']);
    expect(model.properties.id).toEqual({ type: 'string', description: 'The id.' });
  });

  it('does the same on the inputSchema', () => {
    const schema = inputOf(MODEL, '{ model: Model }');

    expect(Object.keys(schema.properties.model.properties).sort()).toEqual(['id', 'name']);
  });
});

describe('a map publishes the type of its values', () => {
  it('publishes Record<string, V> as an object whose additionalProperties is the schema of V', () => {
    const schema = outputOf('', '{ idMap: Record<string, string>; counts: { [key: string]: number } }');

    expect(schema.properties.idMap).toEqual({ type: 'object', additionalProperties: { type: 'string' } });
    expect(schema.properties.counts).toEqual({ type: 'object', additionalProperties: { type: 'number' } });
  });

  it('keeps the declared properties beside the index signature', () => {
    const schema = outputOf('interface ISettings { name: string; [key: string]: string }', '{ settings: ISettings }');

    expect(schema.properties.settings).toEqual({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: { type: 'string' },
    });
  });

  it('publishes a map of unknown values with the empty schema as additionalProperties', () => {
    const schema = outputOf('', '{ meta: Record<string, unknown> }');

    expect(schema.properties.meta).toEqual({ type: 'object', additionalProperties: {} });
  });

  it('does the same on the inputSchema', () => {
    const schema = inputOf('', '{ routeParams?: Record<string, string> }');

    expect(schema.properties.routeParams).toEqual({ type: 'object', additionalProperties: { type: 'string' } });
  });
});

describe('the branches of a result merged at the root keep what each says of its other fields', () => {
  it('keeps the value schema of a map branch beside the fields of the other branches', () => {
    const schema = outputOf('', '{ [field: string]: string } | { message: string }');

    expect(schema).toEqual({
      type: 'object',
      properties: { message: { type: 'string' } },
      additionalProperties: { type: 'string' },
    });
  });
});

describe('a read-only list is published as a list', () => {
  it('publishes readonly T[] and ReadonlyArray<T> as arrays', () => {
    const schema = outputOf('', '{ ids: readonly string[]; names: ReadonlyArray<string> }');

    expect(schema.properties.ids).toEqual({ type: 'array', items: { type: 'string' } });
    expect(schema.properties.names).toEqual({ type: 'array', items: { type: 'string' } });
  });

  it('does the same on the inputSchema', () => {
    const schema = inputOf('', '{ visibleIds?: readonly string[] }');

    expect(schema.properties.visibleIds).toEqual({ type: 'array', items: { type: 'string' } });
  });
});

describe('a recursive type is defined once and referenced where it recurs', () => {
  it('references a self-recursive interface from $defs', () => {
    const schema = outputOf('interface INode { name: string; children: INode[] }', '{ root: INode }');

    expect(schema.properties.root).toEqual({ $ref: '#/$defs/INode' });
    expect(schema.$defs.INode).toEqual({
      type: 'object',
      properties: { name: { type: 'string' }, children: { type: 'array', items: { $ref: '#/$defs/INode' } } },
      required: ['name', 'children'],
    });
  });

  it('references a type that recurs through another type', () => {
    const schema = outputOf(
      'interface IFragment { operands: IOperand[] } interface IOperand { label: string; steps: (string | IFragment)[] }',
      '{ fragment: IFragment }',
    );

    expect(schema.properties.fragment).toEqual({ $ref: '#/$defs/IFragment' });
    expect(schema.$defs.IFragment.properties.operands.items.properties.steps.items).toEqual({
      anyOf: [{ type: 'string' }, { $ref: '#/$defs/IFragment' }],
    });
    expect(schema.$defs.IFragment.properties.operands.items.properties.label).toEqual({ type: 'string' });
    expect(Object.keys(schema.$defs)).toEqual(['IFragment']);
  });

  it('publishes a recursive alias such as a JSON value the same way', () => {
    const schema = outputOf(
      'type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };',
      '{ value: JsonValue }',
    );
    const json = {
      anyOf: [
        { type: 'string' },
        { type: 'number' },
        { type: 'boolean' },
        { type: 'null' },
        { type: 'array', items: { $ref: '#/$defs/JsonValue' } },
        { type: 'object', additionalProperties: { $ref: '#/$defs/JsonValue' } },
      ],
    };

    // TypeScript orders the members of a union its own way: the branches are compared as a set.
    const branches = (s: { anyOf: unknown[] }) => s.anyOf.map((b) => JSON.stringify(b)).sort();
    expect(schema.properties.value).toEqual({ $ref: '#/$defs/JsonValue' });
    expect(branches(schema.$defs.JsonValue)).toEqual(branches(json));
  });

  it('expands a recursive type only in its definition: everywhere else it is a $ref', () => {
    const schema = outputOf(
      'interface IContainer { name: string; includes?: IInclude[]; parent?: IContainer } interface IInclude { container: IContainer }',
      '{ project: IContainer; includes: IInclude[] }',
    );

    expect(schema.properties.project).toEqual({ $ref: '#/$defs/IContainer' });
    expect(schema.properties.includes).toEqual({ type: 'array', items: { $ref: '#/$defs/IInclude' } });
    expect(schema.$defs.IContainer.properties.parent).toEqual({ $ref: '#/$defs/IContainer' });
    expect(schema.$defs.IInclude.properties.container).toEqual({ $ref: '#/$defs/IContainer' });
    expect(JSON.stringify(schema).match(/"name":\{"type":"string"\}/g)).toHaveLength(1);
  });

  it('writes no $defs when nothing recurs', () => {
    const schema = outputOf('interface IItem { name: string }', '{ a: IItem; b: IItem[] }');

    expect(schema.$defs).toBeUndefined();
  });

  it('does the same on the inputSchema', () => {
    const schema = inputOf('interface INode { name: string; children?: INode[] }', '{ root: INode }');

    expect(schema.properties.root).toEqual({ $ref: '#/$defs/INode' });
    expect(schema.$defs.INode.properties.children).toEqual({ type: 'array', items: { $ref: '#/$defs/INode' } });
    expect(schema.$defs.INode.properties.name).toEqual({ type: 'string' });
  });
});

describe('a boolean is published as a boolean', () => {
  it('publishes an optional boolean as type boolean', () => {
    const schema = outputOf('', '{ required?: boolean }');

    expect(schema.properties.required).toEqual({ type: 'boolean' });
  });

  it('publishes a field that is true in one branch and false in another as a boolean', () => {
    const schema = outputOf('', '{ performed: false; reason: string } | { performed: true; outcome: string }');

    expect(schema.properties.performed).toEqual({ type: 'boolean' });
  });

  it('publishes the string literals of a mixed union as one enum', () => {
    const schema = outputOf('', "{ verdict: { kind: 'defect'; id: string } | 'defect' | 'gap' | 'legitimate' }");

    expect(schema.properties.verdict).toEqual({
      anyOf: [
        { type: 'object', properties: { kind: { type: 'string', enum: ['defect'] }, id: { type: 'string' } }, required: ['kind', 'id'] },
        { type: 'string', enum: ['defect', 'gap', 'legitimate'] },
      ],
    });
  });

  it('publishes boolean once inside a union', () => {
    const schema = outputOf('', '{ value: string | boolean | string[] }');

    expect(schema.properties.value).toEqual({
      anyOf: [{ type: 'string' }, { type: 'boolean' }, { type: 'array', items: { type: 'string' } }],
    });
  });
});
