import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Parallel execution: don't force --runInBand; use threads (default).
        pool: 'threads',
        isolate: true,

        // Test naming conventions + inclusion.
        include: ['tests/**/*.test.js'],
        exclude: ['node_modules/**', 'dist/**', 'report/**'],

        // Performance timing: emitted in JSON + stdout summary.
        reporters: ['default', 'json'],
        outputFile: {
            json: './report/test-results.json',
        },
        logHeapUsage: true,

        // Coverage with enforced thresholds.
        // Only unit-testable modules are included in coverage; modules that
        // depend on a live SillyTavern runtime (ghosting, injection, memory,
        // persist, summarizer, ui, events, commands) are excluded because
        // they cannot run in a headless jsdom context.
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            include: [
                'src/constants.js',
                'src/retry.js',
                'src/chatutils.js',
                'src/prompts.js',
                'src/state.js',
                'src/logger.js',
            ],
            thresholds: {
                lines: 70,
                functions: 70,
                branches: 50,
                statements: 70,
            },
        },
    },
});
