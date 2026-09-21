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

    it('names the exact missing structural envelope', () => {
        const result = validateSummarizerOutputIntegrity(
            'location: dock',
            resolveCallProfile(makeSummarySettings(), { kind: 'layer0' }),
        );

        expect(result.valid).toBe(false);
        expect(result.error.message).toContain('missing <narrative> envelope');
    });

    it('rejects prose after the narrative close tag', () => {
        const result = validateSummarizerOutputIntegrity(
            '<narrative>Scene.</narrative>\nWhy I cannot summarize this: reasons.',
            resolveCallProfile(makeSummarySettings(), { kind: 'layer0' }),
        );

        expect(result.valid).toBe(false);
        expect(result.error.message).toContain('prose after </narrative>');
    });

    it('rejects a duplicate narrative close tag', () => {
        const result = validateSummarizerOutputIntegrity(
            '<narrative>Scene.</narrative>\n</narrative>',
            resolveCallProfile(makeSummarySettings(), { kind: 'layer0' }),
        );

        expect(result.valid).toBe(false);
        expect(result.error.message).toContain('duplicate </narrative>');
    });

    it('rejects prose before the narrative open tag', () => {
        const result = validateSummarizerOutputIntegrity(
            'I cannot summarize this passage.\n<narrative>Scene.</narrative>',
            resolveCallProfile(makeSummarySettings(), { kind: 'layer0' }),
        );

        expect(result.valid).toBe(false);
        expect(result.error.message).toContain('missing <narrative> envelope');
    });

    it('rejects an empty narrative body', () => {
        const result = validateSummarizerOutputIntegrity(
            '<narrative></narrative>\ncurrent_date_time: 2024-07-04 16 Thu',
            resolveCallProfile(makeSummarySettings(), { kind: 'layer0' }),
        );

        expect(result.valid).toBe(false);
        expect(result.error.message).toContain('empty <narrative> body');
    });

    it('accepts a well-formed envelope with scene time and extracts the body', () => {
        const result = validateSummarizerOutputIntegrity(
            '<narrative>\nScene one. Scene two.\n</narrative>\ncurrent_date_time: 2024-07-04 16 Thu',
            resolveCallProfile(makeSummarySettings(), { kind: 'layer0' }),
        );

        expect(result.valid).toBe(true);
        expect(result.error).toBeNull();
    });

    it('accepts multi-line prose inside the envelope', () => {
        const result = validateSummarizerOutputIntegrity(
            '<narrative>\nScene one.\nScene two.\n</narrative>',
            resolveCallProfile(makeSummarySettings(), { kind: 'layer0' }),
        );

        expect(result.valid).toBe(true);
    });

    it('rejects a declined marker as a retryable refusal', () => {
        const result = validateSummarizerOutputIntegrity(
            '<declined>explicit sexual content</declined>',
            resolveCallProfile(makeSummarySettings(), { kind: 'layer0' }),
        );

        expect(result.valid).toBe(false);
        expect(result.error.retryable).toBe(true);
        expect(result.error.message).toContain(
            'declined the summarization task: explicit sexual content',
        );
    });

    it('rejects a bare lexical refusal in the narrative body', () => {
        const result = validateSummarizerOutputIntegrity(
            "<narrative>I can't summarize this passage.</narrative>",
            resolveCallProfile(makeSummarySettings(), { kind: 'layer0' }),
        );

        expect(result.valid).toBe(false);
        expect(result.error.retryable).toBe(true);
        expect(result.error.message).toContain('refusal pattern');
    });

    it('keeps in-story first-person dialogue inert in the narrative body', () => {
        const result = validateSummarizerOutputIntegrity(
            '<narrative>She ruled that a brother never wakes a sleeping sister, and he owed her desserts twice a week.</narrative>',
            resolveCallProfile(makeSummarySettings(), { kind: 'layer0' }),
        );

        expect(result.valid).toBe(true);
    });

    it('rejects a meta-describing body that names none of the passage names', () => {
        const result = validateSummarizerOutputIntegrity(
            '<narrative>The passage contains several scenes of the two characters talking and shopping together.</narrative>',
            resolveCallProfile(makeSummarySettings(), {
                kind: 'layer0',
                passageNames: 'Quipsy, Vova',
                sourceTokensBefore: 2000,
            }),
        );

        expect(result.valid).toBe(false);
        expect(result.error.retryable).toBe(true);
        expect(result.error.message).toContain('names none of the passage names');
    });

    it('accepts a real summary that names a passage character on a substantial source', () => {
        const result = validateSummarizerOutputIntegrity(
            '<narrative>' +
                'Quipsy moved in while the parents were away and claimed the room across from his at once. ' +
                'Vova won her over with vegetables and a juicer bought before she even arrived, and she admitted ' +
                'she never eats meat and cannot stand its smell. They struck a deal over desserts and shopping ' +
                'trips, and Mom approvingly texted about the mall visit later that same afternoon. ' +
                '</narrative>',
            resolveCallProfile(makeSummarySettings(), {
                kind: 'layer0',
                passageNames: 'Quipsy, Vova',
                sourceTokensBefore: 2000,
            }),
        );
        expect(result.valid).toBe(true);
    });

    it('skips the shape signal on a small source', () => {
        const result = validateSummarizerOutputIntegrity(
            '<narrative>The passage contains several scenes of the two characters talking and shopping together.</narrative>',
            resolveCallProfile(makeSummarySettings(), {
                kind: 'layer0',
                passageNames: 'Quipsy, Vova',
                sourceTokensBefore: 100,
            }),
        );

        expect(result.valid).toBe(true);
    });
});
