import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { AUTOGEN_STATE_FILE, patchPackageJsonContent, patchPackageJsonFile } from '../../src/patcher';
import type { IScannedTool } from '../../src/scanner';
import { makeTempDir, writeFile } from '../helpers/tmp';

function tool(name: string, tags?: string[]): IScannedTool {
  return {
    name,
    displayName: name,
    modelDescription: `${name} desc`,
    canBeReferencedInPrompt: true,
    toolReferenceName: name,
    icon: '$(tools)',
    inputSchema: { type: 'object', properties: {} },
    tags,
  };
}

describe('patcher', () => {
  it('returns error for invalid package json', () => {
    const result = patchPackageJsonContent('{invalid}', [tool('a')]);
    expect(result.result.ok).toBe(false);
    expect(result.result.message).toContain('not valid JSON');
  });

  it('replaces only previously generated tools in legacy mode', () => {
    const raw = JSON.stringify({
      name: 'sample',
      contributes: {
        languageModelTools: [
          tool('manualTool'),
          tool('oldGeneratedA'),
        ],
      },
    });

    const result = patchPackageJsonContent(raw, [tool('newGenerated')], ['oldGeneratedA']);
    const parsed = JSON.parse(result.content) as {
      contributes: { languageModelTools: Array<{ name: string }> };
    };

    expect(result.result.ok).toBe(true);
    expect(parsed.contributes.languageModelTools.map((t) => t.name)).toEqual(['manualTool', 'newGenerated']);
  });

  it('replaces only tools with matching tag in tag mode and adds generator tags', () => {
    const raw = JSON.stringify({
      name: 'sample',
      contributes: {
        languageModelTools: [
          tool('manualTool', ['keep']),
          tool('ownedTool', ['my-tag']),
        ],
      },
    });

    const result = patchPackageJsonContent(raw, [tool('freshTool')], [], { toolTag: 'my-tag' });
    const parsed = JSON.parse(result.content) as {
      contributes: { languageModelTools: Array<{ name: string; tags?: string[] }> };
    };

    expect(result.result.ok).toBe(true);
    expect(parsed.contributes.languageModelTools.map((t) => t.name)).toEqual(['manualTool', 'freshTool']);
    expect(parsed.contributes.languageModelTools[1].tags).toContain('my-tag');
    expect(parsed.contributes.languageModelTools[1].tags).toContain('generated-by-mcp-scanner');
  });

  it('patches package json file and writes state file in legacy mode', () => {
    const root = makeTempDir();
    const packageJsonPath = path.join(root, 'package.json');

    writeFile(packageJsonPath, JSON.stringify({
      name: 'file-patch',
      contributes: { languageModelTools: [tool('manualTool')] },
    }, null, 2));

    const result = patchPackageJsonFile(packageJsonPath, [tool('generated')]);
    expect(result.ok).toBe(true);

    const patched = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
      contributes: { languageModelTools: Array<{ name: string }> };
    };
    expect(patched.contributes.languageModelTools.map((t) => t.name)).toEqual(['manualTool', 'generated']);

    const stateFilePath = path.join(root, AUTOGEN_STATE_FILE);
    expect(fs.existsSync(stateFilePath)).toBe(true);
    const state = JSON.parse(fs.readFileSync(stateFilePath, 'utf-8')) as { generatedToolNames: string[] };
    expect(state.generatedToolNames).toEqual(['generated']);
  });

  it('returns error when package json file is missing', () => {
    const root = makeTempDir();
    const result = patchPackageJsonFile(path.join(root, 'missing.json'), [tool('generated')]);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('File not found');
  });

  it('ignores malformed state file and still patches package json', () => {
    const root = makeTempDir();
    const packageJsonPath = path.join(root, 'package.json');
    const stateFilePath = path.join(root, AUTOGEN_STATE_FILE);

    writeFile(packageJsonPath, JSON.stringify({
      name: 'state-edge',
      contributes: { languageModelTools: [tool('manualTool')] },
    }, null, 2));
    writeFile(stateFilePath, '{invalid json');

    const result = patchPackageJsonFile(packageJsonPath, [tool('generated')]);
    expect(result.ok).toBe(true);

    const patched = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
      contributes: { languageModelTools: Array<{ name: string }> };
    };
    expect(patched.contributes.languageModelTools.map((t) => t.name)).toEqual(['manualTool', 'generated']);
  });
});
