import { describe, expect, it } from 'vitest';

import { maskUserRoleAsAssistantInGenerateData } from '../src/core/assistant-role-mask.js';
import { MASK_USER_ROLE_MODES } from '../src/foundation/constants.js';

function msgs() {
    return [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
    ];
}

function onSettings(maskUserRoleMode) {
    return { enabled: true, maskUserRoleAsAssistant: true, maskUserRoleMode };
}

function roles(messages) {
    return messages.map((m) => m.role);
}

const isMarker = (message) =>
    message.role === 'user' && String(message.content).includes('compatibility marker');

describe('maskUserRoleAsAssistantInGenerateData gating', () => {
    it('returns 0 and mutates nothing when disabled', () => {
        const messages = msgs();
        const before = roles(messages);
        const rewritten = maskUserRoleAsAssistantInGenerateData(messages, {
            enabled: false,
            maskUserRoleAsAssistant: true,
        });
        expect(rewritten).toBe(0);
        expect(roles(messages)).toEqual(before);
    });

    it('returns 0 when maskUserRoleAsAssistant is false', () => {
        const messages = msgs();
        const before = roles(messages);
        const rewritten = maskUserRoleAsAssistantInGenerateData(messages, {
            enabled: true,
            maskUserRoleAsAssistant: false,
        });
        expect(rewritten).toBe(0);
        expect(roles(messages)).toEqual(before);
    });

    it.each([
        ['null', null],
        ['number', 42],
        ['object without prompt/messages', {}],
        ['array with a non-plain element', [{ role: 'user', content: 'a' }, 5]],
    ])('returns 0 for an unusable payload (%s)', (_label, payload) => {
        expect(
            maskUserRoleAsAssistantInGenerateData(
                payload,
                onSettings(MASK_USER_ROLE_MODES.MARKER_FIRST),
            ),
        ).toBe(0);
    });
});

describe('maskUserRoleAsAssistantInGenerateData payload shapes', () => {
    it.each([
        ['a bare message array', (messages) => messages],
        ['generateData.prompt', (messages) => ({ prompt: messages })],
        ['generateData.messages', (messages) => ({ messages })],
    ])('rewrites user messages in %s', (_label, buildPayload) => {
        const messages = msgs();
        const rewritten = maskUserRoleAsAssistantInGenerateData(
            buildPayload(messages),
            onSettings(MASK_USER_ROLE_MODES.MARKER_FIRST),
        );
        expect(rewritten).toBe(2);
        expect(messages.filter((m) => m.content === 'a' || m.content === 'c')).toEqual([
            { role: 'assistant', content: 'a' },
            { role: 'assistant', content: 'c' },
        ]);
    });

    it('preserves reasoning fields while rewriting roles', () => {
        const messages = [
            {
                role: 'user',
                content: 'a',
                reasoning: 'saved reasoning',
                reasoning_content: 'provider reasoning',
            },
        ];

        expect(
            maskUserRoleAsAssistantInGenerateData(
                { messages },
                onSettings(MASK_USER_ROLE_MODES.REWRITE_ALL),
            ),
        ).toBe(1);
        expect(messages[0]).toEqual({
            role: 'assistant',
            content: 'a',
            reasoning: 'saved reasoning',
            reasoning_content: 'provider reasoning',
        });
    });
});

