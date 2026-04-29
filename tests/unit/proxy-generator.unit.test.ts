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
    toolOptions: undefined,
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

  it('rewrites relative signature imports to the proxy output location', () => {
    const root = makeTempDir();
    const sourceFilePath = path.join(root, 'src', 'features', 'services', 'tool-service.ts');
    const outputFilePath = path.join(root, 'src', 'generated', 'generated-proxy.ts');

    writeFile(path.join(root, 'src', 'hooks', 'index.ts'), 'export interface ISelectedArtifactSnapshot { id: string }\n');
    writeFile(sourceFilePath, 'export interface ILocal { name: string }\n');
    writeFile(path.join(root, 'scaffold.ejs'), scaffold);

    const method = buildMethod(sourceFilePath);
    method.importStatements = ["import type { ISelectedArtifactSnapshot } from '../../hooks';"];

    const result = generateProxyFile([method], {
      outputFilePath,
      className: 'RewriteProxy',
      scaffoldTemplatePath: path.join(root, 'scaffold.ejs'),
      sourceProjectRoot: root,
    });

    expect(result.ok).toBe(true);
    const content = fs.readFileSync(outputFilePath, 'utf-8');
    expect(content).toContain("import type { ISelectedArtifactSnapshot } from '../hooks';");
  });

  it('rewrites relative signature imports to package root in cross-package output', () => {
    const root = makeTempDir();
    const sourcePackageRoot = path.join(root, 'packages', 'source');
    const targetPackageRoot = path.join(root, 'packages', 'target');

    const sourceFilePath = path.join(sourcePackageRoot, 'src', 'services', 'tool-service.ts');
    const outputFilePath = path.join(targetPackageRoot, 'src', 'generated', 'generated-proxy.ts');

    writeFile(path.join(sourcePackageRoot, 'package.json'), JSON.stringify({ name: '@scope/source' }));
    writeFile(path.join(targetPackageRoot, 'package.json'), JSON.stringify({ name: '@scope/target' }));
    writeFile(path.join(sourcePackageRoot, 'src', 'hooks', 'index.ts'), 'export interface ISelectedArtifactSnapshot { id: string }\n');
    writeFile(sourceFilePath, 'export interface ILocal { name: string }\n');
    writeFile(path.join(root, 'scaffold.ejs'), scaffold);

    const method = buildMethod(sourceFilePath);
    method.importStatements = ["import type { ISelectedArtifactSnapshot } from '../../hooks';"];

    const result = generateProxyFile([method], {
      outputFilePath,
      className: 'CrossRewriteProxy',
      scaffoldTemplatePath: path.join(root, 'scaffold.ejs'),
      sourceProjectRoot: sourcePackageRoot,
    });

    expect(result.ok).toBe(true);
    const content = fs.readFileSync(outputFilePath, 'utf-8');
    expect(content).toContain("import type { ISelectedArtifactSnapshot } from '@scope/source';");
  });

  it('generates @Tool decorator in proxy methods with complete metadata', () => {
    const root = makeTempDir();
    const sourceFilePath = path.join(root, 'src', 'service.ts');
    const outputFilePath = path.join(root, 'src', 'generated-proxy.ts');

    writeFile(sourceFilePath, 'export interface ILocal { name: string }\n');

    // Get the actual template from src/templates/proxy-scaffold.ejs
    const templateSrc = path.join(__dirname, '../../src/templates/proxy-scaffold.ejs');
    const templateContent = fs.readFileSync(templateSrc, 'utf-8');

    const method = buildMethod(sourceFilePath);
    method.toolOptions = {
      name: 'myTool',
      displayName: 'My Tool',
      modelDescription: 'A tool that does something',
      icon: '$(gear)',
      canBeReferencedInPrompt: true,
    };

    const result = generateProxyFile([method], {
      outputFilePath,
      className: 'GeneratedProxy',
      scaffoldTemplatePath: templateSrc,
      sourceProjectRoot: root,
    });

    expect(result.ok).toBe(true);
    const content = fs.readFileSync(outputFilePath, 'utf-8');

    // Verify @Tool decorator is generated with all metadata
    expect(content).toContain("import { Tool } from 'mcp-scanner';");
    expect(content).toContain("@Tool({");
    expect(content).toContain("name: 'myTool',");
    expect(content).toContain("displayName: 'My Tool',");
    expect(content).toContain("modelDescription: 'A tool that does something',");
    expect(content).toContain("icon: '$(gear)',");
    expect(content).toContain('canBeReferencedInPrompt: true,');
  });

  it('generates @Tool decorator without optional fields', () => {
    const root = makeTempDir();
    const sourceFilePath = path.join(root, 'src', 'service.ts');
    const outputFilePath = path.join(root, 'src', 'generated-proxy.ts');

    writeFile(sourceFilePath, 'export interface ILocal { name: string }\n');

    const templateSrc = path.join(__dirname, '../../src/templates/proxy-scaffold.ejs');

    const method = buildMethod(sourceFilePath);
    method.toolOptions = {
      name: 'simpleTool',
      // Only required fields, optional fields absent
    };

    const result = generateProxyFile([method], {
      outputFilePath,
      className: 'GeneratedProxy',
      scaffoldTemplatePath: templateSrc,
      sourceProjectRoot: root,
    });

    expect(result.ok).toBe(true);
    const content = fs.readFileSync(outputFilePath, 'utf-8');

    // Verify @Tool decorator with only required field
    expect(content).toContain("@Tool({");
    expect(content).toContain("name: 'simpleTool',");
    // Optional fields should not be present
    expect(content).not.toContain('displayName:');
    expect(content).not.toContain('modelDescription:');
  });

  it('omits @Tool decorator when toolOptions is undefined', () => {
    const root = makeTempDir();
    const sourceFilePath = path.join(root, 'src', 'service.ts');
    const outputFilePath = path.join(root, 'src', 'generated-proxy.ts');

    writeFile(sourceFilePath, 'export interface ILocal { name: string }\n');

    const templateSrc = path.join(__dirname, '../../src/templates/proxy-scaffold.ejs');

    const method = buildMethod(sourceFilePath);
    // toolOptions is undefined (default from buildMethod)

    const result = generateProxyFile([method], {
      outputFilePath,
      className: 'GeneratedProxy',
      scaffoldTemplatePath: templateSrc,
      sourceProjectRoot: root,
    });

    expect(result.ok).toBe(true);
    const content = fs.readFileSync(outputFilePath, 'utf-8');

    // Verify @Tool decorator is NOT present
    expect(content).not.toContain('@Tool({');
    // Method should have default signature
    expect(content).toContain('public async run(params: ILocal): Promise<ILocal>');
  });
});

