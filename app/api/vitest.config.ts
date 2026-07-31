import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/__tests__/**',
        'src/**/*.d.ts',
        'vitest.setup.ts',
      ],
      // TST-01 coverage ratchet. Conservative floors measured from a clean
      // baseline run (see phase6-l1-handoff.md): statements 72.5 / branches
      // 62.4 / functions 72.3 / lines 74.6. Floors = floor(baseline) - 1 to
      // absorb the observed ~0.03pt run-to-run drift while still failing
      // closed on any meaningful coverage regression.
      thresholds: {
        statements: 71,
        branches: 61,
        functions: 71,
        lines: 73,
      },
    },
  },
});
