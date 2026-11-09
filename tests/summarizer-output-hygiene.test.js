import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveCallProfile } from '../src/core/call-profile.js';
import { processSummarizerResponse } from '../src/core/summarizer-output.js';
import { makeSummarySettings } from './test-helpers.js';

const SCENE_TIME_LINE = 'current_date_time: 2024-05-04 09 Sat';

/**
 * Drive the whole Output Hygiene chain through the public seam with no host
 * context installed. `SillyTavern` is undefined, so any settings-store read
 * would throw before the response could be classified.
 */
async function processRaw(raw, settingsOverrides = {}) {
    vi.stubGlobal('SillyTavern', undefined);
    const profile = resolveCallProfile(makeSummarySettings(settingsOverrides), {
        kind: 'layer0',
    });
    return processSummarizerResponse(raw, profile);
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('summarizer output hygiene chain', () => {
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

describe('summarizer output hygiene refusals', () => {
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
        const body = 'The caravan moved through the valley and the river ran beside it. '.repeat(
            60,
        );
        const raw = `<narrative>\n${body.trim()}\n</narrative>\n${SCENE_TIME_LINE}`;

        const result = await processRaw(raw, { layer0SummaryTokenTarget: 80 });

        expect(result.status).toBe('size-rejected');
        expect(result.error.retryable).toBe(true);
    });

    it('keeps the cleaned text on a pre-existing rejection path', async () => {
        const result = await processRaw('The party rested at the inn before the crossing.[DROP]', {
            stripPatterns: ['[DROP]'],
        });

        expect(result.status).toBe('integrity-rejected');
        expect(result.error.retryable).toBe(true);
        expect(result.text).toBe('The party rested at the inn before the crossing.');
    });
});
