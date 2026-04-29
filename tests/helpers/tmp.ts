import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Create a temporary directory for test fixtures.
 *
 * @returns Absolute path to the new temp directory.
 */
export function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-scanner-test-'));
}

/**
 * Write file content, creating parent folders as needed.
 *
 * @param filePath Absolute file path.
 * @param content UTF-8 text content.
 */
export function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}
