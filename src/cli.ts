#!/usr/bin/env node
/* ------------------------------------------------------------------ */
/*  mcp-scanner CLI                                                    */
/* ------------------------------------------------------------------ */

import * as path from 'path';
import { copyDefaultScaffoldTemplateToLocal, generateProxyFile } from './proxy-generator';
import { AUTOGEN_STATE_FILE, patchPackageJsonFile } from './patcher';
import { scanProjectForProxies } from './proxy-scanner';
import { IScannedTool, scanProject } from './scanner';

/**
 * Parsed CLI arguments used by the `mcp-scanner` command.
 */
interface CliArgs {
  /**
   * Root folder of the main source project.
   */
  projectRoot: string;

  /**
   * Tsconfig file name used for scanning.
   */
  tsconfigName: string;

  /**
   * Optional subtree path limiting tool scan scope.
   */
  toolsPath?: string;

  /**
   * Optional ownership tag for generated language model tools.
   */
  toolsTag?: string;

  /**
   * Optional package.json path to patch.
   */
  packageJsonPath?: string;

  /**
   * Optional output proxy file path.
   */
  proxyFilePath?: string;

  /**
   * Optional class name for generated proxy class.
   */
  proxyClassName?: string;

  /**
   * Optional scaffold template path used for proxy generation.
   */
  scaffoldTemplatePath?: string;

  /**
   * Optional destination path for copying default scaffold template.
   */
  initProxyFile?: string;

  /**
   * Additional projects to scan and merge into the result.
   */
  extraProjects: Array<{
    /**
     * Root folder of the additional project.
     */
    root: string;

    /**
     * Tsconfig file name for the additional project.
     */
    tsconfig: string;
  }>;

  /**
   * Whether scanner should only print generated JSON.
   */
  dryRun: boolean;

  /**
   * Whether CLI should print help and exit.
   */
  help: boolean;
}

/**
 * Parse command line arguments into a structured object.
 *
 * @param argv Raw process arguments.
 * @returns Normalized CLI argument object.
 */
function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    projectRoot: process.cwd(),
    tsconfigName: 'tsconfig.json',
    toolsPath: undefined,
    toolsTag: undefined,
    packageJsonPath: undefined,
    proxyFilePath: undefined,
    proxyClassName: undefined,
    scaffoldTemplatePath: undefined,
    initProxyFile: undefined,
    extraProjects: [],
    dryRun: false,
    help: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--project':
      case '-p':
        args.projectRoot = path.resolve(argv[++i] ?? '.');
        break;
      case '--tsconfig':
      case '-t':
        args.tsconfigName = argv[++i] ?? 'tsconfig.json';
        break;
      case '--tools-path':
      case '-s':
        args.toolsPath = argv[++i];
        break;
      case '--tools-tag':
      case '-g':
        args.toolsTag = argv[++i];
        break;
      case '--package-json':
      case '-j':
        args.packageJsonPath = argv[++i];
        break;
      case '--proxy-file':
      case '-o':
        args.proxyFilePath = argv[++i];
        break;
      case '--proxy-class':
      case '-c':
        args.proxyClassName = argv[++i];
        break;
      case '--scaffold-template':
      case '-x':
        args.scaffoldTemplatePath = argv[++i];
        break;
      case '--init-proxy-file':
        args.initProxyFile = argv[++i];
        break;
      case '--extra':
      case '-e': {
        const extraPath = argv[++i] ?? '.';
        let extraTsconfig = 'tsconfig.json';
        if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
          extraTsconfig = argv[++i];
        }
        args.extraProjects.push({ root: path.resolve(extraPath), tsconfig: extraTsconfig });
        break;
      }
      case '--dry-run':
      case '-d':
        args.dryRun = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        if (!arg.startsWith('-') && i === 2) {
          args.projectRoot = path.resolve(arg);
        }
        break;
    }
  }

  return args;
}

/**
 * Resolve an optional path relative to a project root.
 *
 * @param projectRoot Root folder used for relative path resolution.
 * @param maybePath Optional absolute or relative path.
 * @returns Absolute path when provided, otherwise `undefined`.
 */
