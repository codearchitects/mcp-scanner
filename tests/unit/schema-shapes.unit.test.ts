import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { serializeMcpManifest } from '../../src/mcp-manifest';
import { scanProject } from '../../src/scanner';
import type { IScannedTool } from '../../src/scanner';
import { makeTempDir, writeFile } from '../helpers/tmp';

/**
 * The shapes a schema states beyond types: a manifest that does not depend on the line endings of
 * the checkout, a field that must never be given, a field that is only read, a list of fixed shape.
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

function scanSource(source: string): IScannedTool[] {
  const root = makeTempDir();
  writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'commonjs', strict: true, experimentalDecorators: true },
    include: ['src/**/*.ts'],
  }));
  writeFile(path.join(root, 'src', 'tools.ts'), source);
  const result = scanProject(root, 'tsconfig.json', undefined, [], { defaultTransport: ['mcp'] });
  expect(result.diagnostics).toEqual([]);
  return result.tools;
}

function tool(topLevel: string, paramsType: string, dataType: string): IScannedTool {
  return scanSource(`${PRELUDE}\n${topLevel}\nclass Tools {
  @ExposeTool({ name: 'demo', displayName: 'demo', modelDescription: 'demo' })
  async demo(params: ${paramsType}): Promise<IMcpToolResult<${dataType}>> { throw new Error('fixture'); }
}\n`)[0];
}

describe('a manifest is the same whatever the line endings of the checkout (§REQ:MCP-PBLS-SCHM-FDLT-GSR-120)', () => {
  const SOURCE = `${PRELUDE}
/**
 * A node of the model.
 * It has a name.
 */
interface INode {
  /**
   * The name,
   * on two lines.
   */
  name: string;
}
class Tools {
  /**
   * Reads a node.
   * @param params What to read.
   */
  @ExposeTool({ name: 'demo', displayName: 'demo', modelDescription: 'demo' })
  async demo(params: { /** Which node,\n   * by id. */ id: string }): Promise<IMcpToolResult<{ node: INode }>> { throw new Error('fixture'); }
}
`;

  it('publishes no carriage return from a source with Windows line endings', () => {
    const manifest = serializeMcpManifest(scanSource(SOURCE.replace(/\n/g, '\r\n')), 'demo');
    expect(JSON.parse(manifest)).toBeDefined();
    expect(manifest).not.toContain('\\r');
  });

  it('writes the same manifest from Windows and Unix line endings', () => {
    const windows = serializeMcpManifest(scanSource(SOURCE.replace(/\n/g, '\r\n')), 'demo');
    const unix = serializeMcpManifest(scanSource(SOURCE), 'demo');
    expect(windows).toBe(unix);
  });
});

describe('a field that must never be given is refused by the schema (§REQ:C4-MDLR-MNGD-FLDS-SRU-030)', () => {
  it('publishes a property typed never as the schema false, outside required', () => {
    const input = tool('', '{ models: Array<{ name: string; id?: never; children?: never; [key: string]: unknown }> }', '{ ok: boolean }').inputSchema as Record<string, any>;
    const item = input.properties.models.items;
    expect(item.properties.id).toBe(false);
    expect(item.properties.children).toBe(false);
    expect(item.properties.name).toEqual({ type: 'string' });
    expect(item.required).toEqual(['name']);
  });

  it('serializes it as false in the manifest', () => {
    const manifest = JSON.parse(serializeMcpManifest([tool('', '{ name: string; id?: never }', '{ ok: boolean }')], 'demo'));
    expect(manifest.tools[0].inputSchema.properties.id).toBe(false);
  });
});

describe('a field that is only read is marked readOnly (§REQ:C4-MDLR-MNGD-FLDS-TJR-060)', () => {
  it('writes readOnly true for a readonly property and for one documented with @readonly', () => {
    const output = tool('', '{ id: string }', `{
      readonly children: string[];
      /** The edges. @readonly */
      interactions: string[];
      name: string;
    }`).outputSchema as Record<string, any>;
    expect(output.properties.children).toMatchObject({ type: 'array', readOnly: true });
    expect(output.properties.interactions).toMatchObject({ type: 'array', readOnly: true, description: 'The edges.' });
    expect(output.properties.name).not.toHaveProperty('readOnly');
  });
});

describe('a fixed-shape list is published as a tuple (§REQ:MCP-PBLS-SCHM-FDLT-GSR-130)', () => {
  it('gives each position its schema, counts the required and the optional positions, and allows nothing more', () => {
    const output = tool('', '{ id: string }', '{ edges: Array<[string, string, string, { description?: string }?]> }').outputSchema as Record<string, any>;
    expect(output.properties.edges.items).toEqual({
      type: 'array',
      prefixItems: [{ type: 'string' }, { type: 'string' }, { type: 'string' }, { type: 'object', properties: { description: { type: 'string' } } }],
      minItems: 3,
      maxItems: 4,
      items: false,
    });
  });

  it('publishes the rest element of a tuple as its items, with no maximum', () => {
    const output = tool('', '{ id: string }', '{ row: readonly [string, ...number[]] }').outputSchema as Record<string, any>;
    expect(output.properties.row).toEqual({ type: 'array', prefixItems: [{ type: 'string' }], minItems: 1, items: { type: 'number' } });
  });
});
