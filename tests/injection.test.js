import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installSillyTavernStub } from './test-helpers.js';

let consoleLogSpy;

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    consoleLogSpy.mockRestore();
});

function countTokens(text) {
    const trimmed = String(text || '').trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
}

describe('injection diagnostics', () => {
    it('logs injection size in tokens', async () => {
        const setExtensionPrompt = vi.fn();
        const ctx = installSillyTavernStub({
            metadata: {
                summaryception: {
                    layers: [[{ text: 'first summary' }]],
                    summarizedUpTo: 2,
                    ghostedIndices: [],
                },
            },
            settings: {
                debugMode: true,
            },
            setExtensionPrompt,
        });
        ctx.getTokenCountAsync = vi.fn(async (text) => countTokens(text));

        const { updateInjection } = await import('../src/features/injection.js');
        updateInjection();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(setExtensionPrompt).toHaveBeenCalledTimes(1);
        const injectionLog = consoleLogSpy.mock.calls.find((call) =>
            call[1]?.includes('Injection updated:'),
        );
        expect(injectionLog?.[1]).toMatch(/Injection updated: \d+ tokens/);
        expect(injectionLog?.[1]).not.toContain('chars');
    });
});

describe('memory injection options', () => {
    it('maps standard mode to in-prompt system memory at depth zero', async () => {
        const { getMemoryInjectionOptions } = await import('../src/features/injection.js');

        expect(getMemoryInjectionOptions({ memoryMode: 'standard' })).toEqual({
            position: 0,
            depth: 0,
            scan: false,
            role: 0,
        });
    });

    it('maps cache mode to the same stable in-prompt system placement', async () => {
        const { getMemoryInjectionOptions } = await import('../src/features/injection.js');

        expect(getMemoryInjectionOptions({ memoryMode: 'cache' })).toEqual({
            position: 0,
            depth: 0,
            scan: false,
            role: 0,
        });
    });

    it('maps custom in-chat role and depth settings', async () => {
        const { getMemoryInjectionOptions } = await import('../src/features/injection.js');

        expect(
            getMemoryInjectionOptions({
                memoryMode: 'custom',
                customMemoryPosition: 'in_chat',
                customMemoryRole: 'user',
                customMemoryDepth: 42,
            }),
        ).toEqual({
            position: 1,
            depth: 42,
            scan: false,
            role: 1,
        });
    });

    it('ignores custom depth outside in-chat placement', async () => {
        const { getMemoryInjectionOptions } = await import('../src/features/injection.js');

        expect(
            getMemoryInjectionOptions({
                memoryMode: 'custom',
                customMemoryPosition: 'before_prompt',
                customMemoryRole: 'assistant',
                customMemoryDepth: 42,
            }),
        ).toEqual({
            position: 2,
            depth: 0,
            scan: false,
            role: 2,
        });
    });
});
