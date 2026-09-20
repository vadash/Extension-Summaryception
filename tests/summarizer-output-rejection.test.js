import { describe, expect, it } from 'vitest';

import { resolveCallProfile } from '../src/core/call-profile.js';
import {
    processSummarizerResponse,
    validateSummarizerOutputIntegrity,
} from '../src/core/summarizer-output.js';
import { makeSummarySettings } from './test-helpers.js';

/**
 * A failed attempt must keep what the LLM actually returned: the attempt log
 * renders `cleanedResult`, and every rejection path funnels its text through
 * `processSummarizerResponse`.
 */
describe('summarizer output rejection payloads', () => {
    it('keeps the cleaned LLM output on an integrity rejection', async () => {
        const settings = makeSummarySettings();
        const raw = 'The party rested at the inn before the crossing.';
        const result = await processSummarizerResponse(
            raw,
            resolveCallProfile(settings, { kind: 'layer0' }),
        );

        expect(result.status).toBe('integrity-rejected');
        expect(result.error.retryable).toBe(true);
        expect(result.text).toBe(raw);
    });

    it('keeps the cleaned LLM output on a CN-policy rejection', async () => {
        const settings = makeSummarySettings({ stripChineseIdeographs: true });
        const result = await processSummarizerResponse(
            '这是一段用于测试的中文摘要文本',
            resolveCallProfile(settings, { kind: 'layer0' }),
        );

        expect(result.status).toBe('cn-rejected');
        expect(result.text).toBe('这是一段用于测试的中文摘要文本');
    });

    it('reports an empty response without text', async () => {
        const settings = makeSummarySettings();
        const result = await processSummarizerResponse(
            '   \n  ',
            resolveCallProfile(settings, { kind: 'layer0' }),
        );

        expect(result.status).toBe('empty');
        expect(result.text).toBe('');
    });

    it('names the exact missing structural header', () => {
        const result = validateSummarizerOutputIntegrity(
            'location: dock',
            resolveCallProfile(makeSummarySettings(), { kind: 'layer0' }),
        );

        expect(result.valid).toBe(false);
        expect(result.error.message).toContain('missing [NARRATIVE] header');
    });
});
