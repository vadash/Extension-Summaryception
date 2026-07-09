import { debug, trace } from '../foundation/logger.js';
import { getEffectiveSettings } from '../foundation/state.js';
import { RequestRunner } from './request-runner.js';
import { buildSummarizerPipelineInput, traceSummarizerInputTokens } from './summarizer-pipeline.js';

let currentAbortController = null;
const requestRunner = new RequestRunner();

/**
 * Check whether an abort controller is active.
 * @returns {boolean}
 */
export function hasActiveAbortController() {
    return Boolean(currentAbortController);
}

/**
 * Abort the in-flight summarizer request.
 * @returns {void}
 */
export function abortCurrentSummarizerRequest() {
    if (currentAbortController) {
        currentAbortController.abort();
        debug('Abort signal sent.');
    }
}

/**
 * Call the configured summarizer backend with retry logic.
 * @param {string} storyTxt - The story text to summarize
 * @param {string} contextStr - The accumulated context string
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} [metadata] - Call metadata for debug usage logs
 * @returns {Promise<string>} The generated summary, or '' on failure/abort
 */
export async function callSummarizer(storyTxt, contextStr, metadata = {}) {
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

    currentAbortController = new AbortController();

    try {
        return await requestRunner.run({
            ...request,
            signal: currentAbortController.signal,
        });
    } finally {
        currentAbortController = null;
    }
}
