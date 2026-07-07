import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import { makeTempDir, writeFile } from '../helpers/tmp';

function writeFixtureProject(root: string): void {
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

  writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'fixture-project',
    version: '1.0.0',
    contributes: {
      languageModelTools: [
        {
          name: 'manualTool',
          displayName: 'Manual',
          modelDescription: 'Manual tool',
          canBeReferencedInPrompt: true,
          toolReferenceName: 'manualTool',
          icon: '$(tools)',
          inputSchema: { type: 'object', properties: {} },
          tags: ['manual'],
        },
      ],
    },
  }, null, 2));

  writeFile(path.join(root, 'src', 'tool.ts'), `
function ExposeTool(_: unknown): MethodDecorator { return () => undefined; }

export interface IToolInput {
  text: string;
}

class ToolService {
  @ExposeTool({
    name: 'fixtureTool',
    displayName: 'Fixture Tool',
    modelDescription: 'Fixture model description',
  })
  run(params: IToolInput): Promise<IToolInput> {
    return Promise.resolve(params);
  }
}
`);

  writeFile(path.join(root, 'src', 'ignored', 'tool.ts'), `
function ExposeTool(_: unknown): MethodDecorator { return () => undefined; }

export interface IIgnoredInput {
  text: string;
}

class IgnoredService {
  @ExposeTool({
    name: 'ignoredTool',
    displayName: 'Ignored Tool',
    modelDescription: 'Must be excluded',
  })
  run(params: IIgnoredInput): Promise<IIgnoredInput> {
    return Promise.resolve(params);
  }
}
`);
}

