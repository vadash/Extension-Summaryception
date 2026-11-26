import { describe, expect, it } from 'vitest';

import { GUARD_MASK_COT_MODES, MASK_USER_ROLE_MODES } from '../src/foundation/constants.js';
import { rewriteOutgoingPrompt } from '../src/core/outgoing-rewrite.js';

const B = '\u2800';

function baseContext(overrides = {}) {
    return {
        enabled: true,
        stripChineseIdeographs: false,
        maskUserRoleAsAssistant: false,
        maskUserRoleMode: MASK_USER_ROLE_MODES.MARKER_FIRST,
        guardMaskMemory: false,
        guardMaskCotMode: GUARD_MASK_COT_MODES.AUTO,
        guardMaskCotCount: 2,
        guardEnabled: true,
        chatTailAnchor: null,
        slot: { state: 'absent', message: null, expectedText: null, expectedParts: null },
        ...overrides,
    };
}

function placedStringSlot(message) {
    return { state: 'placed', message, expectedText: message.content, expectedParts: null };
}

function placedMultipartSlot(message) {
    const expectedParts = message.content.map((part) =>
        part && typeof part === 'object' && typeof part.text === 'string' ? part.text : null,
    );
    return { state: 'placed', message, expectedText: null, expectedParts };
}

describe('outgoing rewrite guard branch', () => {
    it('masks horizontal whitespace runs in user and assistant content, leaves system alone', () => {
        const messages = [
            { role: 'system', content: 'hello  world' },
            { role: 'user', content: 'hello  world' },
            { role: 'assistant', content: 'a\tb' },
        ];
        const result = rewriteOutgoingPrompt(messages, baseContext());

        expect(messages[0].content).toBe('hello  world');
        expect(messages[1].content).toBe(`hello${B}world`);
        expect(messages[2].content).toBe(`a${B}b`);
        expect(result).toMatchObject({ rewrittenCount: 0, guardBranch: 'mask' });
    });

    it('unmask branch folds braille and legacy dollars with no exemptions or skip', () => {
        const slotMessage = { role: 'user', content: `MEMORY${B}slot` };
        const messages = [
            { role: 'user', content: 'last chat' },
            slotMessage,
            { role: 'user', content: `preset${B}reasoning` },
            { role: 'assistant', content: 'a$$b' },
        ];
        const result = rewriteOutgoingPrompt(
            messages,
            baseContext({
                guardEnabled: false,
                chatTailAnchor: 'last chat',
                guardMaskCotMode: GUARD_MASK_COT_MODES.ON,
                guardMaskCotCount: 3,
                slot: placedStringSlot(slotMessage),
            }),
        );

        expect(result.guardBranch).toBe('unmask');
        expect(messages[1].content).toBe('MEMORY slot');
        expect(messages[2].content).toBe('preset reasoning');
        expect(messages[3].content).toBe('a b');
    });

    it('disabled extension mutates nothing', () => {
        const messages = [{ role: 'user', content: 'hello  world' }];
        const before = JSON.stringify(messages);
        const result = rewriteOutgoingPrompt(messages, baseContext({ enabled: false }));

        expect(JSON.stringify(messages)).toBe(before);
        expect(result).toMatchObject({ rewrittenCount: 0, guardBranch: 'none' });
    });
});

describe('outgoing rewrite role mask', () => {
    it('marker-first inserts a user compatibility marker and rewrites users', () => {
        const messages = [
            { role: 'user', content: 'a' },
            { role: 'assistant', content: 'b' },
            { role: 'user', content: 'c' },
        ];
        const result = rewriteOutgoingPrompt(
            messages,
            baseContext({
                maskUserRoleAsAssistant: true,
                maskUserRoleMode: MASK_USER_ROLE_MODES.MARKER_FIRST,
                guardEnabled: false,
            }),
        );

        expect(result.rewrittenCount).toBe(2);
        expect(messages).toHaveLength(4);
        expect(messages[0].role).toBe('user');
        expect(messages[0].content).toMatch(/compatibility marker/);
        expect(messages[1].role).toBe('assistant');
        expect(messages[3].role).toBe('assistant');
    });

    it('keep-last-user preserves the final user message', () => {
        const messages = [
            { role: 'user', content: 'a' },
            { role: 'user', content: 'c' },
        ];
        const result = rewriteOutgoingPrompt(
            messages,
            baseContext({
                maskUserRoleAsAssistant: true,
                maskUserRoleMode: MASK_USER_ROLE_MODES.KEEP_LAST_USER,
                guardEnabled: false,
            }),
        );

        expect(result.rewrittenCount).toBe(1);
        expect(messages.find((m) => m.content === 'c').role).toBe('user');
        expect(messages.find((m) => m.content === 'a').role).toBe('assistant');
    });
});

