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
    expect(Array.isArray(schema.properties.choice.oneOf)).toBe(true);
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
});
