import { describe, expect, it } from 'vitest';

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
        const raw = 'The party rested at the inn before the crossing.';
        const result = await processSummarizerResponse(raw, makeSummarySettings(), {
            kind: 'layer0',
        });

        expect(result.status).toBe('integrity-rejected');
        expect(result.error.retryable).toBe(true);
        expect(result.text).toBe(raw);
    });

    it('keeps the cleaned LLM output on a CN-policy rejection', async () => {
        const raw = '这是一段用于测试的中文摘要文本';
        const result = await processSummarizerResponse(
            raw,
            makeSummarySettings({ stripChineseIdeographs: true }),
            { kind: 'layer0' },
        );

        expect(result.status).toBe('cn-rejected');
        expect(result.text).toBe(raw);
    });

    it('reports an empty response without text', async () => {
        const result = await processSummarizerResponse('   \n  ', makeSummarySettings(), {
            kind: 'layer0',
        });

        expect(result.status).toBe('empty');
        expect(result.text).toBe('');
    });

    it('names the exact missing structural header', () => {
        const result = validateSummarizerOutputIntegrity('[STATE]\nlocation: dock', {
            kind: 'layer0',
        });

        expect(result.valid).toBe(false);
        expect(result.error.message).toContain('missing [NARRATIVE] header');
    });
});
