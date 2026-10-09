import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tokenCountMocks = vi.hoisted(() => ({ countTextTokens: vi.fn() }));

vi.mock('../src/core/token-count.js', async (importOriginal) => ({
    ...(await importOriginal()),
    countTextTokens: tokenCountMocks.countTextTokens,
}));

import { createUsageLedger } from '../src/core/summarizer-usage.js';
import { resolveCallProfile } from '../src/core/call-profile.js';
import { makeSummarySettings } from './test-helpers.js';

// Length-based tokenizer: every expected token count below is the plain
// string length of the mocked input, an independent source of truth.
beforeEach(() => {
    tokenCountMocks.countTextTokens.mockImplementation(async (text) => ({
        count: String(text).length,
        estimated: false,
    }));
});

afterEach(() => {
    vi.clearAllMocks();
});

/** One resolved Call Profile for record()'s label and provenance reads. */
function makeProfile() {
    return resolveCallProfile(makeSummarySettings(), {});
}

/** Debug lines the shared logger mock captured. */
function debugLines() {
    return globalThis.summaryceptionFoundationMocks.logger.debug.mock.calls.map(([line]) =>
        String(line),
    );
}

/** Debug lines reporting a run's largest call, logged when a scope ends. */
function runMaxLines() {
    return debugLines().filter((line) => line.startsWith('LLM run '));
}

describe('createUsageLedger', () => {
    it('records a call with no open run and logs it without a run scope', async () => {
        const ledger = createUsageLedger();

        const usage = await ledger.record({
            systemPrompt: 'SYS',
            prompt: 'PROMPT',
            summary: 'SUM',
            profile: makeProfile(),
        });

        // 'SYS\nPROMPT' = 10 chars, 'SUM' = 3.
        expect(usage).toEqual({
            promptTokens: 10,
            completionTokens: 3,
            totalTokens: 13,
            promptTokensEstimated: false,
            completionTokensEstimated: false,
            totalTokensEstimated: false,
        });

        const lines = debugLines();
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('LLM call ');
        // callNumber 0 renders without a call ordinal.
        expect(lines[0]).not.toContain('#');
    });

    it('appends records to the open run and reports its largest call on end', async () => {
        const ledger = createUsageLedger();
        const profile = makeProfile();

        await ledger.withRun('unit test run', async () => {
            // 'S\nPROMPT' = 8, 'SUMMARY' = 7, total 15.
            await ledger.record({
                systemPrompt: 'S',
                prompt: 'PROMPT',
                summary: 'SUMMARY',
                profile,
            });
            // 'S\nLONG PROMPT' = 13, 'LONGER SUMMARY' = 14, total 27.
            await ledger.record({
                systemPrompt: 'S',
                prompt: 'LONG PROMPT',
                summary: 'LONGER SUMMARY',
                profile,
            });
        });

        const lines = runMaxLines();
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('LLM run unit test run max call: #2');
        expect(lines[0]).toContain('total=27');
    });

    it('records into every open run on the chain, each reporting its own max', async () => {
        const ledger = createUsageLedger();
        const profile = makeProfile();

        await ledger.withRun('outer run', async () => {
            // Total 15; outer call #1.
            await ledger.record({
                systemPrompt: 'S',
                prompt: 'PROMPT',
                summary: 'SUMMARY',
                profile,
            });
            await ledger.withRun('inner run', async () => {
                // Total 27; outer call #2 and inner call #1.
                await ledger.record({
                    systemPrompt: 'S',
                    prompt: 'LONG PROMPT',
                    summary: 'LONGER SUMMARY',
                    profile,
                });
            });
        });

        const lines = runMaxLines();
        expect(lines).toHaveLength(2);
        // The inner run sees only its own call.
        expect(lines[0]).toContain('LLM run inner run max call: #1');
        // The outer run's call list includes the descendant call.
        expect(lines[1]).toContain('LLM run outer run max call: #2');
    });

    it('logs the zero-total call a null-count tokenizer produces', async () => {
        const ledger = createUsageLedger();
        const profile = makeProfile();

        // estimate() sums the counts, so null counts yield a 0 total that
        // still qualifies as the run's max call; pin that exact behavior.
        tokenCountMocks.countTextTokens.mockImplementation(async () => ({
            count: null,
            estimated: true,
        }));

        await ledger.withRun('null run', async () => {
            await ledger.record({
                systemPrompt: 'S',
                prompt: 'PROMPT',
                summary: 'SUMMARY',
                profile,
            });
        });

        const lines = runMaxLines();
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('LLM run null run max call: #1');
        expect(lines[0]).toContain('total=~0');
    });

    it('keeps nested-run reporting when an inner run holds only zero-total calls', async () => {
        const ledger = createUsageLedger();
        const profile = makeProfile();

        await ledger.withRun('mixed run', async () => {
            await ledger.withRun('null inner run', async () => {
                tokenCountMocks.countTextTokens.mockImplementation(async () => ({
                    count: null,
                    estimated: true,
                }));
                await ledger.record({
                    systemPrompt: 'S',
                    prompt: 'PROMPT',
                    summary: 'SUMMARY',
                    profile,
                });
            });
            tokenCountMocks.countTextTokens.mockImplementation(async (text) => ({
                count: String(text).length,
                estimated: false,
            }));
            // Total 15; outer call #2.
            await ledger.record({
                systemPrompt: 'S',
                prompt: 'PROMPT',
                summary: 'SUMMARY',
                profile,
            });
        });

        const lines = runMaxLines();
        expect(lines).toHaveLength(2);
        // The inner run reports its own zero-total call.
        expect(lines[0]).toContain('LLM run null inner run max call: #1');
        expect(lines[0]).toContain('total=~0');
        // The outer run's max spans both calls and picks the counted one.
        expect(lines[1]).toContain('LLM run mixed run max call: #2');
        expect(lines[1]).toContain('total=15');
    });

    it('estimates the SummarizerTokenUsage shape from the active tokenizer', async () => {
        const ledger = createUsageLedger();

        const usage = await ledger.estimate('SYS', 'PROMPT', 'SUM');

        // 'SYS\nPROMPT' = 10 chars, 'SUM' = 3.
        expect(usage).toEqual({
            promptTokens: 10,
            completionTokens: 3,
            totalTokens: 13,
            promptTokensEstimated: false,
            completionTokensEstimated: false,
            totalTokensEstimated: false,
        });
    });
});
