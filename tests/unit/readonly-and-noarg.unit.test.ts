import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { serializeMcpManifest } from '../../src/mcp-manifest';
import { patchPackageJsonContent } from '../../src/patcher';
import { scanProject } from '../../src/scanner';
import type { IScannedTool } from '../../src/scanner';
import { makeTempDir, writeFile } from '../helpers/tmp';

/**
 * The `annotations` option (MCP `ToolAnnotations`, the same shape as the official TypeScript SDK's
 * `registerTool` config) and the inputSchema of a tool that takes no argument
 * (`{ "type": "object", "additionalProperties": false }`, as MCP recommends).
 */

function scanAll(body: string): { tools: IScannedTool[]; diagnostics: string[] } {
  const root = makeTempDir();
  writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'commonjs', strict: true, experimentalDecorators: true },
    include: ['src/**/*.ts'],
  }));
  writeFile(path.join(root, 'src', 'tools.ts'), `
function ExposeTool(_: unknown): MethodDecorator { return () => undefined; }
function Tool(_: unknown): MethodDecorator { return () => undefined; }
interface IEmpty {}
interface IInput { id: string }
class Tools {
${body}
}
`);
  const result = scanProject(root, 'tsconfig.json', undefined, [], { defaultTransport: ['mcp'] });
  return { tools: result.tools, diagnostics: result.diagnostics };
}

const scan = (body: string): IScannedTool[] => scanAll(body).tools;

const decorate = (name: string, extra = '', decorator = 'ExposeTool'): string =>
  `  @${decorator}({ name: '${name}', displayName: '${name}', modelDescription: '${name}'${extra} })`;

describe('the annotations option', () => {
  const { tools, diagnostics } = scanAll(`
${decorate('reader', ', annotations: { readOnlyHint: true }')}
  read(params: IInput): void {}
${decorate('writer', ', annotations: { readOnlyHint: false }')}
  write(params: IInput): void {}
${decorate('unstated')}
  other(params: IInput): void {}
${decorate('proxied', ', annotations: { readOnlyHint: true }', 'Tool')}
  proxied(params: IInput): void {}
${decorate('sloppy', ", annotations: { readOnlyHint: 'yes', colour: 'red' }")}
${decorate('unsupported', ', annotations: { readOnlyHint: true, title: \'T\', destructiveHint: true, idempotentHint: true, openWorldHint: false }')}
  unsupported(params: IInput): void {}
  sloppy(params: IInput): void {}
`);
  const byName = Object.fromEntries(tools.map(t => [t.name, t]));

  it('is read from @ExposeTool and @Tool', () => {
    expect(byName.reader.annotations).toEqual({ readOnlyHint: true });
    expect(byName.writer.annotations).toEqual({ readOnlyHint: false });
    expect(byName.proxied.annotations).toEqual({ readOnlyHint: true });
    expect(byName.unstated.annotations).toBeUndefined();
  });

  it('keeps only readOnlyHint, of the right type, and names what it drops', () => {
    expect(byName.sloppy.annotations).toBeUndefined();
    expect(diagnostics.join('\n')).toMatch(/sloppy.*annotations\.readOnlyHint/);
    expect(diagnostics.join('\n')).toMatch(/sloppy.*annotations\.colour/);
  });

  it('drops the MCP annotations it does not support, keeping readOnlyHint', () => {
    expect(byName.unsupported.annotations).toEqual({ readOnlyHint: true });
    for (const key of ['title', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
      expect(diagnostics.join('\n')).toMatch(new RegExp(`unsupported: annotations\\.${key} ignored — the only supported annotation is readOnlyHint`));
    }
  });

  it('is written into the MCP manifest as is, and not at all when unstated', () => {
    const manifest = JSON.parse(serializeMcpManifest(tools, 'A')) as { tools: Array<Record<string, unknown>> };
    const entry = (name: string) => manifest.tools.find(t => t.name === name)!;

    expect(entry('reader').annotations).toEqual({ readOnlyHint: true });
    expect(entry('writer').annotations).toEqual({ readOnlyHint: false });
    expect(entry('unsupported').annotations).toEqual({ readOnlyHint: true });
    expect(entry('unstated')).not.toHaveProperty('annotations');
  });

  it('never reaches package.json', () => {
    const raw = JSON.stringify({ name: 'sample', contributes: { languageModelTools: [] } });
    const lm = tools.map(t => ({ ...t, transports: ['lm' as const] }));

    const parsed = JSON.parse(patchPackageJsonContent(raw, lm).content) as {
      contributes: { languageModelTools: Array<Record<string, unknown>> };
    };

    for (const entry of parsed.contributes.languageModelTools) {
      expect(entry).not.toHaveProperty('annotations');
    }
  });
});

describe('the inputSchema of a tool that takes no argument', () => {
  const tools = scan(`
${decorate('noParams')}
  none(): void {}
${decorate('emptyType')}
  empty(params: IEmpty): void {}
${decorate('emptyLiteral')}
  emptyLiteral(params: {}): void {}
${decorate('openRecord')}
  open(params: Record<string, unknown>): void {}
${decorate('withField')}
  field(params: IInput): void {}
`);
  const schemaOf = (name: string) => tools.find(t => t.name === name)!.inputSchema;

  it.each(['noParams', 'emptyType', 'emptyLiteral'])('%s accepts only an empty object', (name) => {
    expect(schemaOf(name)).toEqual({ type: 'object', additionalProperties: false });
  });

  it('keeps an index signature open: Record<string, unknown> accepts any field', () => {
    // Open means any field with any value: the empty schema, never `false`.
    expect(schemaOf('openRecord').additionalProperties).toEqual({});
  });

  it('leaves a tool with fields as it was', () => {
    expect(schemaOf('withField')).toEqual({ type: 'object', properties: { id: { type: 'string' } }, required: ['id'] });
  });
});
