import { beforeEach, describe, expect, it, vi } from 'vitest';

// fetch is a Web API not present in the Node test runtime; provide a stub
// global before the module under test evaluates.
vi.stubGlobal('fetch', vi.fn());

const { sendViaOpenAI } = await import('../src/core/connection-openai.js');

beforeEach(() => {
    vi.clearAllMocks();
});

/**
 * Build a Response whose body is a ReadableStream emitting the given byte
 * chunks with the given delays between them.
 * @param {Array<{ value: Uint8Array, delay?: number }>} chunks
 * @returns {Response}
 */
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

/**
 * Build a Response whose body is a ReadableStream that fails on the Nth
 * read attempt. Prior reads succeed with the supplied chunks.
 * @param {Array<{ value: Uint8Array }>} chunks - chunks to emit before failing
 * @param {number} failAfter - number of successful reads before rejection
 * @param {Error} error - the error to reject with
 * @returns {Response}
 */
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

/**
 * @param {string} content
 * @returns {Uint8Array}
 */
function sseEvent(content) {
    return new TextEncoder().encode(`data: {"choices":[{"delta":{"content":"${content}"}}]}\n`);
}

/**
 * @param {boolean} [trailingNewline]
 * @returns {Uint8Array}
 */
function sseDone(trailingNewline = true) {
    return new TextEncoder().encode(`data: [DONE]${trailingNewline ? '\n' : ''}`);
}

/**
 * Point the global fetch stub at a fixed response.
 * @param {Response} response
 */
function stubFetch(response) {
    /** @type {any} */ (globalThis.fetch).mockResolvedValue(response);
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

        const result = await sendViaOpenAI({
            url: 'https://api.example.com',
            apiKey: 'sk-test',
            model: 'gpt-test',
            systemPrompt: 'sys',
            userPrompt: 'usr',
        });

        expect(result).toBe('Hello world!');
    });

    it('accepts a final DONE marker without a trailing newline', async () => {
        const response = makeStreamResponse([
            { value: sseEvent('first') },
            { value: sseEvent('second') },
            { value: sseDone(false) },
        ]);
        stubFetch(response);

        const result = await sendViaOpenAI({
            url: 'https://api.example.com',
            apiKey: 'sk-test',
            model: 'gpt-test',
            systemPrompt: 'sys',
            userPrompt: 'usr',
        });

        expect(result).toBe('firstsecond');
    });

    it('throws a retryable ConnectionError when a mid-stream disconnect yields long partial content', async () => {
        const longContent =
            'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.';
        const response = makeFailingStreamResponse(
            [{ value: sseEvent(longContent) }],
            1,
            new TypeError('network error'),
        );
        stubFetch(response);

        await expect(
            sendViaOpenAI({
                url: 'https://api.example.com',
                apiKey: 'sk-test',
                model: 'gpt-test',
                systemPrompt: 'sys',
                userPrompt: 'usr',
            }),
        ).rejects.toMatchObject({
            name: 'ConnectionError',
            retryable: true,
        });
    });

    it('throws a retryable ConnectionError when a mid-stream disconnect yields < 64 chars', async () => {
        const response = makeFailingStreamResponse(
            [{ value: sseEvent('hi') }],
            1,
            new TypeError('network error'),
        );
        stubFetch(response);

        await expect(
            sendViaOpenAI({
                url: 'https://api.example.com',
                apiKey: 'sk-test',
                model: 'gpt-test',
                systemPrompt: 'sys',
                userPrompt: 'usr',
            }),
        ).rejects.toMatchObject({
            name: 'ConnectionError',
            retryable: true,
        });
    });

    it('throws a retryable ConnectionError when the stream ends without DONE', async () => {
        const response = makeStreamResponse([{ value: sseEvent('incomplete summary') }]);
        stubFetch(response);

        await expect(
            sendViaOpenAI({
                url: 'https://api.example.com',
                apiKey: 'sk-test',
                model: 'gpt-test',
                systemPrompt: 'sys',
                userPrompt: 'usr',
            }),
        ).rejects.toMatchObject({
            name: 'ConnectionError',
            retryable: true,
        });
    });

    it('rethrows AbortError so the caller classifies it as a user abort', async () => {
        const abortError = new DOMException('Aborted', 'AbortError');
        const response = makeFailingStreamResponse([], 0, abortError);
        stubFetch(response);

        await expect(
            sendViaOpenAI({
                url: 'https://api.example.com',
                apiKey: 'sk-test',
                model: 'gpt-test',
                systemPrompt: 'sys',
                userPrompt: 'usr',
            }),
        ).rejects.toThrow(/Aborted/);
    });

    it('ignores the [DONE] sentinel and returns only delta content', async () => {
        const encoder = new TextEncoder();
        const response = makeStreamResponse([
            { value: sseEvent('alpha') },
            { value: encoder.encode('data: [DONE]\n') },
            { value: sseEvent('beta') },
        ]);
        stubFetch(response);

        const result = await sendViaOpenAI({
            url: 'https://api.example.com',
            apiKey: 'sk-test',
            model: 'gpt-test',
            systemPrompt: 'sys',
            userPrompt: 'usr',
        });

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

        const result = await sendViaOpenAI({
            url: 'https://api.example.com',
            apiKey: 'sk-test',
            model: 'gpt-test',
            systemPrompt: 'sys',
            userPrompt: 'usr',
        });

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

        const result = await sendViaOpenAI({
            url: 'https://api.example.com',
            apiKey: 'sk-test',
            model: 'gpt-test',
            systemPrompt: 'sys',
            userPrompt: 'usr',
        });

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

        const result = await sendViaOpenAI({
            url: 'https://api.example.com',
            apiKey: 'sk-test',
            model: 'gpt-test',
            systemPrompt: 'sys',
            userPrompt: 'usr',
        });

        expect(result).toBe('kept');
    });
});
