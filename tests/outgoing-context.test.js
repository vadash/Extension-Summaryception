import { describe, expect, it, vi } from 'vitest';

import {
    EXTENSION_PROMPT_POSITIONS,
    EXTENSION_PROMPT_ROLES,
    GUARD_MASK_COT_MODES,
    MASK_USER_ROLE_MODES,
    defaultSettings,
} from '../src/foundation/constants.js';
import {
    buildOutgoingContext,
    captureOutgoingSnapshot,
    deriveOutgoingDivergence,
} from '../src/entry/outgoing-context.js';
import { applyOutgoingRewriteToPreview } from '../src/entry/dryrun-viewer.js';
import { rewriteOutgoingPrompt } from '../src/core/outgoing-rewrite.js';
import { onGenerateAfterData } from '../src/entry/events.js';
import { formatMicroficheMarker } from '../src/core/microfiche-transport.js';
import { renderInjectionTemplate } from '../src/core/memory-injection.js';
import { installSummaryContext, makeMemoryInjectionWriter } from './test-helpers.js';

const B = '\u2800';

function makeSettings(overrides = {}) {
    return {
        ...defaultSettings,
        enabled: true,
        stripChineseIdeographs: false,
        maskUserRoleAsAssistant: false,
        maskUserRoleMode: MASK_USER_ROLE_MODES.MARKER_FIRST,
        guardMask: true,
        guardMaskMemory: false,
        guardMaskCotMode: GUARD_MASK_COT_MODES.AUTO,
        guardMaskCotCount: 2,
        ...overrides,
    };
}

function makeSlotFacts(text, role = EXTENSION_PROMPT_ROLES.SYSTEM) {
    const options = {
        position: EXTENSION_PROMPT_POSITIONS.IN_CHAT,
        depth: 0,
        scan: false,
        role,
    };
    return {
        text,
        options,
        hasSlot: text !== '',
        lastInjectionKey: JSON.stringify({ text, options }),
    };
}

function makeWriter(slotFacts, resolvePage = undefined) {
    return {
        getSlotFacts: () => ({ ...slotFacts, options: { ...slotFacts.options } }),
        resolveMicrofichePage: resolvePage,
    };
}

describe('outgoing context unique string slot', () => {
    it('resolves a placed reference and skips only that message', () => {
        const slotText = 'MEMORY <preserved>exact bytes</preserved>';
        const slotMessage = { role: 'system', content: slotText };
        const other = { role: 'user', content: 'hello  world' };
        const twin = { role: 'user', content: slotText };
        void twin;
        const messages = [other, slotMessage];
        const writer = makeWriter(makeSlotFacts(slotText));
        const context = buildOutgoingContext(messages, {
            writer,
            settings: makeSettings(),
            chat: [],
            modelName: 'argon-test',
        });

        expect(context.slot.state).toBe('placed');
        expect(context.slot.message).toBe(slotMessage);
        expect(context.slot.expectedText).toBe(slotText);

        const result = rewriteOutgoingPrompt(messages, context);
        expect(other.content).toBe(`hello${B}world`);
        expect(slotMessage.content).toBe(slotText);
        expect(result.slotStatus).toBe('skipped');
    });
});

describe('outgoing context multipart slot', () => {
    it('derives expected parts through the transport expansion seam', () => {
        const marker = formatMicroficheMarker(0);
        const slotText = `MEMORY head\n${marker}\nMEMORY tail`;
        const page = { dataUrl: 'data:image/png;base64,PAGE0', text: 'PAGE ZERO TEXT' };
        const resolvePage = () => page;
        const writer = makeWriter(makeSlotFacts(slotText), resolvePage);
        const slotMessage = {
            role: 'system',
            content: [
                { type: 'text', text: 'MEMORY head\n' },
                { type: 'image_url', image_url: { url: page.dataUrl } },
                { type: 'text', text: '\nMEMORY tail' },
            ],
        };
        const other = { role: 'user', content: 'hello  world' };
        const messages = [slotMessage, other];
        const context = buildOutgoingContext(messages, {
            writer,
            settings: makeSettings(),
            chat: [],
            modelName: 'opus-test',
            resolvePage,
        });

        expect(context.slot.state).toBe('placed');
        expect(context.slot.message).toBe(slotMessage);
        expect(Array.isArray(context.slot.expectedParts)).toBe(true);

        const result = rewriteOutgoingPrompt(messages, context);
        expect(slotMessage.content[0].text).toBe('MEMORY head\n');
        expect(other.content).toBe(`hello${B}world`);
        expect(result.slotStatus).toBe('skipped');
    });
});