describe('maskUserRoleAsAssistantInGenerateData modes', () => {
    it('MARKER_FIRST prepends a synthetic marker and rewrites both users', () => {
        const messages = msgs();
        const rewritten = maskUserRoleAsAssistantInGenerateData(
            messages,
            onSettings(MASK_USER_ROLE_MODES.MARKER_FIRST),
        );
        expect(rewritten).toBe(2);
        expect(messages).toHaveLength(4);
        expect(isMarker(messages[0])).toBe(true);
    });

    it('MARKER_LAST appends a synthetic marker and rewrites both users', () => {
        const messages = msgs();
        const rewritten = maskUserRoleAsAssistantInGenerateData(
            messages,
            onSettings(MASK_USER_ROLE_MODES.MARKER_LAST),
        );
        expect(rewritten).toBe(2);
        expect(messages).toHaveLength(4);
        expect(isMarker(messages[messages.length - 1])).toBe(true);
    });

    it('KEEP_LAST_USER preserves the last user and rewrites the rest', () => {
        const messages = msgs();
        const rewritten = maskUserRoleAsAssistantInGenerateData(
            messages,
            onSettings(MASK_USER_ROLE_MODES.KEEP_LAST_USER),
        );
        expect(rewritten).toBe(1);
        expect(messages).toHaveLength(3);
        expect(messages.find((m) => m.content === 'c').role).toBe('user');
        expect(messages.find((m) => m.content === 'a').role).toBe('assistant');
        expect(messages.some(isMarker)).toBe(false);
    });

    it('REWRITE_ALL rewrites every user and adds no marker', () => {
        const messages = msgs();
        const rewritten = maskUserRoleAsAssistantInGenerateData(
            messages,
            onSettings(MASK_USER_ROLE_MODES.REWRITE_ALL),
        );
        expect(rewritten).toBe(2);
        expect(messages).toHaveLength(3);
        expect(messages.some((m) => m.role === 'user')).toBe(false);
        expect(messages.some(isMarker)).toBe(false);
    });

    it('falls back to MARKER_FIRST for an unrecognized mode', () => {
        const messages = msgs();
        const rewritten = maskUserRoleAsAssistantInGenerateData(messages, onSettings('bogus'));
        expect(rewritten).toBe(2);
        expect(messages).toHaveLength(4);
        expect(isMarker(messages[0])).toBe(true);
    });
});

function scrubSettings(overrides = {}) {
    return {
        enabled: true,
        maskUserRoleAsAssistant: false,
        stripChineseIdeographs: true,
        ...overrides,
    };
}

describe('maskUserRoleAsAssistantInGenerateData CN scrub', () => {
    it('leaves assistant content byte-identical when stripChineseIdeographs is off', () => {
        const content = 'те史НЕ слово — слово';
        const messages = [{ role: 'assistant', content }];

        maskUserRoleAsAssistantInGenerateData(
            { messages },
            scrubSettings({ stripChineseIdeographs: false }),
        );

        expect(messages[0].content).toBe(content);
    });

    it('replaces Han ideographs with a separator in assistant string content', () => {
        const messages = [{ role: 'assistant', content: 'те史НЕ' }];

        maskUserRoleAsAssistantInGenerateData({ messages }, scrubSettings());

        expect(messages[0].content).toBe('те НЕ');
    });

    it('folds em and horizontal bar dashes to a single space in assistant content', () => {
        const messages = [{ role: 'assistant', content: 'слово — слово―слово' }];

        maskUserRoleAsAssistantInGenerateData({ messages }, scrubSettings());

        expect(messages[0].content).toBe('слово слово слово');
    });

    it('scrubs text parts in multipart content and leaves image parts untouched', () => {
        const imagePart = { type: 'image_url', image_url: { url: 'https://example.test/史.png' } };
        const messages = [
            {
                role: 'assistant',
                content: [
                    { type: 'text', text: 'те史НЕ — текст' },
                    imagePart,
                    { text: 'слово―слово' },
                ],
            },
        ];

        maskUserRoleAsAssistantInGenerateData({ messages }, scrubSettings());

        expect(messages[0].content).toEqual([
            { type: 'text', text: 'те НЕ текст' },
            imagePart,
            { text: 'слово слово' },
        ]);
    });

    it('leaves user-role content untouched', () => {
        const messages = [{ role: 'user', content: 'те史НЕ слово — слово' }];

        maskUserRoleAsAssistantInGenerateData({ messages }, scrubSettings());

        expect(messages[0].content).toBe('те史НЕ слово — слово');
    });

    it('does not touch the stored chat source when scrubbing the payload', () => {
        const chat = [{ role: 'assistant', mes: 'те史НЕ' }];
        const payload = {
            messages: [{ role: 'assistant', content: chat[0].mes }],
        };

        maskUserRoleAsAssistantInGenerateData(payload, scrubSettings());

        expect(payload.messages[0].content).toBe('те НЕ');
        expect(chat).toEqual([{ role: 'assistant', mes: 'те史НЕ' }]);
    });
});

describe('maskUserRoleAsAssistantInGenerateData zero-user edge', () => {
    it('inserts no marker and rewrites nothing when there are no users', () => {
        const messages = [{ role: 'assistant', content: 'x' }];
        const before = roles(messages);
        const rewritten = maskUserRoleAsAssistantInGenerateData(
            messages,
            onSettings(MASK_USER_ROLE_MODES.MARKER_FIRST),
        );
        expect(rewritten).toBe(0);
        expect(messages).toHaveLength(1);
        expect(roles(messages)).toEqual(before);
    });
});
