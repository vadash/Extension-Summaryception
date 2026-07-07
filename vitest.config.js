import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Parallel execution: don't force --runInBand; use threads (default).
        pool: 'threads',
        isolate: true,

        // Test naming conventions + inclusion.
        setupFiles: ['tests/setup.js'],
        include: ['tests/**/*.test.js'],
        exclude: ['node_modules/**', 'dist/**', 'report/**'],

        // Performance timing: emitted in the stdout summary.
        reporters: ['default'],
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
                'src/foundation/constants.js',
                'src/foundation/retry.js',
                'src/core/chatutils.js',
                'src/core/prompts.js',
                'src/foundation/state.js',
                'src/foundation/logger.js',
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