describe('outgoing context preserved and repeated placeholders', () => {
    it('keeps one logical slot for Preserved Message bytes', () => {
        const slotText =
            '<summaryception_memory>\nMEMORY <preserved>exact bytes</preserved>\n</summaryception_memory>';
        const slotMessage = { role: 'system', content: slotText };
        const messages = [{ role: 'user', content: 'hi  there' }, slotMessage];
        const writer = makeWriter(makeSlotFacts(slotText));
        const context = buildOutgoingContext(messages, {
            writer,
            settings: makeSettings(),
            chat: [],
            modelName: 'gemini-test',
        });

        expect(context.slot.state).toBe('placed');
        expect(context.slot.message).toBe(slotMessage);
        const result = rewriteOutgoingPrompt(messages, context);
        expect(messages[0].content).toBe(`hi${B}there`);
        expect(slotMessage.content).toBe(slotText);
        expect(result.slotStatus).toBe('skipped');
    });

    it('treats repeated template placeholders as one slot message', () => {
        const rendered = renderInjectionTemplate(
            { memoryText: 'MEM', snippetText: 'SNIP' },
            { injectionTemplate: '{{summary}}||{{summary}}' },
        );
        expect(rendered).toBe('MEM||SNIP');
        const slotMessage = { role: 'system', content: rendered };
        const messages = [slotMessage];
        const writer = makeWriter(makeSlotFacts(rendered));
        const context = buildOutgoingContext(messages, {
            writer,
            settings: makeSettings({ injectionTemplate: '{{summary}}||{{summary}}' }),
            chat: [],
            modelName: 'argon-x',
        });

        expect(context.slot.state).toBe('placed');
        expect(context.slot.message).toBe(slotMessage);
    });
});

describe('outgoing context absence and ambiguity', () => {
    it('reports absent for Macro-only placement', () => {
        const options = {
            position: EXTENSION_PROMPT_POSITIONS.NONE,
            depth: 0,
            scan: false,
            role: EXTENSION_PROMPT_ROLES.SYSTEM,
        };
        const writer = makeWriter({ text: '', options, hasSlot: false, lastInjectionKey: '' });
        const messages = [{ role: 'user', content: 'hello  world' }];
        const context = buildOutgoingContext(messages, {
            writer,
            settings: makeSettings(),
            chat: [],
            modelName: 'argon-x',
        });

        expect(context.slot.state).toBe('absent');
    });

    it('reports absent for empty slot text', () => {
        const writer = makeWriter(makeSlotFacts(''));
        const messages = [{ role: 'user', content: 'hello  world' }];
        const context = buildOutgoingContext(messages, {
            writer,
            settings: makeSettings(),
            chat: [],
            modelName: 'argon-x',
        });

        expect(context.slot.state).toBe('absent');
    });

    it('reports unresolved when identical text appears twice', () => {
        const slotText = 'MEMORY duplicate';
        const first = { role: 'user', content: slotText };
        const second = { role: 'user', content: slotText };
        const messages = [first, second];
        const writer = makeWriter(makeSlotFacts(slotText, EXTENSION_PROMPT_ROLES.USER));
        const context = buildOutgoingContext(messages, {
            writer,
            settings: makeSettings(),
            chat: [],
            modelName: 'argon-x',
        });

        expect(context.slot.state).toBe('unresolved');
        const result = rewriteOutgoingPrompt(messages, context);
        expect(first.content).toBe(`MEMORY${B}duplicate`);
        expect(second.content).toBe(`MEMORY${B}duplicate`);
        expect(result.slotStatus).toBe('unresolved');
    });

    it('reports unresolved when no message matches', () => {
        const writer = makeWriter(makeSlotFacts('MEMORY missing'));
        const messages = [{ role: 'user', content: 'hello  world' }];
        const context = buildOutgoingContext(messages, {
            writer,
            settings: makeSettings(),
            chat: [],
            modelName: 'argon-x',
        });

        expect(context.slot.state).toBe('unresolved');
    });
});

describe('outgoing context model and chat facts', () => {
    it('resolves the guard verdict from the model name', () => {
        const slotText = 'MEMORY body';
        const messages = [{ role: 'system', content: slotText }];
        const writer = makeWriter(makeSlotFacts(slotText));

        const enabled = buildOutgoingContext(messages, {
            writer,
            settings: makeSettings({ guardMask: true }),
            chat: [],
            modelName: 'Argon-9B',
        });
        expect(enabled.guardEnabled).toBe(true);

        const disabled = buildOutgoingContext(messages, {
            writer,
            settings: makeSettings({ guardMask: true }),
            chat: [],
            modelName: 'plain-model',
        });
        expect(disabled.guardEnabled).toBe(false);
    });

    it('captures the chat-tail anchor for Preset CoT exemptions', () => {
        const messages = [
            { role: 'user', content: 'I open the door.' },
            { role: 'user', content: 'Think step by step.' },
            { role: 'user', content: 'Second reasoning.' },
        ];
        const writer = makeWriter(makeSlotFacts(''));
        const context = buildOutgoingContext(messages, {
            writer,
            settings: makeSettings(),
            chat: [{ mes: 'I open the door.' }],
            modelName: 'argon-x',
        });

        expect(context.chatTailAnchor).toBe('I open the door.');
        rewriteOutgoingPrompt(messages, context);
        expect(messages[1].content).toBe('Think step by step.');
        expect(messages[2].content).toBe('Second reasoning.');
    });
});

