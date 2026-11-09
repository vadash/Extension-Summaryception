import { describe, expect, it } from 'vitest';

import { resolveCallProfile } from '../src/core/call-profile.js';
import {
    buildCompressionLimits,
    buildCompressionPayloadFragments,
} from '../src/core/layer0-compression.js';
import { buildRecallBlock } from '../src/foundation/prompt-parts.js';
import {
    DEFAULT_PROMOTION_SYSTEM_PROMPT,
    DEFAULT_SUMMARIZER_SYSTEM_PROMPT,
    DEFAULT_SUMMARIZER_USER_PROMPT,
    LAYER0_RECALL_BODY,
    RECALL_COMPLIANCE,
} from '../src/foundation/prompt-constants.js';

/** The final line of a message. */
function lineOfTrigger(text) {
    const lines = String(text).trimEnd().split('\n');
    return lines[lines.length - 1].trim();
}

const settings = { layer0SummaryTokenTarget: 400 };

const layer0Profile = resolveCallProfile(settings, { kind: 'layer0', sourceRange: [12, 34] });

/** A payload message with its runtime provenance attached. */
function payloadWith(settingsFor, profile) {
    return `${profile.policy.userPromptTemplate}\n\n${buildCompressionPayloadFragments(
        settingsFor,
        profile,
    )}`;
}

const layer0PromptWithFragments = payloadWith(settings, layer0Profile);

/** A recall message with its volatile limits attached. */
function recallWith(settingsFor, profile, body) {
    return buildRecallBlock({
        body,
        limits: buildCompressionLimits(settingsFor, profile),
        triggerLine: profile.policy.triggerLine,
    });
}

describe('dense prompt grammar', () => {
    it('orders the layer0 system sections role, inv, out, task, rules', () => {
        const prompt = DEFAULT_SUMMARIZER_SYSTEM_PROMPT;
        const order = ['<role>', '<inv>', '<out>', '<task>', '<rules>'];
        const indexes = order.map((tag) => prompt.indexOf(tag));
        for (const [index, tag] of order.entries()) {
            expect(indexes[index], `${tag} present`).toBeGreaterThan(-1);
            if (index > 0) {
                expect(indexes[index], `${tag} after ${order[index - 1]}`).toBeGreaterThan(
                    indexes[index - 1],
                );
            }
        }
    });

    it('orders the layer0 request messages payload, recall body, limits, trigger', () => {
        const recall = recallWith(settings, layer0Profile, LAYER0_RECALL_BODY);
        const request = [DEFAULT_SUMMARIZER_USER_PROMPT, recall].join('\n\n');

        expect(layer0PromptWithFragments.indexOf('<in>')).toBeGreaterThan(-1);
        expect(layer0PromptWithFragments.indexOf('</in>')).toBeLessThan(
            layer0PromptWithFragments.indexOf('<budget>'),
        );
        expect(request.indexOf('<budget>')).toBeLessThan(request.indexOf(RECALL_COMPLIANCE));
        expect(request.indexOf(RECALL_COMPLIANCE)).toBeLessThan(request.indexOf('limits:'));
        expect(request.indexOf('limits:')).toBeLessThan(request.indexOf(lineOfTrigger(recall)));
    });

    it('keeps the system message free of the payload and the recall block', () => {
        expect(DEFAULT_SUMMARIZER_SYSTEM_PROMPT).not.toContain('<in>');
        expect(DEFAULT_SUMMARIZER_SYSTEM_PROMPT).not.toContain('<recall>');
        expect(DEFAULT_SUMMARIZER_SYSTEM_PROMPT).not.toContain('{{max_sentences');
        expect(DEFAULT_PROMOTION_SYSTEM_PROMPT).not.toContain('{{max_sentences');
    });
});
