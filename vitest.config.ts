import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: true,
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/vscode/**/*.ts', 'src/cli.ts', 'src/index.ts', 'src/**/index.ts'],
      thresholds: {
        lines: 83,
        statements: 83,
        functions: 85,
        branches: 71,
      },
    },
  },
});