describe('outgoing live event integration', () => {
    it('rewrites live generation once and skips the placed slot', () => {
        installSummaryContext({
            chat: [{ mes: 'hello' }],
            settings: makeSettings({ guardMask: true }),
            getChatCompletionModel: () => 'argon-live',
        });
        const slotText = 'MEMORY live';
        const slotMessage = { role: 'system', content: slotText };
        const other = { role: 'user', content: 'hello  world' };
        const writer = makeMemoryInjectionWriter();
        vi.spyOn(writer, 'getSlotFacts').mockReturnValue({
            text: slotText,
            options: {
                position: EXTENSION_PROMPT_POSITIONS.IN_CHAT,
                depth: 0,
                scan: false,
                role: EXTENSION_PROMPT_ROLES.SYSTEM,
            },
            hasSlot: true,
            lastInjectionKey: 'live-key',
        });
        const generateData = { prompt: [other, slotMessage] };

        onGenerateAfterData(generateData, false, { writer });

        expect(other.content).toBe(`hello${B}world`);
        expect(slotMessage.content).toBe(slotText);
    });

    it('leaves dry runs and disabled extensions untouched', () => {
        installSummaryContext({
            chat: [],
            settings: makeSettings(),
        });
        const writer = makeMemoryInjectionWriter();
        const dryPayload = { prompt: [{ role: 'user', content: 'dry  run' }] };
        onGenerateAfterData(dryPayload, true, { writer });
        expect(dryPayload.prompt[0].content).toBe('dry  run');

        const disabledPayload = { prompt: [{ role: 'user', content: 'off  here' }] };
        onGenerateAfterData(disabledPayload, false, {
            writer,
            settings: makeSettings({ enabled: false }),
            modelName: 'argon-x',
        });
        expect(disabledPayload.prompt[0].content).toBe('off  here');
    });
});
describe('outgoing capture divergence', () => {
    it('returns no divergence when nothing changed', () => {
        const writer = makeWriter(makeSlotFacts('MEMORY body'));
        const options = { writer, settings: makeSettings(), chat: [], modelName: 'argon-x' };
        const captured = captureOutgoingSnapshot(options);
        const current = captureOutgoingSnapshot(options);

        expect(deriveOutgoingDivergence(captured, current)).toEqual([]);
    });

    it('flags model, chat, settings, and slot changes separately', () => {
        const base = {
            writer: makeWriter(makeSlotFacts('MEMORY one')),
            settings: makeSettings(),
            chat: [{ mes: 'hello' }],
            modelName: 'argon-a',
        };
        const captured = captureOutgoingSnapshot(base);

        expect(
            deriveOutgoingDivergence(
                captured,
                captureOutgoingSnapshot({ ...base, modelName: 'opus-b' }),
            ),
        ).toEqual([{ kind: 'model-changed' }]);
        expect(
            deriveOutgoingDivergence(
                captured,
                captureOutgoingSnapshot({ ...base, chat: [{ mes: 'moved on' }] }),
            ),
        ).toEqual([{ kind: 'chat-tail-changed' }]);
        expect(
            deriveOutgoingDivergence(
                captured,
                captureOutgoingSnapshot({
                    ...base,
                    settings: makeSettings({ guardMaskMemory: true }),
                }),
            ),
        ).toEqual([{ kind: 'settings-changed' }]);
        expect(
            deriveOutgoingDivergence(
                captured,
                captureOutgoingSnapshot({
                    ...base,
                    writer: makeWriter(makeSlotFacts('MEMORY two')),
                }),
            ),
        ).toEqual([{ kind: 'slot-changed' }]);
    });

    it('uses the shared core operation for preview and live', () => {
        const slotText = 'MEMORY shared';
        const settings = makeSettings();
        const writer = makeWriter(makeSlotFacts(slotText, EXTENSION_PROMPT_ROLES.USER));
        const input = [
            { role: 'user', content: slotText },
            { role: 'user', content: 'hello  world' },
        ];

        const live = structuredClone(input);
        rewriteOutgoingPrompt(
            live,
            buildOutgoingContext(live, { writer, settings, modelName: 'argon-x' }),
        );

        const preview = structuredClone(input);
        const outgoing = applyOutgoingRewriteToPreview(preview, writer, settings, {
            modelName: 'argon-x',
        });

        expect(preview).toEqual(live);
        expect(outgoing.slotStatus).toBe('skipped');
    });

    it('reports capture-unavailable when the baseline is null or malformed', () => {
        const writer = makeWriter(makeSlotFacts('MEMORY body'));
        const current = captureOutgoingSnapshot({
            writer,
            settings: makeSettings(),
            chat: [],
            modelName: 'argon-x',
        });

        expect(deriveOutgoingDivergence(null, current)).toEqual([{ kind: 'capture-unavailable' }]);
        expect(deriveOutgoingDivergence({ modelName: 'argon-x' }, current)).toEqual([
            { kind: 'capture-unavailable' },
        ]);
        expect(deriveOutgoingDivergence(current, null)).toEqual([{ kind: 'capture-unavailable' }]);
    });
});
