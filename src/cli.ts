#!/usr/bin/env node
/* ------------------------------------------------------------------ */
/*  mcp-scanner CLI                                                    */
/*                                                                     */
/*  Usage:                                                             */
/*    mcp-scanner [options]                                            */
/*                                                                     */
/*  Options:                                                           */
/*    --project, -p <path>    Project root (default: cwd)              */
/*    --tsconfig, -t <name>   tsconfig file name (default: tsconfig.json) */
/*    --extra, -e <path>      Extra project root to scan (repeatable)  */
/*    --dry-run, -d           Show what would be generated, don't write*/
/*    --help, -h              Show this help                           */
/* ------------------------------------------------------------------ */

import * as path from 'path';
import { AUTOGEN_STATE_FILE, patchPackageJsonFile } from './patcher';
import { scanProject } from './scanner';

/* ------------------------------------------------------------------ */
/*  Argument parsing (no external deps)                                */
/* ------------------------------------------------------------------ */

interface CliArgs {
  projectRoot: string;
  tsconfigName: string;
  packageJsonPath?: string;
  extraProjects: Array<{ root: string; tsconfig: string }>;
  dryRun: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    projectRoot: process.cwd(),
    tsconfigName: 'tsconfig.json',
    packageJsonPath: undefined,
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
      case '--package-json':
      case '-j':
        args.packageJsonPath = argv[++i];
        break;
      case '--extra':
      case '-e': {
        const extraPath = argv[++i] ?? '.';
        // Optional tsconfig after the path (next arg if it doesn't start with -)
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
        // If first positional arg, treat as project root
        if (!arg.startsWith('-') && i === 2) {
          args.projectRoot = path.resolve(arg);
        }
        break;
    }
  }

  return args;
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

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
  --package-json, -j <path>
                          package.json path to patch. Relative paths are
                          resolved from --project. (default: <project>/package.json)
  --extra, -e <path> [tsconfig]  Additional project root to scan (repeatable).
                          Scans sources from this project but patches the MAIN
                          project's package.json. Optionally pass a tsconfig
                          filename after the path.
  --dry-run, -d           Show generated tools without writing to package.json
  --help, -h              Show this help message

How it works:
  1. Parses all TypeScript sources referenced by tsconfig.json
  2. Finds methods decorated with @ExposeTool({ name, displayName, modelDescription })
  3. Extracts parameter interfaces and converts them to JSON Schema
  4. Writes generated tools into contributes.languageModelTools
  5. Tracks generated ownership in ${AUTOGEN_STATE_FILE}
  6. Replaces only previously generated tools, preserving manual tools

Multi-project example:
  # Scan main project + a shared core library
  mcp-scanner -e ../packages/core

  # Scan with custom tsconfig for the extra project
  mcp-scanner -e ../packages/core tsconfig.json

  # Multiple extra projects
  mcp-scanner -e ../packages/core -e ../packages/blocks
`);
    process.exit(0);
  }

  console.log(`\n🔍 mcp-scanner — scanning ${args.projectRoot}`);
  console.log(`   tsconfig: ${args.tsconfigName}`);
  if (args.packageJsonPath) {
    console.log(`   package.json: ${args.packageJsonPath}`);
  }
  if (args.extraProjects.length > 0) {
    for (const extra of args.extraProjects) {
      console.log(`   extra: ${extra.root} (${extra.tsconfig})`);
    }
  }
  console.log();

  // Scan the main project
  const result = scanProject(args.projectRoot, args.tsconfigName);

  // Scan extra projects and merge results
  for (const extra of args.extraProjects) {
    const extraResult = scanProject(extra.root, extra.tsconfig);
    result.tools.push(...extraResult.tools);
    result.filesScanned += extraResult.filesScanned;
    result.diagnostics.push(...extraResult.diagnostics.map(d => `[${path.basename(extra.root)}] ${d}`));
  }

  if (result.diagnostics.length > 0) {
    console.log('⚠️  Diagnostics:');
    for (const d of result.diagnostics) {
      console.log(`   - ${d}`);
    }
    console.log();
  }

  console.log(`📂 Files scanned: ${result.filesScanned}`);
  console.log(`🔧 Tools found:   ${result.tools.length}\n`);

  if (result.tools.length === 0) {
    console.log('No @ExposeTool decorated methods found. Nothing to do.');
    process.exit(0);
  }

  // Print summary table
  console.log('   Name                        Display Name');
  console.log('   ─────────────────────────── ─────────────────────────────────');
  for (const tool of result.tools) {
    const name = tool.name.padEnd(28);
    console.log(`   ${name} ${tool.displayName}`);
  }
  console.log();

  if (args.dryRun) {
    console.log('📋 Generated JSON (dry run — no file written):\n');
    console.log(JSON.stringify(result.tools, null, 2));
    process.exit(0);
  }

  // Patch package.json
  const packageJsonPath = args.packageJsonPath
    ? (path.isAbsolute(args.packageJsonPath)
      ? args.packageJsonPath
      : path.resolve(args.projectRoot, args.packageJsonPath))
    : path.join(args.projectRoot, 'package.json');
  const patchResult = patchPackageJsonFile(packageJsonPath, result.tools);

  if (patchResult.ok) {
    console.log(`✅ ${patchResult.message}`);
  } else {
    console.error(`❌ ${patchResult.message}`);
    process.exit(1);
  }
}

main();
