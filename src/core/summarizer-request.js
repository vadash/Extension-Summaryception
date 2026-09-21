import { debug, trace } from '../foundation/logger.js';
import { getEffectiveSettings } from '../foundation/settings.js';
import { silentAdapter } from './notify.js';
import { RequestRunner } from './request-runner.js';
import { buildSummarizerPipelineInput, traceSummarizerInputTokens } from './summarizer-pipeline.js';

/** Live summarizer requests; each callSummarizer owns one entry for its duration. @type {Set<AbortController>} */
const liveRequests = new Set();

const requestRunner = new RequestRunner();

/**
 * @returns {boolean}
 */
export function isRequestLive() {
    return liveRequests.size > 0;
}

/**
 * @returns {void}
 */
export function abortAllRequests() {
    if (liveRequests.size === 0) {
        return;
    }
    for (const controller of liveRequests) {
        controller.abort();
    }
    debug('Abort signal sent.');
}

/**
 * @param {object} request
 * @param {string} request.storyTxt - Story text to summarize
 * @param {string} request.contextStr - Continuity context text
 * @param {import('./call-profile.js').SummarizerCallMetadata} [request.metadata] - Resolver input: call category plus provenance
 * @param {import('./notify.js').NotifyAdapter} [request.notify] - Notify adapter for mid-run notices; defaults to the silent adapter
 * @param {AbortSignal} [request.signal] - Optional external abort signal; aborting it aborts this request
 * @returns {Promise<import('./run-outcome.js').RunOutcome>} `completed` carries the summary text and the resolved profile
 */
export async function callSummarizer({
    storyTxt,
    contextStr,
    metadata = {},
    notify = silentAdapter,
    signal = undefined,
}) {
    trace('>>> ENTERING callSummarizer');
    await traceSummarizerInputTokens(storyTxt, contextStr);

    const settings = getEffectiveSettings();
    trace('  settings loaded:', {
        connectionSource: settings.connectionSource,
        enabled: settings.enabled,
    });

    const request = await buildSummarizerPipelineInput({
        storyTxt,
        contextStr,
        metadata,
        settings,
    });

    const controller = new AbortController();
    liveRequests.add(controller);
    const onExternalAbort = () => controller.abort();
    signal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
        return await requestRunner.run({
            ...request,
            signal: controller.signal,
            notify,
        });
    } finally {
        signal?.removeEventListener('abort', onExternalAbort);
        liveRequests.delete(controller);
    }
}
