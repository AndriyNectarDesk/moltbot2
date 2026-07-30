import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // The leaderboard and the shared game client are plain .js and live outside
    // src/, so they need to be named here explicitly — the worker's tests sat
    // unrun for exactly this reason.
    include: ['src/**/*.test.ts', 'leaderboard/**/*.test.js', 'site/**/*.test.js'],
    exclude: ['src/client/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: ['src/client/**', 'node_modules/**', '**/*.test.ts'],
    },
  },
})