describe('CLI integration', () => {
  it('scans, generates proxy file and patches package.json with tag mode', () => {
    const root = makeTempDir();
    writeFixtureProject(root);

    const cliPath = path.join(process.cwd(), 'dist', 'cli.js');
    const proxyOutputPath = path.join(root, 'src', 'generated-proxy.ts');

    const result = spawnSync(process.execPath, [
      cliPath,
      '--project', root,
      '--proxy-file', proxyOutputPath,
      '--exclude-path', 'src/ignored',
      '--tools-tag', 'fixture-tag',
    ], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);

    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')) as {
      contributes: { languageModelTools: Array<{ name: string; tags?: string[] }> };
    };

    const names = packageJson.contributes.languageModelTools.map((t) => t.name);
    expect(names).toContain('manualTool');
    expect(names).toContain('fixtureTool');
    expect(names).not.toContain('ignoredTool');

    const generated = packageJson.contributes.languageModelTools.find((t) => t.name === 'fixtureTool');
    expect(generated?.tags).toContain('fixture-tag');
    expect(generated?.tags).toContain('generated-by-mcp-scanner');

    const proxyContent = fs.readFileSync(proxyOutputPath, 'utf-8');
    expect(proxyContent).toContain('fixtureTool');
    expect(proxyContent).not.toContain('ignoredTool');
    expect(proxyContent).toContain('run(');
  });

  it('routes tools to named MCP manifests and keeps mcp-only tools out of package.json', () => {
    const root = makeTempDir();

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

    writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: 'mcp-fixture',
      version: '1.0.0',
      contributes: { languageModelTools: [] },
    }, null, 2));

    writeFile(path.join(root, 'src', 'tools.ts'), `
function ExposeTool(_: unknown): MethodDecorator { return () => undefined; }

export interface IInput { text: string; }

class MixedTools {
  @ExposeTool({ name: 'lmTool', displayName: 'LM Tool', modelDescription: 'LM tool' })
  lm(params: IInput): Promise<IInput> { return Promise.resolve(params); }

  @ExposeTool({ name: 'mcpA', displayName: 'MCP A', modelDescription: 'A tool', transports: ['mcp'], mcpServers: ['serverA'] })
  a(params: IInput): Promise<IInput> { return Promise.resolve(params); }

  @ExposeTool({ name: 'mcpB', displayName: 'MCP B', modelDescription: 'B tool', transports: ['mcp'], mcpServers: ['serverB'] })
  b(params: IInput): Promise<IInput> { return Promise.resolve(params); }
}
`);

    const cliPath = path.join(process.cwd(), 'dist', 'cli.js');
    const result = spawnSync(process.execPath, [
      cliPath,
      '--project', root,
      '--mcp-manifest', 'serverA=mcp/server-a.mcp.json',
      '--mcp-manifest', 'serverB=mcp/server-b.mcp.json',
    ], { cwd: process.cwd(), encoding: 'utf-8' });

    expect(result.status).toBe(0);

    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')) as {
      contributes: { languageModelTools: Array<{ name: string }> };
    };
    const lmNames = packageJson.contributes.languageModelTools.map((t) => t.name);
    expect(lmNames).toContain('lmTool');
    expect(lmNames).not.toContain('mcpA');
    expect(lmNames).not.toContain('mcpB');

    const manifestA = JSON.parse(fs.readFileSync(path.join(root, 'mcp', 'server-a.mcp.json'), 'utf-8')) as {
      server: string; tools: Array<{ name: string; inputSchema: Record<string, unknown> }>;
    };
    expect(manifestA.server).toBe('serverA');
    expect(manifestA.tools.map((t) => t.name)).toEqual(['mcpA']);
    expect(manifestA.tools[0].inputSchema).toMatchObject({ type: 'object' });

    const manifestB = JSON.parse(fs.readFileSync(path.join(root, 'mcp', 'server-b.mcp.json'), 'utf-8')) as {
      tools: Array<{ name: string }>;
    };
    expect(manifestB.tools.map((t) => t.name)).toEqual(['mcpB']);
  });

  it('skips package.json patching when --skip-package-json is passed', () => {
    const root = makeTempDir();

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

    writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: 'skip-pkg-fixture',
      version: '1.0.0',
      contributes: { languageModelTools: [] },
    }, null, 2));

    writeFile(path.join(root, 'src', 'tools.ts'), `
function ExposeTool(_: unknown): MethodDecorator { return () => undefined; }
export interface IInput { text: string; }
class Tools {
  @ExposeTool({ name: 'myTool', displayName: 'My Tool', modelDescription: 'A tool' })
  run(params: IInput): Promise<IInput> { return Promise.resolve(params); }
}
`);

    const cliPath = path.join(process.cwd(), 'dist', 'cli.js');
    const result = spawnSync(process.execPath, [
      cliPath,
      '--project', root,
      '--skip-package-json',
    ], { cwd: process.cwd(), encoding: 'utf-8' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('skipped');

    // Verify package.json was NOT modified
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')) as {
      contributes: { languageModelTools: unknown[] };
    };
    expect(packageJson.contributes.languageModelTools).toEqual([]);
  });

  it('uses --tools-tag as the MCP server group when tools declare no mcpServers', () => {
    const root = makeTempDir();

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

    writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: 'tag-group-fixture',
      version: '1.0.0',
      contributes: { languageModelTools: [] },
    }, null, 2));

    writeFile(path.join(root, 'src', 'tools.ts'), `
function ExposeTool(_: unknown): MethodDecorator { return () => undefined; }
export interface IInput { text: string; }
class CaipTools {
  @ExposeTool({ name: 'toolOne', displayName: 'One', modelDescription: 'One' })
  one(params: IInput): Promise<IInput> { return Promise.resolve(params); }

  @ExposeTool({ name: 'toolTwo', displayName: 'Two', modelDescription: 'Two' })
  two(params: IInput): Promise<IInput> { return Promise.resolve(params); }
}
`);

    const cliPath = path.join(process.cwd(), 'dist', 'cli.js');
    const result = spawnSync(process.execPath, [
      cliPath,
      '--project', root,
      '-g', 'caip',
      '--default-transport', 'mcp',
      '--mcp-manifest', 'caip=./mcp/caip.mcp.json',
    ], { cwd: process.cwd(), encoding: 'utf-8' });

    expect(result.status).toBe(0);
    // No leftover warning about the default group.
    expect(result.stdout).not.toContain("target MCP server 'default'");

    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'mcp', 'caip.mcp.json'), 'utf-8')) as {
      server: string; tools: Array<{ name: string }>;
    };
    expect(manifest.server).toBe('caip');
    expect(manifest.tools.map((t) => t.name).sort()).toEqual(['toolOne', 'toolTwo']);
  });
});
