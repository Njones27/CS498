import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['test/**/*.test.ts'],
        // Synthesizing the app fingerprints the worker image's build context.
        testTimeout: 60_000,
    },
});
