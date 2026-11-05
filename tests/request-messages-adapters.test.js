import { describe, expect, it, vi } from 'vitest';

import { logLlmAttemptTransaction } from '../src/core/request-attempt-log.js';
import { sendViaDefault } from '../src/core/connection-default.js';
import { sendViaProfile } from '../src/core/connection-profile.js';
import { MODULE_NAME } from '../src/foundation/constants.js';
import { installSummaryContext } from './test-helpers.js';

const SYSTEM = 'system message';
const PAYLOAD = 'payload message';
const RECALL = 'recall message\nNow write the <narrative> envelope.';

/** The host generateRaw options the default adapter built. */
function capturedGenerateRawOptions(context) {
    expect(context.generateRaw).toHaveBeenCalledOnce();
    return context.generateRaw.mock.calls[0][0];
}

/** The messages a profile sendRequest handed the host service. */
function capturedProfileMessages(sendRequest) {
    expect(sendRequest).toHaveBeenCalledOnce();
    const [profileId, messages, tokenLimit, options] = sendRequest.mock.calls[0];
    return { profileId, messages, tokenLimit, options };
}

describe('default connection adapter', () => {
    it('sends the system message and both user messages, in order', async () => {
        const generateRaw = vi.fn().mockResolvedValue('summary');
        installSummaryContext({ generateRaw });

        const result = await sendViaDefault(SYSTEM, PAYLOAD, 0, RECALL);

        const options = capturedGenerateRawOptions({ generateRaw });
        expect(result).toBe('summary');
        expect(options.systemPrompt).toBe(SYSTEM);
        expect(options.prompt).toEqual([
            { role: 'user', content: PAYLOAD },
            { role: 'user', content: RECALL },
        ]);
    });

    it('keeps two user messages when the family carries no recall block', async () => {
        const generateRaw = vi.fn().mockResolvedValue('summary');
        installSummaryContext({ generateRaw });

        await sendViaDefault(SYSTEM, PAYLOAD, 0);

        expect(capturedGenerateRawOptions({ generateRaw }).prompt).toEqual([
            { role: 'user', content: PAYLOAD },
        ]);
    });
});

describe('profile connection adapter', () => {
    it('sends the system message and both user messages, with the preset off', async () => {
        installSummaryContext();
        const sendRequest = vi.fn().mockResolvedValue('summary');
        installSummaryContext({ ConnectionManagerRequestService: { sendRequest } });

        const result = await sendViaProfile({
            profileId: 'profile-1',
            systemPrompt: SYSTEM,
            userPrompt: PAYLOAD,
            recall: RECALL,
        });

        const { profileId, messages, options } = capturedProfileMessages(sendRequest);
        expect(result).toBe('summary');
        expect(profileId).toBe('profile-1');
        expect(messages).toEqual([
            { role: 'system', content: SYSTEM },
            { role: 'user', content: PAYLOAD },
            { role: 'user', content: RECALL },
        ]);
        expect(options.includePreset).toBe(false);
        expect(options.includeInstruct).toBe(false);
    });
});

describe('attempt transaction log', () => {
    it('logs the system message and both user messages of the request', () => {
        const context = installSummaryContext();
        context.extensionSettings[MODULE_NAME].promptInputLogMode = true;

        const logged = [];
        const log = vi.spyOn(console, 'log').mockImplementation((line) => logged.push(line));
        const group = vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
        const groupEnd = vi.spyOn(console, 'groupEnd').mockImplementation(() => {});

        logLlmAttemptTransaction({
            label: 'Layer 0',
            routeLabel: 'primary',
            attempt: 0,
            status: 'completed',
            durationMs: 10,
            systemPrompt: SYSTEM,
            prompt: PAYLOAD,
            recall: RECALL,
            cleanedResult: 'summary',
            error: null,
        });

        const input = JSON.parse(logged[0]);
        expect(input.messages).toEqual([
            { role: 'system', content: SYSTEM },
            { role: 'user', content: PAYLOAD },
            { role: 'user', content: RECALL },
        ]);

        log.mockRestore();
        group.mockRestore();
        groupEnd.mockRestore();
    });
});
