import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  CLASS_MARKER_END,
  CLASS_MARKER_START,
  IMPORTS_MARKER_END,
  IMPORTS_MARKER_START,
  METHODS_MARKER_END,
  METHODS_MARKER_START,
  generateProxyFile,
  renderProxyFileFromScaffoldTemplate,
} from '../../src/proxy-generator';
import type { IProxyMethod } from '../../src/proxy-scanner';
import { makeTempDir, writeFile } from '../helpers/tmp';

const scaffold = `${IMPORTS_MARKER_START}
<% for (const line of Array.from(new Set(methods.flatMap((m) => m.importStatements))).sort()) { %><%- line %>
<% } %>${IMPORTS_MARKER_END}

${CLASS_MARKER_START}
export class <%- className %> {
${CLASS_MARKER_END}
${METHODS_MARKER_START}
<% for (const method of methods) { %>
  <%- method.methodName %>(<%- method.parameters.map((p) => p.name + (p.optional ? '?' : '') + ': ' + p.typeText).join(', ') %>): <%- method.returnTypeText %> {
    throw new Error('todo');
  }
<% } %>${METHODS_MARKER_END}
}
`;

function buildMethod(sourceFilePath: string): IProxyMethod {
  return {
    toolName: 'proxyTool',
    methodName: 'run',
    className: 'SourceClass',
    sourceFilePath,
    returnTypeText: 'Promise<ILocal>',
    parameters: [{ name: 'params', typeText: 'ILocal', optional: false }],
    importStatements: [],
    localTypeNames: ['ILocal'],
  };
}

describe('proxy-generator', () => {
  it('renders methods preserving TypeScript syntax in signatures', () => {
    const rendered = renderProxyFileFromScaffoldTemplate([
      {
        ...buildMethod('/tmp/source.ts'),
        localTypeNames: [],
        importStatements: ["import type { IExternal } from './external';"],
      },
    ], scaffold, 'MyProxy');

    expect(rendered).toContain('export class MyProxy');
    expect(rendered).toContain('): Promise<ILocal>');
    expect(rendered).toContain("import type { IExternal } from './external';");
  });

  it('creates a new proxy file and injects local type imports', () => {
    const root = makeTempDir();
    const sourceFilePath = path.join(root, 'src', 'service.ts');
    const outputFilePath = path.join(root, 'src', 'generated-proxy.ts');

    writeFile(sourceFilePath, 'export interface ILocal { name: string }\n');
    writeFile(path.join(root, 'scaffold.ejs'), scaffold);

    const result = generateProxyFile([buildMethod(sourceFilePath)], {
      outputFilePath,
      className: 'GeneratedProxy',
      scaffoldTemplatePath: path.join(root, 'scaffold.ejs'),
      sourceProjectRoot: root,
    });

    expect(result.ok).toBe(true);

    const content = fs.readFileSync(outputFilePath, 'utf-8');
    expect(content).toContain("import type { ILocal } from './service';");
    expect(content).toContain('export class GeneratedProxy');
    expect(content).toContain('run(params: ILocal): Promise<ILocal>');
  });

  it('updates only marker sections on existing files', () => {
    const root = makeTempDir();
    const sourceFilePath = path.join(root, 'src', 'service.ts');
    const outputFilePath = path.join(root, 'src', 'generated-proxy.ts');

    writeFile(sourceFilePath, 'export interface ILocal { name: string }\n');
    writeFile(path.join(root, 'scaffold.ejs'), scaffold);

    writeFile(outputFilePath, `
// manual header
${IMPORTS_MARKER_START}
// old imports
${IMPORTS_MARKER_END}

${CLASS_MARKER_START}
export class OldName {
${CLASS_MARKER_END}
${METHODS_MARKER_START}
// old methods
${METHODS_MARKER_END}
}
// manual footer
`);

    const result = generateProxyFile([buildMethod(sourceFilePath)], {
      outputFilePath,
      className: 'UpdatedProxy',
      scaffoldTemplatePath: path.join(root, 'scaffold.ejs'),
      sourceProjectRoot: root,
    });

    expect(result.ok).toBe(true);

    const content = fs.readFileSync(outputFilePath, 'utf-8');
    expect(content).toContain('// manual header');
    expect(content).toContain('// manual footer');
    expect(content).toContain('export class UpdatedProxy');
    expect(content).toContain('run(params: ILocal): Promise<ILocal>');
  });

  it('returns error when existing file does not expose method markers', () => {
    const root = makeTempDir();
    const sourceFilePath = path.join(root, 'src', 'service.ts');
    const outputFilePath = path.join(root, 'src', 'generated-proxy.ts');

    writeFile(sourceFilePath, 'export interface ILocal { name: string }\n');
    writeFile(path.join(root, 'scaffold.ejs'), scaffold);
    writeFile(outputFilePath, 'export class Broken {}\n');

    const result = generateProxyFile([buildMethod(sourceFilePath)], {
      outputFilePath,
      className: 'Broken',
      scaffoldTemplatePath: path.join(root, 'scaffold.ejs'),
      sourceProjectRoot: root,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('method injection markers');
  });

  it('uses package-root imports for cross-package local types', () => {
    const root = makeTempDir();
    const sourcePackageRoot = path.join(root, 'packages', 'source');
    const targetPackageRoot = path.join(root, 'packages', 'target');

    const sourceFilePath = path.join(sourcePackageRoot, 'src', 'service.ts');
    const outputFilePath = path.join(targetPackageRoot, 'src', 'generated-proxy.ts');

    writeFile(path.join(sourcePackageRoot, 'package.json'), JSON.stringify({ name: '@scope/source' }));
    writeFile(path.join(targetPackageRoot, 'package.json'), JSON.stringify({ name: '@scope/target' }));
    writeFile(sourceFilePath, 'export interface ILocal { name: string }\n');
    writeFile(path.join(root, 'scaffold.ejs'), scaffold);

    const result = generateProxyFile([buildMethod(sourceFilePath)], {
      outputFilePath,
      className: 'CrossPackageProxy',
      scaffoldTemplatePath: path.join(root, 'scaffold.ejs'),
      sourceProjectRoot: sourcePackageRoot,
    });

    expect(result.ok).toBe(true);
    const content = fs.readFileSync(outputFilePath, 'utf-8');
    expect(content).toContain("import type { ILocal } from '@scope/source';");
  });
});
