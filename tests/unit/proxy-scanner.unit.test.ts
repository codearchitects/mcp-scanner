import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { scanProjectForProxies } from '../../src/proxy-scanner';
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

describe('scanProjectForProxies', () => {
  it('returns diagnostic when tsconfig is missing', () => {
    const root = makeTempDir();
    const result = scanProjectForProxies(root, 'missing.json');

    expect(result.methods).toEqual([]);
    expect(result.filesScanned).toBe(0);
    expect(result.diagnostics[0]).toContain('Could not find missing.json');
  });

  it('extracts method metadata, imports and local type references', () => {
    const root = makeTempDir();
    writeBaseProject(root);

    writeFile(path.join(root, 'src', 'external.ts'), 'export interface IExternal { id: string; }\n');

    writeFile(path.join(root, 'src', 'service.ts'), `
import type { IExternal } from './external';

function ExposeTool(_: unknown): MethodDecorator { return () => undefined; }

export interface ILocal {
  name: string;
}

class ProxySource {
  /**
   * Important docs.
   */
  @ExposeTool({ name: 'proxyTool', displayName: 'Proxy Tool', modelDescription: 'Proxy desc' })
  run(params: ILocal, ext?: IExternal): Promise<ILocal> {
    return Promise.resolve(params);
  }
}
`);

    const result = scanProjectForProxies(root);
    expect(result.diagnostics).toEqual([]);
    expect(result.methods).toHaveLength(1);

    const method = result.methods[0];
    expect(method.toolName).toBe('proxyTool');
    expect(method.methodName).toBe('run');
    expect(method.returnTypeText).toBe('Promise<ILocal>');
    expect(method.importStatements).toContain("import type { IExternal } from './external';");
    expect(method.localTypeNames).toContain('ILocal');
    expect(method.parameters).toEqual([
      { name: 'params', typeText: 'ILocal', optional: false },
      { name: 'ext', typeText: 'IExternal', optional: true },
    ]);
    expect(method.jsDoc).toContain('Important docs');
  });

  it('supports search path filtering', () => {
    const root = makeTempDir();
    writeBaseProject(root);

    writeFile(path.join(root, 'src', 'in', 'service.ts'), `
function ExposeTool(_: unknown): MethodDecorator { return () => undefined; }
interface IInput { value: string; }
class InScope {
  @ExposeTool({ name: 'inScope', displayName: 'In Scope', modelDescription: 'In scope' })
  run(params: IInput): Promise<unknown> { return Promise.resolve(params.value); }
}
`);

    writeFile(path.join(root, 'src', 'out', 'service.ts'), `
function ExposeTool(_: unknown): MethodDecorator { return () => undefined; }
interface IInput { value: string; }
class OutScope {
  @ExposeTool({ name: 'outScope', displayName: 'Out Scope', modelDescription: 'Out scope' })
  run(params: IInput): Promise<unknown> { return Promise.resolve(params.value); }
}
`);

    const result = scanProjectForProxies(root, 'tsconfig.json', path.join(root, 'src', 'in'));
    expect(result.methods.map((m) => m.toolName)).toEqual(['inScope']);
  });

  it('supports excluded subtrees filtering', () => {
    const root = makeTempDir();
    writeBaseProject(root);

    writeFile(path.join(root, 'src', 'in', 'service.ts'), `
function ExposeTool(_: unknown): MethodDecorator { return () => undefined; }
interface IInput { value: string; }
class InScope {
  @ExposeTool({ name: 'inScope', displayName: 'In Scope', modelDescription: 'In scope' })
  run(params: IInput): Promise<unknown> { return Promise.resolve(params.value); }
}
`);

    writeFile(path.join(root, 'src', 'out', 'service.ts'), `
function ExposeTool(_: unknown): MethodDecorator { return () => undefined; }
interface IInput { value: string; }
class OutScope {
  @ExposeTool({ name: 'outScope', displayName: 'Out Scope', modelDescription: 'Out scope' })
  run(params: IInput): Promise<unknown> { return Promise.resolve(params.value); }
}
`);

    const result = scanProjectForProxies(
      root,
      'tsconfig.json',
      undefined,
      [path.join(root, 'src', 'out')],
    );
    expect(result.methods.map((m) => m.toolName)).toEqual(['inScope']);
  });

  it('keeps only used symbols from grouped imports', () => {
    const root = makeTempDir();
    writeBaseProject(root);

    writeFile(path.join(root, 'src', 'external.ts'), `
export interface IUsedType { id: string; }
export interface IUnusedType { value: string; }
`);

    writeFile(path.join(root, 'src', 'service.ts'), `
import type { IUnusedType, IUsedType } from './external';

function ExposeTool(_: unknown): MethodDecorator { return () => undefined; }

class ProxySource {
  @ExposeTool({ name: 'proxyTool', displayName: 'Proxy Tool', modelDescription: 'Proxy desc' })
  run(params: IUsedType): Promise<IUsedType> {
    return Promise.resolve(params);
  }
}
`);

    const result = scanProjectForProxies(root);
    expect(result.diagnostics).toEqual([]);
    expect(result.methods).toHaveLength(1);
    expect(result.methods[0].importStatements).toEqual([
      "import type { IUsedType } from './external';",
    ]);
  });

  it('emits diagnostics for methods with ExposeTool missing required name', () => {
    const root = makeTempDir();
    writeBaseProject(root);

    writeFile(path.join(root, 'src', 'broken.ts'), `
function ExposeTool(_: unknown): MethodDecorator { return () => undefined; }
class Broken {
  @ExposeTool({ displayName: 'Broken', modelDescription: 'Broken tool' })
  run(): Promise<unknown> { return Promise.resolve(null); }
}
`);

    const result = scanProjectForProxies(root);
    expect(result.methods).toEqual([]);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0]).toContain("missing required property 'name'");
  });
});