describe('outgoing rewrite preset CoT', () => {
    it('exempts trailing user presets after the frozen anchor and masks chat', () => {
        const messages = [
            { role: 'system', content: 'preset system' },
            { role: 'user', content: 'I open the door.' },
            { role: 'user', content: 'Think step by step.' },
            { role: 'user', content: 'Second reasoning.' },
            { role: 'user', content: 'Third reasoning block.' },
        ];
        rewriteOutgoingPrompt(
            messages,
            baseContext({ chatTailAnchor: 'I open the door.', guardMaskCotMode: 'auto' }),
        );

        expect(messages[2].content).toBe('Think step by step.');
        expect(messages[3].content).toBe('Second reasoning.');
        expect(messages[4].content).toBe(`Third${B}reasoning${B}block.`);
        expect(messages[1].content).toBe(`I${B}open${B}the${B}door.`);
    });

    it('anchor miss masks every trailing preset', () => {
        const messages = [
            { role: 'user', content: 'Earlier chat line.' },
            { role: 'user', content: 'Think step by step.' },
        ];
        rewriteOutgoingPrompt(
            messages,
            baseContext({
                chatTailAnchor: 'missing anchor',
                guardMaskCotMode: GUARD_MASK_COT_MODES.ON,
                guardMaskCotCount: 3,
            }),
        );

        expect(messages[1].content).toBe(`Think${B}step${B}by${B}step.`);
    });
});

describe('outgoing rewrite memory slot', () => {
    it('leaves the placed string slot alone and masks identical text outside it', () => {
        const slotMessage = { role: 'user', content: 'MEMORY <preserved>exact bytes</preserved>' };
        const twin = { role: 'user', content: 'MEMORY <preserved>exact bytes</preserved>' };
        const messages = [{ role: 'user', content: 'hello  world' }, slotMessage, twin];
        const result = rewriteOutgoingPrompt(
            messages,
            baseContext({ slot: placedStringSlot(slotMessage) }),
        );

        expect(messages[0].content).toBe(`hello${B}world`);
        expect(messages[1].content).toBe('MEMORY <preserved>exact bytes</preserved>');
        expect(twin.content).toBe(`MEMORY${B}<preserved>exact${B}bytes</preserved>`);
        expect(result).toMatchObject({ slotStatus: 'skipped', staleReason: null });
    });

    it('leaves the placed multipart slot alone and keeps image parts opaque', () => {
        const slotMessage = {
            role: 'user',
            content: [
                { type: 'text', text: 'MEMORY  body' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            ],
        };
        const twin = {
            role: 'user',
            content: [
                { type: 'text', text: 'MEMORY  body' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            ],
        };
        const messages = [slotMessage, twin];
        const result = rewriteOutgoingPrompt(
            messages,
            baseContext({ slot: placedMultipartSlot(slotMessage) }),
        );

        expect(slotMessage.content).toEqual([
            { type: 'text', text: 'MEMORY  body' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ]);
        expect(twin.content[0].text).toBe(`MEMORY${B}body`);
        expect(twin.content[1]).toEqual({
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,AAAA' },
        });
        expect(result.slotStatus).toBe('skipped');
    });

    it('masks the slot normally when guardMaskMemory is on', () => {
        const slotMessage = { role: 'user', content: 'MEMORY  body' };
        const messages = [slotMessage];
        const result = rewriteOutgoingPrompt(
            messages,
            baseContext({ guardMaskMemory: true, slot: placedStringSlot(slotMessage) }),
        );

        expect(slotMessage.content).toBe(`MEMORY${B}body`);
        expect(result).toMatchObject({ slotStatus: 'masked', staleReason: null });
    });

    it('over-masks a stale slot and reports stale identity', () => {
        const slotMessage = { role: 'user', content: 'MEMORY original' };
        const context = baseContext({ slot: placedStringSlot(slotMessage) });
        slotMessage.content = 'MEMORY changed after capture';
        const messages = [{ role: 'user', content: 'hello  world' }, slotMessage];
        const result = rewriteOutgoingPrompt(messages, context);

        expect(slotMessage.content).toBe(`MEMORY${B}changed${B}after${B}capture`);
        expect(result.slotStatus).toBe('stale');
        expect(result.staleReason).not.toBeNull();
    });

    it('never skips by string equality when the reference is absent', () => {
        const ghost = { role: 'user', content: 'MEMORY  body' };
        const messages = [{ role: 'user', content: 'MEMORY  body' }];
        const result = rewriteOutgoingPrompt(
            messages,
            baseContext({
                slot: {
                    state: 'placed',
                    message: ghost,
                    expectedText: ghost.content,
                    expectedParts: null,
                },
            }),
        );

        expect(messages[0].content).toBe(`MEMORY${B}body`);
        expect(result.slotStatus).toBe('stale');
        expect(result.staleReason).not.toBeNull();
    });

    it('reports unresolved slot identity without skipping', () => {
        const messages = [{ role: 'user', content: 'hello  world' }];
        const result = rewriteOutgoingPrompt(
            messages,
            baseContext({
                slot: {
                    state: 'unresolved',
                    message: null,
                    expectedText: null,
                    expectedParts: null,
                },
            }),
        );

        expect(messages[0].content).toBe(`hello${B}world`);
        expect(result.slotStatus).toBe('unresolved');
        expect(result.staleReason).not.toBeNull();
    });
});

describe('outgoing rewrite order', () => {
    it('scrubs only pre-existing assistant content before the role rewrite', () => {
        const messages = [
            { role: 'assistant', content: 'те史НЕ' },
            { role: 'user', content: 'те史НЕ' },
        ];
        const result = rewriteOutgoingPrompt(
            messages,
            baseContext({
                stripChineseIdeographs: true,
                maskUserRoleAsAssistant: true,
                maskUserRoleMode: MASK_USER_ROLE_MODES.REWRITE_ALL,
                guardEnabled: false,
            }),
        );

        expect(result.rewrittenCount).toBe(1);
        expect(messages[0].content).toBe('те НЕ');
        expect(messages[1].content).toBe('те史НЕ');
        expect(messages[1].role).toBe('assistant');
    });
});