function resolveFromProject(projectRoot: string, maybePath?: string): string | undefined {
  if (!maybePath) {
    return undefined;
  }

  return path.isAbsolute(maybePath)
    ? maybePath
    : path.resolve(projectRoot, maybePath);
}

/**
 * Add generator ownership tags to scanned tools when `--tools-tag` is provided.
 *
 * @param tools Tools discovered by the scanner.
 * @param toolsTag Optional ownership tag.
 * @returns Tool list with merged tags when tag mode is enabled.
 */
function applyToolsTag(tools: IScannedTool[], toolsTag?: string): IScannedTool[] {
  const tag = toolsTag?.trim();
  if (!tag) {
    return tools;
  }

  return tools.map((tool) => {
    const mergedTags = Array.from(new Set([...(tool.tags ?? []), tag, 'generated-by-mcp-scanner']));
    return {
      ...tool,
      tags: mergedTags,
    };
  });
}

/**
 * Execute the `mcp-scanner` CLI workflow.
 *
 * @returns Nothing. Exits process with appropriate status code.
 */
function main(): void {
  const args = parseArgs(process.argv);

  if (args.help) {
    console.log(`
mcp-scanner — Scan TypeScript projects for @ExposeTool methods and
generate VS Code languageModelTools entries in package.json.

Usage:
  mcp-scanner [options]

Options:
  --project, -p <path>    Project root directory (default: current directory)
  --tsconfig, -t <name>   tsconfig file name for the main project (default: tsconfig.json)
  --tools-path, -s <path> Restrict scanning to this path subtree.
                          Relative paths are resolved from --project.
  --tools-tag, -g <tag>   Tag generated tools and patch only tools with this tag.
                          If omitted, legacy state-based patching is used.
  --package-json, -j <path>
                          package.json path to patch. Relative paths are
                          resolved from --project. (default: <project>/package.json)
  --proxy-file, -o <path> Generate proxy methods into this file.
                          Relative paths are resolved from --project.
  --proxy-class, -c <name> Class name for generated proxies.
                          (default: GeneratedExposeToolProxies)
  --scaffold-template, -x <path>
                          Custom EJS scaffold template path.
                          Relative paths are resolved from --project.
  --init-proxy-file <path>
                          Copy the default proxy file scaffold to the specified file
                          and exit. You can then customize it (class name, etc.) before using
                          with --proxy-file. Includes injection markers.
  --extra, -e <path> [tsconfig]  Additional project root to scan (repeatable)
  --dry-run, -d           Show generated output without writing files
  --help, -h              Show this help message

How it works:
  1. Parses all TypeScript sources referenced by tsconfig.json
  2. Finds methods decorated with @ExposeTool({ name, displayName, modelDescription })
  3. Extracts parameter interfaces and converts them to JSON Schema
  4. Writes generated tools into contributes.languageModelTools
  5. Tracks generated ownership in ${AUTOGEN_STATE_FILE} (legacy mode)
  6. Replaces only previously generated tools, preserving manual tools
`);
    process.exit(0);
  }

  if (args.initProxyFile) {
    const proxyFilePath = resolveFromProject(args.projectRoot, args.initProxyFile) ?? args.initProxyFile;
    copyDefaultScaffoldTemplateToLocal(proxyFilePath);
    console.log(`✅ Default proxy file scaffold copied to: ${proxyFilePath}`);
    console.log(`   You can now customize this file (class name, import paths, etc.)`);
    console.log(`   Then use it with: mcp-scanner --proxy-file ${proxyFilePath}`);
    process.exit(0);
  }

  console.log(`\n🔍 mcp-scanner — scanning ${args.projectRoot}`);
  console.log(`   tsconfig: ${args.tsconfigName}`);
  if (args.toolsPath) {
    console.log(`   tools path: ${args.toolsPath}`);
  }
  if (args.toolsTag) {
    console.log(`   tools tag: ${args.toolsTag}`);
  }
  if (args.packageJsonPath) {
    console.log(`   package.json: ${args.packageJsonPath}`);
  }
  if (args.proxyFilePath) {
    console.log(`   proxy file: ${args.proxyFilePath}`);
  }
  if (args.scaffoldTemplatePath) {
    console.log(`   scaffold template: ${args.scaffoldTemplatePath}`);
  }
  if (args.extraProjects.length > 0) {
    for (const extra of args.extraProjects) {
      console.log(`   extra: ${extra.root} (${extra.tsconfig})`);
    }
  }
  console.log();

  const result = scanProject(
    args.projectRoot,
    args.tsconfigName,
    resolveFromProject(args.projectRoot, args.toolsPath),
  );
  for (const extra of args.extraProjects) {
    const extraResult = scanProject(
      extra.root,
      extra.tsconfig,
      resolveFromProject(extra.root, args.toolsPath),
    );
    result.tools.push(...extraResult.tools);
    result.filesScanned += extraResult.filesScanned;
    result.diagnostics.push(...extraResult.diagnostics.map((d) => `[${path.basename(extra.root)}] ${d}`));
  }

  result.tools = applyToolsTag(result.tools, args.toolsTag);

  if (result.diagnostics.length > 0) {
    console.log('⚠️  Diagnostics:');
    for (const d of result.diagnostics) {
      console.log(`   - ${d}`);
    }
    console.log();
  }

  console.log(`📂 Files scanned: ${result.filesScanned}`);
  console.log(`🔧 Tools found:   ${result.tools.length}\n`);

  if (result.tools.length > 0) {
    console.log('   Name                        Display Name');
    console.log('   ─────────────────────────── ─────────────────────────────────');
    for (const tool of result.tools) {
      console.log(`   ${tool.name.padEnd(28)} ${tool.displayName}`);
    }
    console.log();
  }

  if (args.dryRun) {
    console.log('📋 Generated JSON (dry run — no file written):\n');
    console.log(JSON.stringify(result.tools, null, 2));
    if (args.proxyFilePath) {
      console.log('\n📋 Proxy generation enabled (dry run): no proxy file written.');
    }
    process.exit(0);
  }

  if (args.proxyFilePath) {
    const proxyScan = scanProjectForProxies(
      args.projectRoot,
      args.tsconfigName,
      resolveFromProject(args.projectRoot, args.toolsPath),
    );
    for (const extra of args.extraProjects) {
      const extraProxyScan = scanProjectForProxies(
        extra.root,
        extra.tsconfig,
        resolveFromProject(extra.root, args.toolsPath),
      );
      proxyScan.methods.push(...extraProxyScan.methods);
      proxyScan.filesScanned += extraProxyScan.filesScanned;
      proxyScan.diagnostics.push(...extraProxyScan.diagnostics.map((d) => `[${path.basename(extra.root)}] ${d}`));
    }

    if (proxyScan.diagnostics.length > 0) {
      console.log('⚠️  Proxy diagnostics:');
      for (const d of proxyScan.diagnostics) {
        console.log(`   - ${d}`);
      }
      console.log();
    }

    const proxyFilePath = resolveFromProject(args.projectRoot, args.proxyFilePath);
    if (!proxyFilePath) {
      console.error('❌ Invalid --proxy-file option.');
      process.exit(1);
    }

    const proxyResult = generateProxyFile(proxyScan.methods, {
      outputFilePath: proxyFilePath,
      className: args.proxyClassName,
      scaffoldTemplatePath: resolveFromProject(args.projectRoot, args.scaffoldTemplatePath),
      sourceProjectRoot: args.projectRoot,
    });

    if (!proxyResult.ok) {
      console.error(`❌ ${proxyResult.message}`);
      process.exit(1);
    }

    console.log(`✅ ${proxyResult.message}`);
    console.log(`   Generated proxy methods: ${proxyScan.methods.length}`);
  }

  if (result.tools.length === 0) {
    console.log('No @ExposeTool methods eligible for package.json patch.');
    process.exit(0);
  }

  const packageJsonPath = resolveFromProject(args.projectRoot, args.packageJsonPath)
    ?? path.join(args.projectRoot, 'package.json');

  const patchResult = patchPackageJsonFile(packageJsonPath, result.tools, { toolTag: args.toolsTag });
  if (patchResult.ok) {
    console.log(`✅ ${patchResult.message}`);
  } else {
    console.error(`❌ ${patchResult.message}`);
    process.exit(1);
  }
}

main();
