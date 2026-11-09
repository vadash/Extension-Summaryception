import { afterEach, describe, expect, it, vi } from 'vitest';

import { NOTIFY_EVENTS } from '../src/foundation/constants.js';
import { resolveCallProfile } from '../src/core/call-profile.js';
import { processSummarizerResponse } from '../src/core/summarizer-output.js';
import {
    installBrowserRuntimeStub,
    makeNotifyRecorder,
    makeSummarySettings,
} from './test-helpers.js';

const SCENE_TIME_LINE = 'current_date_time: 2024-05-04 09 Sat';

/**
 * Drive the whole Output Hygiene chain through the public seam with no host
 * context installed. `SillyTavern` is undefined, so any settings-store read
 * would throw before the response could be classified; the frozen call profile
 * must carry every policy input.
 */
async function processRaw(raw, settingsOverrides = {}, notify, metadata = {}) {
    vi.stubGlobal('SillyTavern', undefined);
    const profile = resolveCallProfile(makeSummarySettings(settingsOverrides), {
        kind: 'layer0',
        ...metadata,
    });
    return processSummarizerResponse(raw, profile, notify);
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('summarizer output hygiene', () => {
    describe('cleaning', () => {
        it('cleans and accepts a response without reading the settings store', async () => {
            const raw = `<narrative>\nMira crossed the flooded bridge before dawn.\n</narrative>\n${SCENE_TIME_LINE}`;

            const result = await processRaw(raw);

            expect(result.status).toBe('success');
            expect(result.text).toBe(raw);
            expect(result.error).toBeNull();
        });

        it('strips a leading think region before header normalization', async () => {
            const raw =
                '<think>\n[NARRATIVE]\nInternal plan.' +
                `<narrative>\nMira crossed the flooded bridge.\n</narrative>\n${SCENE_TIME_LINE}`;

            const result = await processRaw(raw);

            expect(result.status).toBe('success');
            expect(result.text).toBe(
                `<narrative>\nMira crossed the flooded bridge.\n</narrative>\n${SCENE_TIME_LINE}`,
            );
            expect(result.text).not.toContain('Internal plan');
            expect(result.text).not.toContain('NARRATIVE');
        });

        it('normalizes a legacy line-start header before configured strip patterns', async () => {
            const raw = `[NARRATIVE]\nMira crossed the flooded bridge.\n[/NARRATIVE]\n${SCENE_TIME_LINE}`;

            const result = await processRaw(raw, {
                stripPatterns: ['[NARRATIVE]', '[/NARRATIVE]'],
            });

            expect(result.status).toBe('success');
            expect(result.text).toContain('<narrative>');
            expect(result.text).toContain('</narrative>');
            expect(result.text).not.toContain('[NARRATIVE]');
        });

        it('strips a configured marker inside the body', async () => {
            const raw = `<narrative>\nMira crossed the bridge.[NOISE]The town slept.\n</narrative>\n${SCENE_TIME_LINE}`;

            const result = await processRaw(raw, { stripPatterns: ['[NOISE]'] });

            expect(result.status).toBe('success');
            expect(result.text).toBe(
                `<narrative>\nMira crossed the bridge.The town slept.\n</narrative>\n${SCENE_TIME_LINE}`,
            );
        });

        it('collapses whitespace runs last and trims the result', async () => {
            const raw = `<narrative>\nMira crossed.\n\n\n\nThe town slept.\n</narrative>\n\n\n${SCENE_TIME_LINE}`;

            const result = await processRaw(raw);

            expect(result.status).toBe('success');
            expect(result.text).toBe(
                `<narrative>\nMira crossed.\nThe town slept.\n</narrative>\n${SCENE_TIME_LINE}`,
            );
        });
    });

    describe('refusals', () => {
        it('keeps a declined marker on the Refusal Guard path', async () => {
            const result = await processRaw('<declined>explicit sexual content</declined>');

            expect(result.status).toBe('integrity-rejected');
            expect(result.error.retryable).toBe(true);
            expect(result.error.message).toContain(
                'declined the summarization task: explicit sexual content',
            );
        });

        it('rejects a lexical refusal in the narrative body', async () => {
            const result = await processRaw(
                "<narrative>\nI can't summarize this passage.\n</narrative>",
            );

            expect(result.status).toBe('integrity-rejected');
            expect(result.error.retryable).toBe(true);
            expect(result.error.message).toContain('refusal pattern');
        });

        it('lets an integrity failure win over a size failure', async () => {
            const body =
                "I can't summarize this passage. " +
                'The caravan moved through the valley. '.repeat(120);
            const raw = `<narrative>\n${body}\n</narrative>\n${SCENE_TIME_LINE}`;

            const result = await processRaw(raw, { layer0SummaryTokenTarget: 80 });

            expect(result.status).toBe('integrity-rejected');
            expect(result.error.retryable).toBe(true);
            expect(result.error.message).toContain('refusal pattern');
        });

        it('size-rejects a structurally valid but oversized body', async () => {
            const body =
                'The caravan moved through the valley and the river ran beside it. '.repeat(60);
            const raw = `<narrative>\n${body.trim()}\n</narrative>\n${SCENE_TIME_LINE}`;

            const result = await processRaw(raw, { layer0SummaryTokenTarget: 80 });

            expect(result.status).toBe('size-rejected');
            expect(result.error.retryable).toBe(true);
        });

        it('keeps the cleaned text on a pre-existing rejection path', async () => {
            const result = await processRaw(
                'The party rested at the inn before the crossing.[DROP]',
                { stripPatterns: ['[DROP]'] },
            );

            expect(result.status).toBe('integrity-rejected');
            expect(result.error.retryable).toBe(true);
            expect(result.text).toBe('The party rested at the inn before the crossing.');
        });
    });
});

/**
 * A failed attempt must keep what the LLM actually returned: the attempt log
 * renders `cleanedResult`, and every rejection path funnels its text through
 * `processSummarizerResponse`.
 */
describe('summarizer output rejection', () => {
    it('keeps the cleaned LLM output on an integrity rejection', async () => {
        const raw = 'The party rested at the inn before the crossing.';
        const result = await processRaw(raw);

        expect(result.status).toBe('integrity-rejected');
        expect(result.error.retryable).toBe(true);
        expect(result.text).toBe(raw);
        expect(typeof result.repairFeedback).toBe('string');
        expect(result.repairFeedback.length).toBeGreaterThan(0);
        expect(result.repairFeedback).toContain('<narrative>');
        expect(result.repairFeedback).toContain('current_date_time:');
        for (const line of result.repairFeedback.split('\n').filter(Boolean)) {
            expect(line).toContain(':');
        }
    });

    it('reports an empty response without text', async () => {
        const result = await processRaw('   \n  ');

        expect(result.status).toBe('empty');
        expect(result.text).toBe('');
    });

    it('names the exact missing structural envelope', async () => {
        const result = await processRaw('location: dock');

        expect(result.status).toBe('integrity-rejected');
        expect(result.error.message).toContain('missing <narrative> envelope');
    });

    it('rejects prose after the narrative close tag', async () => {
        const result = await processRaw(
            '<narrative>Scene.</narrative>\nWhy I cannot summarize this: reasons.',
        );

        expect(result.status).toBe('integrity-rejected');
        expect(result.error.message).toContain('prose after </narrative>');
    });

    it('rejects a duplicate narrative close tag', async () => {
        const result = await processRaw('<narrative>Scene.</narrative>\n</narrative>');

        expect(result.status).toBe('integrity-rejected');
        expect(result.error.message).toContain('duplicate </narrative>');
    });

    it('rejects prose before the narrative open tag', async () => {
        const result = await processRaw(
            'I cannot summarize this passage.\n<narrative>Scene.</narrative>',
        );

        expect(result.status).toBe('integrity-rejected');
        expect(result.error.message).toContain('missing <narrative> envelope');
    });

    it('rejects an empty narrative body', async () => {
        const result = await processRaw(
            '<narrative></narrative>\ncurrent_date_time: 2024-07-04 16 Thu',
        );

        expect(result.status).toBe('integrity-rejected');
        expect(result.error.message).toContain('empty <narrative> body');
    });

    it('accepts a well-formed envelope with scene time', async () => {
        const raw =
            '<narrative>\nScene one. Scene two.\n</narrative>\ncurrent_date_time: 2024-07-04 16 Thu';

        const result = await processRaw(raw);

        expect(result.status).toBe('success');
        expect(result.error).toBeNull();
        expect(result.text).toBe(raw);
    });

    it('accepts multi-line prose inside the envelope', async () => {
        const result = await processRaw('<narrative>\nScene one.\nScene two.\n</narrative>');

        expect(result.status).toBe('success');
    });

    it('keeps in-story first-person dialogue inert in the narrative body', async () => {
        const result = await processRaw(
            '<narrative>She ruled that a brother never wakes a sleeping sister, and he owed her desserts twice a week.</narrative>',
        );

        expect(result.status).toBe('success');
    });

    it('rejects a meta-describing body that names none of the passage names', async () => {
        const result = await processRaw(
            '<narrative>The passage contains several scenes of the two characters talking and shopping together.</narrative>',
            {},
            undefined,
            {
                passageNames: 'Quipsy, Vova',
                sourceTokensBefore: 2000,
            },
        );

        expect(result.status).toBe('integrity-rejected');
        expect(result.error.retryable).toBe(true);
        expect(result.error.message).toContain('names none of the passage names');
    });

    it('accepts a real summary that names a passage character on a substantial source', async () => {
        const result = await processRaw(
            '<narrative>' +
                'Quipsy moved in while the parents were away and claimed the room across from his at once. ' +
                'Vova won her over with vegetables and a juicer bought before she even arrived, and she admitted ' +
                'she never eats meat and cannot stand its smell. They struck a deal over desserts and shopping ' +
                'trips, and Mom approvingly texted about the mall visit later that same afternoon. ' +
                '</narrative>',
            {},
            undefined,
            {
                passageNames: 'Quipsy, Vova',
                sourceTokensBefore: 2000,
            },
        );

        expect(result.status).toBe('success');
    });

    it('skips the shape signal on a small source', async () => {
        const result = await processRaw(
            '<narrative>The passage contains several scenes of the two characters talking and shopping together.</narrative>',
            {},
            undefined,
            {
                passageNames: 'Quipsy, Vova',
                sourceTokensBefore: 100,
            },
        );

        expect(result.status).toBe('success');
    });
});

/**
 * The summarizer output module emits structured notify events (ADR-0019) instead
 * of calling the notification library. The entry adapter renders the language-mix
 * retry warning.
 */
describe('summarizer output notify', () => {
    it('keeps the cleaned output and emits one language-mix event on a CN-policy rejection', async () => {
        const { toastr } = installBrowserRuntimeStub();
        const recorder = makeNotifyRecorder();
        const raw = '这是一段用于测试的中文摘要文本';

        const result = await processRaw(raw, { stripChineseIdeographs: true }, recorder);

        expect(result.status).toBe('cn-rejected');
        expect(result.text).toBe(raw);
        expect(toastr.warning).not.toHaveBeenCalled();
        expect(recorder.events).toEqual([
            {
                type: 'transient',
                kind: NOTIFY_EVENTS.LANGUAGE_MIX_RETRY,
                percent: '100.0',
            },
        ]);
    });
});
