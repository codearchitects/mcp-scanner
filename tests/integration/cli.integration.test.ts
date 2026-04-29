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

    const generated = packageJson.contributes.languageModelTools.find((t) => t.name === 'fixtureTool');
    expect(generated?.tags).toContain('fixture-tag');
    expect(generated?.tags).toContain('generated-by-mcp-scanner');

    const proxyContent = fs.readFileSync(proxyOutputPath, 'utf-8');
    expect(proxyContent).toContain('fixtureTool');
    expect(proxyContent).toContain('run(');
  });
});
