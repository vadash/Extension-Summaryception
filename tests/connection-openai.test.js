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
    it('assembles content across SSE chunk variants and stops at DONE', async () => {
        const encoder = new TextEncoder();
        const response = makeStreamResponse([
            { value: sseEvent('Hello') },
            {
                value: encoder.encode(
                    'data: {"choices":[{"delta":{"role":"assistant"}}]}\n' +
                        'data: {"choices":[{"delta":{"content":" world"}}]}\n' +
                        'data: {not json}\n' +
                        'data: {"choices":[{"delta":{"content":42}}]}\n' +
                        'data: {"choices":[{"delta":{"content":"first"}}]}\n' +
                        'data: {"choices":[{"delta":{"content":"second"}}]}\n',
                ),
            },
            {
                value: encoder.encode(
                    'event: ping\n' +
                        'data: {"choices":[{"delta":{"content":"kept"}}]}\n' +
                        'data: [DONE]',
                ),
            },
        ]);
        stubFetch(response);

        const result = await sendTestRequest();

        expect(result).toBe('Hello worldfirstsecondkept');

        stubFetch(
            makeStreamResponse([
                { value: sseEvent('alpha') },
                { value: encoder.encode('data: [DONE]\n') },
                { value: sseEvent('beta') },
            ]),
        );
        await expect(sendTestRequest()).resolves.toBe('alpha');
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

    it('throws a retryable ConnectionError for partial disconnects or missing DONE', async () => {
        const disconnectCases = [
            'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.',
            'hi',
        ];

        for (const content of disconnectCases) {
            await expectRetryableStreamFailure(
                makeFailingStreamResponse(
                    [{ value: sseEvent(content) }],
                    1,
                    new TypeError('network error'),
                ),
            );
        }

        await expectRetryableStreamFailure(
            makeStreamResponse([{ value: sseEvent('incomplete summary') }]),
        );
    });

    it('rethrows AbortError so the caller classifies it as a user abort', async () => {
        const abortError = new DOMException('Aborted', 'AbortError');
        const response = makeFailingStreamResponse([], 0, abortError);
        stubFetch(response);

        await expect(sendTestRequest()).rejects.toThrow(/Aborted/);
    });
});
