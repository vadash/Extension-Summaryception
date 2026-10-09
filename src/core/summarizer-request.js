import { debug, trace } from '../foundation/logger.js';
import { getEffectiveSettings } from '../foundation/settings.js';
import { silentAdapter } from './notify.js';
import { RequestRunner } from './request-runner.js';
import { buildSummarizerPipelineInput, traceSummarizerInputTokens } from './summarizer-pipeline.js';

/**
 * The Summarizer Dispatch: the one owner of live summarizer requests. It runs
 * one summarizer call through the request runner and tracks every request in
 * flight, so Stop can abort them all and busy can see them. The composition
 * root builds one instance; callers receive its members, never module state.
 * @typedef {object} SummarizerDispatch
 * @property {(request: {
 *     storyTxt: string,
 *     contextStr: string,
 *     metadata?: import('./call-profile.js').SummarizerCallMetadata,
 *     notify?: import('./notify.js').NotifyAdapter,
 *     signal?: AbortSignal,
 * }) => Promise<import('./run-outcome.js').RunOutcome>} call - Runs one summarizer request.
 * @property {() => boolean} isLive - Whether any summarizer request is in flight.
 * @property {() => void} abort - Aborts every live summarizer request.
 */

/**
 * Build the one Summarizer Dispatch instance (ADR-0031). The live-request set
 * and the request runner live inside the instance, so tests and composition
 * roots can build isolated dispatches.
 * @returns {SummarizerDispatch}
 */
export function createSummarizerDispatch() {
    /** Live summarizer requests; each call owns one entry for its duration. @type {Set<AbortController>} */
    const liveRequests = new Set();

    const requestRunner = new RequestRunner();

    /**
     * @param {object} request
     * @param {string} request.storyTxt - Story text to summarize
     * @param {string} request.contextStr - Continuity context text
     * @param {import('./call-profile.js').SummarizerCallMetadata} [request.metadata] - Resolver input: call category plus provenance
     * @param {import('./notify.js').NotifyAdapter} [request.notify] - Notify adapter for mid-run notices; defaults to the silent adapter
     * @param {AbortSignal} [request.signal] - Optional external abort signal; aborting it aborts this request
     * @returns {Promise<import('./run-outcome.js').RunOutcome>} `completed` carries the summary text and the resolved profile
     */
    async function call({
        storyTxt,
        contextStr,
        metadata = {},
        notify = silentAdapter,
        signal = undefined,
    }) {
        trace('>>> ENTERING summarizer dispatch call');
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

    return {
        call,
        isLive: () => liveRequests.size > 0,
        abort: () => {
            if (liveRequests.size === 0) {
                return;
            }
            for (const controller of liveRequests) {
                controller.abort();
            }
            debug('Abort signal sent.');
        },
    };
}
