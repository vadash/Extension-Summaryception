import { beforeEach, describe, expect, it, vi } from 'vitest';

// fetch is a Web API not present in the Node test runtime; provide a stub
// global before the module under test evaluates.
vi.stubGlobal('fetch', vi.fn());

const { sendViaOpenAI } = await import('../src/core/connection-openai.js');

const BASE_REQUEST = {
    url: 'https://api.example.com',
    apiKey: 'sk-test',
    model: 'gpt-test',
    systemPrompt: 'sys',
    userPrompt: 'usr',
};

beforeEach(() => {
    vi.clearAllMocks();
});

function makeStreamResponse(chunks) {
    const stream = new ReadableStream({
        async start(controller) {
            for (const chunk of chunks) {
                if (chunk.delay) {
                    await new Promise((r) => setTimeout(r, chunk.delay));
                }
                controller.enqueue(chunk.value);
            }
            controller.close();
        },
    });
    return new Response(stream, { status: 200 });
}

function makeFailingStreamResponse(chunks, failAfter, error) {
    let readCount = 0;
    const stream = new ReadableStream({
        async pull(controller) {
            if (readCount >= failAfter) {
                throw error;
            }
            const chunk = chunks[readCount];
            readCount++;
            if (chunk) {
                controller.enqueue(chunk.value);
            } else {
                controller.close();
            }
        },
    });
    return new Response(stream, { status: 200 });
}

function sseEvent(content) {
    return new TextEncoder().encode(`data: {"choices":[{"delta":{"content":"${content}"}}]}\n`);
}

function sseDone(trailingNewline = true) {
    return new TextEncoder().encode(`data: [DONE]${trailingNewline ? '\n' : ''}`);
}

function stubFetch(response) {
    /** @type {any} */ (globalThis.fetch).mockResolvedValue(response);
}

function sendTestRequest(overrides = {}) {
    return sendViaOpenAI({ ...BASE_REQUEST, ...overrides });
}

async function expectRetryableStreamFailure(response) {
    stubFetch(response);
    await expect(sendTestRequest()).rejects.toMatchObject({
        name: 'ConnectionError',
        retryable: true,
    });
}

describe('sendViaOpenAI streaming', () => {
    it('assembles full content from newline-terminated SSE events', async () => {
        const response = makeStreamResponse([
            { value: sseEvent('Hello') },
            { value: sseEvent(' world') },
            { value: sseEvent('!') },
            { value: sseDone() },
        ]);
        stubFetch(response);

        const result = await sendTestRequest();

        expect(result).toBe('Hello world!');
    });

    it('accepts a final DONE marker without a trailing newline', async () => {
        const response = makeStreamResponse([
            { value: sseEvent('first') },
            { value: sseEvent('second') },
            { value: sseDone(false) },
        ]);
        stubFetch(response);

        const result = await sendTestRequest();

        expect(result).toBe('firstsecond');
    });

    it('passes abort signals to direct fetch requests', async () => {
        const controller = new AbortController();
        const response = makeStreamResponse([{ value: sseEvent('done') }, { value: sseDone() }]);
        stubFetch(response);

        await sendTestRequest({ signal: controller.signal });

        expect(globalThis.fetch).toHaveBeenCalledWith(
            'https://api.example.com/v1/chat/completions',
            expect.objectContaining({ signal: controller.signal }),
        );
    });

    it('passes max_tokens when configured', async () => {
        const response = makeStreamResponse([{ value: sseEvent('done') }, { value: sseDone() }]);
        stubFetch(response);

        await sendTestRequest({ maxTokens: 180 });

        const body = JSON.parse(
            /** @type {string} */ (/** @type {any} */ (globalThis.fetch).mock.calls[0][1].body),
        );
        expect(body.max_tokens).toBe(180);
    });

    it.each([
        [
            'long',
            'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.',
        ],
        ['short', 'hi'],
    ])('throws a retryable ConnectionError for %s partial disconnects', async (_label, content) => {
        const response = makeFailingStreamResponse(
            [{ value: sseEvent(content) }],
            1,
            new TypeError('network error'),
        );
        await expectRetryableStreamFailure(response);
    });

    it('throws a retryable ConnectionError when the stream ends without DONE', async () => {
        const response = makeStreamResponse([{ value: sseEvent('incomplete summary') }]);
        await expectRetryableStreamFailure(response);
    });

    it('rethrows AbortError so the caller classifies it as a user abort', async () => {
        const abortError = new DOMException('Aborted', 'AbortError');
        const response = makeFailingStreamResponse([], 0, abortError);
        stubFetch(response);

        await expect(sendTestRequest()).rejects.toThrow(/Aborted/);
    });

    it('ignores the [DONE] sentinel and returns only delta content', async () => {
        const encoder = new TextEncoder();
        const response = makeStreamResponse([
            { value: sseEvent('alpha') },
            { value: encoder.encode('data: [DONE]\n') },
            { value: sseEvent('beta') },
        ]);
        stubFetch(response);

        const result = await sendTestRequest();

        expect(result).toBe('alpha');
    });

    it('ignores role-only deltas with no content', async () => {
        const encoder = new TextEncoder();
        const response = makeStreamResponse([
            { value: encoder.encode('data: {"choices":[{"delta":{"role":"assistant"}}]}\n') },
            { value: sseEvent('content') },
            { value: sseDone() },
        ]);
        stubFetch(response);

        const result = await sendTestRequest();

        expect(result).toBe('content');
    });

    it('appends multiple SSE data lines from one chunk in order', async () => {
        const encoder = new TextEncoder();
        const response = makeStreamResponse([
            {
                value: encoder.encode(
                    'data: {"choices":[{"delta":{"content":"first"}}]}\n' +
                        'data: {"choices":[{"delta":{"content":"second"}}]}\n' +
                        'data: [DONE]\n',
                ),
            },
        ]);
        stubFetch(response);

        const result = await sendTestRequest();

        expect(result).toBe('firstsecond');
    });

    it('ignores malformed and non-content data while keeping valid content', async () => {
        const encoder = new TextEncoder();
        const response = makeStreamResponse([
            {
                value: encoder.encode(
                    'event: ping\n' +
                        'data: {not json}\n' +
                        'data: {"choices":[{"delta":{"content":42}}]}\n' +
                        'data: {"choices":[{"delta":{"role":"assistant"}}]}\n' +
                        'data: {"choices":[{"delta":{"content":"kept"}}]}\n' +
                        'data: [DONE]\n',
                ),
            },
        ]);
        stubFetch(response);

        const result = await sendTestRequest();

        expect(result).toBe('kept');
    });
});
