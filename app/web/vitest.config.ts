import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
    restoreMocks: true,
    reporters: ['default'],
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/**/__tests__/**',
        'src/test/**',
        'src/**/*.d.ts',
      ],
      // TST-01 coverage ratchet. Conservative floors measured from a clean
      // baseline run on vitest/coverage-v8 4.1.10 (see phase6-l4-handoff.md
      // and phase6-l1-handoff.md).
      // L4 integration re-baseline: the coverage-v8 3.2.7 chain carried
      // GHSA-mh99-v99m-4gvg (brace-expansion, no fixed release), so web was
      // aligned with API on vitest 4.1.10. The vitest-4 v8 provider counts
      // ~2x branch points (799 vs 464); floors below are re-measured on the
      // new engine (59.38 / 51.18 / 59.14 / 63.30), not aspirational.
      thresholds: {
        statements: 58,
        branches: 50,
        functions: 58,
        lines: 62,
      },
    },
  },
});
