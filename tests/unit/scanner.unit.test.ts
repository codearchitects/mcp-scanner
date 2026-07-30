import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { scanProject } from '../../src/scanner';
import { makeTempDir, writeFile } from '../helpers/tmp';

function writeBaseProject(root: string): void {
  writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'commonjs',
      strict: true,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
    },
    include: ['src/**/*.ts'],
  }, null, 2));
}

describe('scanProject', () => {
  it('returns diagnostic when tsconfig is missing', () => {
    const root = makeTempDir();
    const result = scanProject(root, 'missing.json');

    expect(result.tools).toEqual([]);
    expect(result.filesScanned).toBe(0);
    expect(result.diagnostics[0]).toContain('Could not find missing.json');
  });

  it('extracts tools and builds JSON schema from first parameter', () => {
    const root = makeTempDir();
    writeBaseProject(root);

    writeFile(path.join(root, 'src', 'tool.ts'), `
function ExposeTool(_: unknown): MethodDecorator {
  return () => undefined;
}

interface IInput {
  /** user name */
  name: string;
  count?: number;
  mode: 'fast' | 'safe';
}

class ToolService {
  @ExposeTool({
    name: 'myTool',
    displayName: 'My Tool',
    modelDescription: 'Runs my tool',
  })
  run(input: IInput): string {
    return input.name;
  }
}
`);

    const result = scanProject(root);
    expect(result.diagnostics).toEqual([]);
    expect(result.tools).toHaveLength(1);

    const scanned = result.tools[0];
    expect(scanned.name).toBe('myTool');
    expect(scanned.displayName).toBe('My Tool');

    const schema = scanned.inputSchema as {
      properties: Record<string, { type?: string; enum?: string[]; description?: string }>;
      required?: string[];
    };

    expect(schema.properties.name.type).toBe('string');
    expect(schema.properties.name.description).toBe('user name');
    expect(schema.properties.count.type).toBe('number');
    expect(schema.properties.mode.enum).toEqual(['fast', 'safe']);
    expect(schema.required).toEqual(['name', 'mode']);
  });

  it('filters scanned files by tools search path', () => {
    const root = makeTempDir();
    writeBaseProject(root);

    writeFile(path.join(root, 'src', 'included', 'tool.ts'), `
function ExposeTool(_: unknown): MethodDecorator { return () => undefined; }
interface IInput { value: string; }
class Included {
  @ExposeTool({ name: 'includedTool', displayName: 'Included', modelDescription: 'Included tool' })
  run(input: IInput): string { return input.value; }
}
`);

    writeFile(path.join(root, 'src', 'excluded', 'tool.ts'), `
function ExposeTool(_: unknown): MethodDecorator { return () => undefined; }
interface IInput { value: string; }
class Excluded {
  @ExposeTool({ name: 'excludedTool', displayName: 'Excluded', modelDescription: 'Excluded tool' })
  run(input: IInput): string { return input.value; }
}
`);

    const result = scanProject(root, 'tsconfig.json', path.join(root, 'src', 'included'));
    expect(result.tools.map((t) => t.name)).toEqual(['includedTool']);
  });

  it('scans multiple search subtrees when given an array of paths', () => {
    const root = makeTempDir();
    writeBaseProject(root);

    writeFile(path.join(root, 'src', 'a', 'tool.ts'), `
function ExposeTool(_: unknown): MethodDecorator { return () => undefined; }
interface IInput { value: string; }
class A {
  @ExposeTool({ name: 'aTool', displayName: 'A', modelDescription: 'A tool' })
  run(input: IInput): string { return input.value; }
}
`);

    writeFile(path.join(root, 'src', 'b', 'tool.ts'), `
function ExposeTool(_: unknown): MethodDecorator { return () => undefined; }
interface IInput { value: string; }
class B {
  @ExposeTool({ name: 'bTool', displayName: 'B', modelDescription: 'B tool' })
  run(input: IInput): string { return input.value; }
}
`);

    writeFile(path.join(root, 'src', 'c', 'tool.ts'), `
function ExposeTool(_: unknown): MethodDecorator { return () => undefined; }
interface IInput { value: string; }
class C {
  @ExposeTool({ name: 'cTool', displayName: 'C', modelDescription: 'C tool' })
  run(input: IInput): string { return input.value; }
}
`);

    const result = scanProject(root, 'tsconfig.json', [
      path.join(root, 'src', 'a'),
      path.join(root, 'src', 'b'),
    ]);

    expect(result.tools.map((t) => t.name).sort()).toEqual(['aTool', 'bTool']);
  });

  it('excludes tools in configured exclude subtrees', () => {
    const root = makeTempDir();
    writeBaseProject(root);

    writeFile(path.join(root, 'src', 'included', 'tool.ts'), `
function ExposeTool(_: unknown): MethodDecorator { return () => undefined; }
interface IInput { value: string; }
class Included {
  @ExposeTool({ name: 'includedTool', displayName: 'Included', modelDescription: 'Included tool' })
  run(input: IInput): string { return input.value; }
}
`);

    writeFile(path.join(root, 'src', 'excluded', 'tool.ts'), `
function ExposeTool(_: unknown): MethodDecorator { return () => undefined; }
interface IInput { value: string; }
class Excluded {
  @ExposeTool({ name: 'excludedTool', displayName: 'Excluded', modelDescription: 'Excluded tool' })
  run(input: IInput): string { return input.value; }
}
`);

    const result = scanProject(
      root,
      'tsconfig.json',
      undefined,
      [path.join(root, 'src', 'excluded')],
    );

    expect(result.tools.map((t) => t.name)).toEqual(['includedTool']);
  });

  it('emits diagnostics for incomplete decorator metadata', () => {
    const root = makeTempDir();
    writeBaseProject(root);

    writeFile(path.join(root, 'src', 'broken.ts'), `
function ExposeTool(_: unknown): MethodDecorator { return () => undefined; }
interface IInput { value: string; }
class Broken {
  @ExposeTool({ name: 'brokenTool', displayName: 'Broken Tool' })
  run(input: IInput): string { return input.value; }
}
`);

    const result = scanProject(root);
    expect(result.tools).toEqual([]);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0]).toContain('missing required property');
  });

  it('supports advanced schema branches and optional decorator options', () => {
    const root = makeTempDir();
    writeBaseProject(root);

    writeFile(path.join(root, 'src', 'advanced.ts'), `
function ExposeTool(_: unknown): MethodDecorator { return () => undefined; }

type IAlias = {
  /** flag doc */
  flag: boolean;
  values: string[];
  values2: Array<number>;
  status: 'ok' | 'ko';
  choice: 1 | 'x';
  amount: 5;
  literalFlag: true;
  bag: Record<string, string>;
  nested: { deep: string };
};

class Advanced {
  @ExposeTool({
    name: 'advancedTool',
    displayName: 'Advanced Tool',
    modelDescription: 'Advanced schema branches',
    icon: '$(beaker)',
    canBeReferencedInPrompt: false,
  })
  run(input: IAlias): string {
    return input.status;
  }

  @ExposeTool({
    name: 'noParamTool',
    displayName: 'No Param Tool',
    modelDescription: 'No first parameter',
  })
  noParams(): void {
    return;
  }
}
`);

    const result = scanProject(root);
    expect(result.diagnostics).toEqual([]);
    expect(result.tools.map((t) => t.name)).toEqual(['advancedTool', 'noParamTool']);

    const advanced = result.tools.find((t) => t.name === 'advancedTool');
    expect(advanced?.icon).toBe('$(beaker)');
    expect(advanced?.canBeReferencedInPrompt).toBe(false);

    const schema = advanced?.inputSchema as {
      properties: Record<string, Record<string, unknown>>;
      required?: string[];
    };

    expect(schema.properties.flag.type).toBe('boolean');
    expect(schema.properties.flag.description).toBe('flag doc');
    expect(schema.properties.values.type).toBe('array');
    expect((schema.properties.values.items as Record<string, unknown>).type).toBe('string');
    expect(schema.properties.values2.type).toBe('array');
    expect((schema.properties.values2.items as Record<string, unknown>).type).toBe('number');
    expect(schema.properties.status.enum).toEqual(['ok', 'ko']);
    expect(Array.isArray(schema.properties.choice.anyOf)).toBe(true);
    expect(schema.properties.amount.enum).toEqual([5]);
    expect(schema.properties.literalFlag.type).toBe('boolean');
    expect(schema.properties.bag.type).toBe('object');
    expect((schema.properties.nested.properties as Record<string, unknown>).deep).toBeTruthy();

    const noParam = result.tools.find((t) => t.name === 'noParamTool');
    expect(noParam?.inputSchema).toEqual({ type: 'object', properties: {} });
  });

  it('extracts tools and schema from @Tool decorated methods', () => {
    const root = makeTempDir();
    writeBaseProject(root);

    writeFile(path.join(root, 'src', 'tool-decorator.ts'), `
function Tool(_: unknown): MethodDecorator { return () => undefined; }

interface ICreateNodeParams {
  /** node type id */
  nodeType: string;
  retries?: number;
}

class ProxyTools {
  @Tool({
    name: 'createNode',
    displayName: 'Create Node',
    modelDescription: 'Create node in model',
    icon: '$(symbol-method)',
    canBeReferencedInPrompt: false,
  })
  createNode(params: ICreateNodeParams): Promise<unknown> {
    return Promise.resolve(params);
  }
}
`);

    const result = scanProject(root);
    expect(result.diagnostics).toEqual([]);
    expect(result.tools).toHaveLength(1);

    const scanned = result.tools[0];
    expect(scanned.name).toBe('createNode');
    expect(scanned.displayName).toBe('Create Node');
    expect(scanned.icon).toBe('$(symbol-method)');
    expect(scanned.canBeReferencedInPrompt).toBe(false);

    const schema = scanned.inputSchema as {
      properties: Record<string, { type?: string; description?: string }>;
      required?: string[];
    };

    expect(schema.properties.nodeType.type).toBe('string');
    expect(schema.properties.nodeType.description).toBe('node type id');
    expect(schema.properties.retries.type).toBe('number');
    expect(schema.required).toEqual(['nodeType']);
  });

  it('skips @Tool methods with incomplete required metadata', () => {
    const root = makeTempDir();
    writeBaseProject(root);

    writeFile(path.join(root, 'src', 'tool-incomplete.ts'), `
function Tool(_: unknown): MethodDecorator { return () => undefined; }
interface IInput { value: string; }

class PartialProxyTools {
  @Tool({
    name: 'missingDescription',
    displayName: 'Missing Description',
  })
  run(input: IInput): string {
    return input.value;
  }
}
`);

    const result = scanProject(root);
    expect(result.tools).toEqual([]);
    // @Tool branch intentionally skips incomplete metadata silently
    expect(result.diagnostics).toEqual([]);
  });

  it('expands imported interface schemas (not just object)', () => {
    const root = makeTempDir();
    writeBaseProject(root);

    // First file: defines the interface
    writeFile(path.join(root, 'src', 'types.ts'), `
export interface ICreateNodeParams {
  /** node type id */
  nodeType: string;
  retries?: number;
  mode: 'fast' | 'slow';
}
`);

    // Second file: imports and uses the interface
    writeFile(path.join(root, 'src', 'tools.ts'), `
import { ICreateNodeParams } from './types';

function ExposeTool(_: unknown): MethodDecorator { return () => undefined; }

class MyTools {
  @ExposeTool({
    name: 'createNode',
    displayName: 'Create Node',
    modelDescription: 'Create a node',
  })
  createNode(params: ICreateNodeParams): Promise<void> {
    return Promise.resolve();
  }
}
`);

    const result = scanProject(root);
    expect(result.diagnostics).toEqual([]);
    expect(result.tools).toHaveLength(1);

    const scanned = result.tools[0];
    const schema = scanned.inputSchema as {
      type: string;
      properties: Record<string, { type?: string; description?: string; enum?: string[] }>;
      required?: string[];
    };

    // CRITICAL: Should have expanded properties, not just { type: 'object' }
    expect(schema.type).toBe('object');
    expect(schema.properties).toBeDefined();
    expect(Object.keys(schema.properties).length).toBeGreaterThan(0);
    expect(schema.properties.nodeType.type).toBe('string');
    expect(schema.properties.nodeType.description).toBe('node type id');
    expect(schema.properties.retries.type).toBe('number');
    expect(schema.properties.mode.enum).toEqual(['fast', 'slow']);
    expect(schema.required).toEqual(['nodeType', 'mode']);
  });

  it('expands imported interface with multiple optional and required fields', () => {
    const root = makeTempDir();
    writeBaseProject(root);

    // Define imported type with mixed optional/required fields
    writeFile(path.join(root, 'src', 'types.ts'), `
export interface IOperationParams {
  id: string;
  count?: number;
  action: 'create' | 'update' | 'delete';
}
`);

    // Import and use type
    writeFile(path.join(root, 'src', 'ops.ts'), `
import { IOperationParams } from './types';

function ExposeTool(_: unknown): MethodDecorator { return () => undefined; }

class OpsService {
  @ExposeTool({
    name: 'performOp',
    displayName: 'Perform Operation',
    modelDescription: 'Perform an operation',
  })
  perform(params: IOperationParams): Promise<void> {
    return Promise.resolve();
  }
}
`);

    const result = scanProject(root);
    expect(result.diagnostics).toEqual([]);
    expect(result.tools).toHaveLength(1);

    const scanned = result.tools[0];
    const schema = scanned.inputSchema as {
      type: string;
      properties: Record<string, any>;
      required?: string[];
    };

    // Verify properties are expanded
    expect(schema.properties.id.type).toBe('string');
    expect(schema.properties.count.type).toBe('number');
    expect(schema.properties.action.type).toBe('string');
    expect(schema.properties.action.enum).toEqual(['create', 'update', 'delete']);
    
    // Only id and action are required (count is optional)
    expect(schema.required).toEqual(['id', 'action']);
  });

  it('uses Type API for imported types that getSymbol cannot resolve', () => {
    const root = makeTempDir();
    writeBaseProject(root);

    // Create separate files to ensure symbol resolution requires Type API
    writeFile(path.join(root, 'src', 'models.ts'), `
export interface IPerson {
  name: string;
  age: number;
}
`);

    writeFile(path.join(root, 'src', 'service.ts'), `
import type { IPerson } from './models';

function ExposeTool(_: unknown): MethodDecorator { return () => undefined; }

class PersonService {
  @ExposeTool({
    name: 'getPerson',
    displayName: 'Get Person',
    modelDescription: 'Get person by query',
  })
  get(query: IPerson): Promise<void> {
    return Promise.resolve();
  }
}
`);

    const result = scanProject(root);
    expect(result.diagnostics).toEqual([]);
    expect(result.tools).toHaveLength(1);

    const scanned = result.tools[0];
    const schema = scanned.inputSchema as {
      type: string;
      properties: Record<string, { type?: string }>;
      required?: string[];
    };

    // Verify the Type API resolved the properties correctly
    expect(schema.properties.name.type).toBe('string');
    expect(schema.properties.age.type).toBe('number');
    expect(schema.required).toEqual(['name', 'age']);
  });

  it('handles union types with mixed members (non-string literals)', () => {
    const root = makeTempDir();
    writeBaseProject(root);

    writeFile(path.join(root, 'src', 'service.ts'), `
function ExposeTool(_: unknown): MethodDecorator { return () => undefined; }

interface IMixedUnion {
  value: string | number | boolean;
}

class MixedService {
  @ExposeTool({
    name: 'mixedOp',
    displayName: 'Mixed Operation',
    modelDescription: 'Operation with mixed union',
  })
  op(input: IMixedUnion): Promise<void> {
    return Promise.resolve();
  }
}
`);

    const result = scanProject(root);
    expect(result.diagnostics).toEqual([]);
    expect(result.tools).toHaveLength(1);

    const scanned = result.tools[0];
    const schema = scanned.inputSchema as {
      properties: Record<string, { anyOf?: any[] }>;
    };

    // Mixed union should have anyOf
    expect(Array.isArray(schema.properties.value.anyOf)).toBe(true);
    expect(schema.properties.value.anyOf.length).toBeGreaterThanOrEqual(3);
  });

  it('handles literal boolean type in schema generation', () => {
    const root = makeTempDir();
    writeBaseProject(root);

    writeFile(path.join(root, 'src', 'service.ts'), `
function ExposeTool(_: unknown): MethodDecorator { return () => undefined; }

interface IBoolLiteral {
  enabled: true;
  disabled: false;
}

class BoolService {
  @ExposeTool({
    name: 'boolOp',
    displayName: 'Bool Operation',
    modelDescription: 'Operation with bool literals',
  })
  op(input: IBoolLiteral): Promise<void> {
    return Promise.resolve();
  }
}
`);

    const result = scanProject(root);
    expect(result.diagnostics).toEqual([]);
    expect(result.tools).toHaveLength(1);

    const scanned = result.tools[0];
    const schema = scanned.inputSchema as {
      properties: Record<string, { type?: string; enum?: boolean[] }>;
    };

    expect(schema.properties.enabled.type).toBe('boolean');
    expect(schema.properties.enabled.enum).toEqual([true]);
    expect(schema.properties.disabled.type).toBe('boolean');
    expect(schema.properties.disabled.enum).toEqual([false]);
  });

  it('covers all type flag branches in schema generation', () => {
    const root = makeTempDir();
    writeBaseProject(root);

    writeFile(path.join(root, 'src', 'all-types.ts'), `
function ExposeTool(_: unknown): MethodDecorator { return () => undefined; }

interface IAllTypes {
  stringField: string;
  numberField: number;
  boolField: boolean;
  stringLiteral: 'value1' | 'value2';
  numberLiteral: 42;
  trueLiteral: true;
  falseLiteral: false;
  stringArray: string[];
  numberArray: number[];
  boolArray: boolean[];
  mixedUnion: string | number;
  emptyOptional?: never;
  dictField: Record<string, string>;
}

class AllTypesService {
  @ExposeTool({
    name: 'allTypes',
    displayName: 'All Types',
    modelDescription: 'Test all type branches',
  })
  test(input: IAllTypes): Promise<void> {
    return Promise.resolve();
  }
}
`);

    const result = scanProject(root);
    expect(result.diagnostics).toEqual([]);
    expect(result.tools).toHaveLength(1);

    const scanned = result.tools[0];
    const schema = scanned.inputSchema as {
      properties: Record<string, any>;
      required?: string[];
    };

    // All primitive types
    expect(schema.properties.stringField.type).toBe('string');
    expect(schema.properties.numberField.type).toBe('number');
    expect(schema.properties.boolField.type).toBe('boolean');

    // Literals
    expect(schema.properties.stringLiteral.enum).toEqual(['value1', 'value2']);
    expect(schema.properties.numberLiteral.enum).toEqual([42]);
    expect(schema.properties.trueLiteral.enum).toEqual([true]);
    expect(schema.properties.falseLiteral.enum).toEqual([false]);

    // Arrays
    expect(schema.properties.stringArray.type).toBe('array');
    expect(schema.properties.stringArray.items.type).toBe('string');
    expect(schema.properties.numberArray.type).toBe('array');
    expect(schema.properties.numberArray.items.type).toBe('number');
    expect(schema.properties.boolArray.type).toBe('array');
    expect(schema.properties.boolArray.items.type).toBe('boolean');

    // Union
    expect(schema.properties.mixedUnion.anyOf).toBeDefined();

    // Record type
    expect(schema.properties.dictField.type).toBe('object');

    // Verify required fields (optional fields should not be in required)
    expect(schema.required).toContain('stringField');
    expect(schema.required).not.toContain('emptyOptional');
  });

  it('emits anyOf for UpdateNodeParams newValue primitive union', () => {
    const root = makeTempDir();
    writeBaseProject(root);

    writeFile(path.join(root, 'src', 'update-node.ts'), `
function ExposeTool(_: unknown): MethodDecorator { return () => undefined; }

interface UpdateNodeParams {
  nodeId: string;
  changes: {
    propertyKey: string;
    newValue?: string | number | boolean;
  }[];
}

class UpdateNodeService {
  @ExposeTool({
    name: 'updateNode',
    displayName: 'Update Node',
    modelDescription: 'Update node properties',
  })
  update(input: UpdateNodeParams): Promise<void> {
    return Promise.resolve();
  }
}
`);

    const result = scanProject(root);
    expect(result.diagnostics).toEqual([]);
    expect(result.tools).toHaveLength(1);

    const scanned = result.tools[0];
    const schema = scanned.inputSchema as {
      properties: Record<string, any>;
    };

    const newValueSchema = schema.properties.changes.items.properties.newValue as {
      anyOf?: Array<Record<string, unknown>>;
    };

    expect(Array.isArray(newValueSchema.anyOf)).toBe(true);
    expect(newValueSchema.anyOf?.some((s) => s.type === 'string')).toBe(true);
    expect(newValueSchema.anyOf?.some((s) => s.type === 'number')).toBe(true);
    expect(newValueSchema.anyOf?.some((s) => s.type === 'boolean')).toBe(true);
  });

  it('optional object parameter (`params?: IFoo`) still emits root type:"object" with all props optional', () => {
    const root = makeTempDir();
    writeBaseProject(root);

    writeFile(path.join(root, 'src', 'optional.ts'), `
function ExposeTool(_: unknown): MethodDecorator { return () => undefined; }

interface INodeContextListParams {
  filter: string;
  limit?: number;
}

class Svc {
  @ExposeTool({
    name: 'listOptional',
    displayName: 'List Optional',
    modelDescription: 'List with optional params',
  })
  list(params?: INodeContextListParams): string { return String(params); }
}
`);

    const result = scanProject(root);
    expect(result.diagnostics).toEqual([]);
    expect(result.tools).toHaveLength(1);

    const schema = result.tools[0].inputSchema as {
      type?: string;
      anyOf?: unknown;
      properties?: Record<string, { type?: string }>;
      required?: string[];
    };

    // Root MUST be a plain object schema — never a root-level anyOf.
    expect(schema.type).toBe('object');
    expect(schema.anyOf).toBeUndefined();
    expect(schema.properties).toBeDefined();
    expect(schema.properties!.filter.type).toBe('string');
    expect(schema.properties!.limit.type).toBe('number');
    // Because the whole parameter is optional, every property becomes optional at the root.
    expect(schema.required).toBeUndefined();
  });

  it('required object parameter (`params: IFoo`) preserves required list at the root', () => {
    const root = makeTempDir();
    writeBaseProject(root);

    writeFile(path.join(root, 'src', 'required.ts'), `
function ExposeTool(_: unknown): MethodDecorator { return () => undefined; }

interface IFoo {
  id: string;
  count?: number;
}

class Svc {
  @ExposeTool({
    name: 'runRequired',
    displayName: 'Run Required',
    modelDescription: 'Required params',
  })
  run(params: IFoo): string { return params.id; }
}
`);

    const result = scanProject(root);
    expect(result.diagnostics).toEqual([]);
    const schema = result.tools[0].inputSchema as {
      type?: string;
      properties?: Record<string, { type?: string }>;
      required?: string[];
    };
    expect(schema.type).toBe('object');
    expect(schema.properties!.id.type).toBe('string');
    expect(schema.properties!.count.type).toBe('number');
    expect(schema.required).toEqual(['id']);
  });

  it('parameter with default initializer (`params: IFoo = {}`) is equivalent to required at the root', () => {
    const root = makeTempDir();
    writeBaseProject(root);

    writeFile(path.join(root, 'src', 'default-init.ts'), `
function ExposeTool(_: unknown): MethodDecorator { return () => undefined; }

interface IFoo {
  id: string;
  count?: number;
}

class Svc {
  @ExposeTool({
    name: 'runDefaultInit',
    displayName: 'Run Default Init',
    modelDescription: 'Default init params',
  })
  run(params: IFoo = {} as IFoo): string { return params.id; }
}
`);

    const result = scanProject(root);
    expect(result.diagnostics).toEqual([]);
    const schema = result.tools[0].inputSchema as {
      type?: string;
      anyOf?: unknown;
      properties?: Record<string, { type?: string }>;
      required?: string[];
    };
    expect(schema.type).toBe('object');
    expect(schema.anyOf).toBeUndefined();
    expect(schema.properties!.id.type).toBe('string');
    expect(schema.properties!.count.type).toBe('number');
    expect(schema.required).toEqual(['id']);
  });

  it('nested union INSIDE an object still emits its anyOf — only the ROOT is constrained', () => {
    const root = makeTempDir();
    writeBaseProject(root);

    writeFile(path.join(root, 'src', 'nested-union.ts'), `
function ExposeTool(_: unknown): MethodDecorator { return () => undefined; }

interface IFoo {
  filter: string;
  choice: 1 | 'x';
}

class Svc {
  @ExposeTool({
    name: 'runNested',
    displayName: 'Run Nested',
    modelDescription: 'Nested union',
  })
  run(params?: IFoo): string { return String(params); }
}
`);

    const result = scanProject(root);
    expect(result.diagnostics).toEqual([]);
    const schema = result.tools[0].inputSchema as {
      type?: string;
      properties?: Record<string, { anyOf?: unknown[]; type?: string }>;
    };
    expect(schema.type).toBe('object');
    // Nested unions remain legal — only the root shape is normalized.
    expect(Array.isArray(schema.properties!.choice.anyOf)).toBe(true);
    expect(schema.properties!.filter.type).toBe('string');
  });

  it('defaults transports to ["lm"] when the decorator omits it', () => {
    const root = makeTempDir();
    writeBaseProject(root);

    writeFile(path.join(root, 'src', 'tool.ts'), `
function ExposeTool(_: unknown): MethodDecorator { return () => undefined; }
interface IInput { value: string; }
class ToolService {
  @ExposeTool({ name: 'lmTool', displayName: 'LM Tool', modelDescription: 'Default transport' })
  run(input: IInput): string { return input.value; }
}
`);

    const result = scanProject(root);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].transports).toEqual(['lm']);
    expect(result.tools[0].mcpServers).toBeUndefined();
  });

  it('reads explicit transports and mcpServers from the decorator', () => {
    const root = makeTempDir();
    writeBaseProject(root);

    writeFile(path.join(root, 'src', 'tool.ts'), `
function ExposeTool(_: unknown): MethodDecorator { return () => undefined; }
interface IInput { value: string; }
class ToolService {
  @ExposeTool({
    name: 'mcpTool',
    displayName: 'MCP Tool',
    modelDescription: 'MCP-only tool',
    transports: ['mcp'],
    mcpServers: ['serverA', 'serverB'],
  })
  run(input: IInput): string { return input.value; }
}
`);

    const result = scanProject(root);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].transports).toEqual(['mcp']);
    expect(result.tools[0].mcpServers).toEqual(['serverA', 'serverB']);
  });

  it('applies defaultTransport option to tools without explicit transports', () => {
    const root = makeTempDir();
    writeBaseProject(root);

    writeFile(path.join(root, 'src', 'tool.ts'), `
function ExposeTool(_: unknown): MethodDecorator { return () => undefined; }
interface IInput { value: string; }
class ToolService {
  @ExposeTool({ name: 'implicit', displayName: 'Implicit', modelDescription: 'No transports' })
  run(input: IInput): string { return input.value; }

  @ExposeTool({ name: 'explicit', displayName: 'Explicit', modelDescription: 'Has transports', transports: ['lm'] })
  run2(input: IInput): string { return input.value; }
}
`);

    const result = scanProject(root, 'tsconfig.json', undefined, [], { defaultTransport: ['mcp'] });
    const implicit = result.tools.find((t) => t.name === 'implicit');
    const explicit = result.tools.find((t) => t.name === 'explicit');
    expect(implicit?.transports).toEqual(['mcp']);
    expect(explicit?.transports).toEqual(['lm']);
  });
});
