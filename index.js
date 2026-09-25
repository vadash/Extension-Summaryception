/**
 * Summaryception - Layered Recursive Summarization for SillyTavern
 *
 * NON-DESTRUCTIVE: Uses SillyTavern's native /hide and /unhide commands
 * to exclude summarized messages from LLM context while keeping them
 * fully visible and readable in the chat UI.
 *
 * AGPL-3.0
 */

import { LOG_PREFIX } from './src/foundation/constants.js';
import { getChat, getContext } from './src/foundation/context.js';
import { saveChatStore } from './src/foundation/chat-store.js';
import { initRefreshPort, refreshPreview, refreshUi } from './src/foundation/refresh.js';
import { getSettings } from './src/foundation/settings.js';
import { initSnippetBrowser } from './src/entry/ui-snippets.js';
import { createSummarizerQueue } from './src/core/summarizer-queue.js';
import { callSummarizer } from './src/core/summarizer-request.js';
import { createContinuityAuditor } from './src/core/continuity-audit.js';
import { createForegroundGate } from './src/core/foreground-gate.js';
import { withUsageRun } from './src/core/summarizer-usage.js';
import { createToastrNotifyAdapter } from './src/entry/ui-dialogs.js';
import { syncLLMContextPreview, updateUI } from './src/entry/ui.js';
import { bindUIEvents } from './src/entry/ui-events.js';
import { initConnectionUI } from './src/entry/ui-connection.js';
import { initSettingsHelp } from './src/entry/settings-help.js';
import { initSettingsTabs } from './src/entry/ui-tabs.js';
import {
    registerSummaryceptionMemoryMacro,
    reassertInjectionSnapshot,
    updateInjection,
} from './src/features/injection.js';
import { updateContinuityInjection } from './src/features/continuity-injection.js';
import { updateContinuityMarker } from './src/entry/continuity-marker.js';
import {
    bindPromptFreezeRecoveryEvents,
    onAppReady,
    onChatChanged,
    onChatCompletionPromptReady,
    onGenerateAfterData,
    onGenerationEnded,
    onGenerationStarted,
    onMessageReceived,
} from './src/entry/events.js';
import { registerSlashCommands } from './src/entry/commands.js';

(async function init() {
    const ctx = getContext();
    const { eventSource, event_types: eventTypes, renderExtensionTemplateAsync } = ctx;
    if (!eventSource || !eventTypes || typeof renderExtensionTemplateAsync !== 'function') {
        throw new Error('Summaryception requires SillyTavern extension rendering and event APIs.');
    }

    getSettings();
    // The gate's requeue reads the queue lazily; the queue is built next.
    const gate = createForegroundGate({
        reassertInjection: reassertInjectionSnapshot,
        requeue: () => {
            void queue.request();
        },
    });
    const notify = createToastrNotifyAdapter();
    const queue = createSummarizerQueue({ gate, notify });
    const manualRunnerDeps = { queue, refreshUi, withUsageRun, gate };
    const continuityAuditor = createContinuityAuditor({
        dispatch: callSummarizer,
        saveChatStore,
        refreshPreview,
        getChat,
    });
    initRefreshPort({
        // Every prompt-affecting effect enters through the Foreground Gate
        // (ADR-0016); mid-generation requests queue until the freeze lifts.
        updateInjection: (options) => {
            void gate.runEffect({
                kind: 'injection-refresh',
                apply: () => {
                    updateInjection(options);
                    return true;
                },
            });
        },
        updateContinuityInjection: () => {
            void gate.runEffect({
                kind: 'continuity-refresh',
                apply: () => {
                    updateContinuityInjection();
                    return true;
                },
            });
        },
        updateContinuityMarker,
        updateUI: (options) => updateUI({ ...options, queue }),
        updatePreview: syncLLMContextPreview,
    });
    initSnippetBrowser(notify, gate, queue);

    const html = await renderExtensionTemplateAsync(
        'third-party/Extension-Summaryception',
        'settings',
        {},
    );
    $('#extensions_settings2').append(html);

    initSettingsHelp();
    bindUIEvents({ notify, gate, queue, manualRunnerDeps });
    bindPromptFreezeRecoveryEvents({ gate });
    initSettingsTabs();
    initConnectionUI();
    await registerSummaryceptionMemoryMacro();

    eventSource.on(eventTypes.MESSAGE_RECEIVED, (messageIndex, type) =>
        onMessageReceived(/** @type {number} */ (messageIndex), {
            notify,
            type,
            auditor: continuityAuditor,
            queue,
        }),
    );
    eventSource.on(eventTypes.CHAT_CHANGED, () => onChatChanged({ gate, queue }));
    eventSource.on(eventTypes.GENERATION_STARTED, (...args) =>
        onGenerationStarted(args, { gate, queue }),
    );
    if (eventTypes.GENERATE_AFTER_DATA) {
        eventSource.on(eventTypes.GENERATE_AFTER_DATA, onGenerateAfterData);
    }
    if (eventTypes.GENERATION_ENDED) {
        eventSource.on(eventTypes.GENERATION_ENDED, () => onGenerationEnded({ gate, queue }));
    }
    if (eventTypes.GENERATION_STOPPED) {
        eventSource.on(eventTypes.GENERATION_STOPPED, () => onGenerationEnded({ gate, queue }));
    }
    if (eventTypes.CHAT_COMPLETION_PROMPT_READY) {
        eventSource.on(eventTypes.CHAT_COMPLETION_PROMPT_READY, onChatCompletionPromptReady);
    }
    registerSlashCommands();

    eventSource.on(eventTypes.APP_READY, async () => {
        await onAppReady({ gate, queue });
        console.log(LOG_PREFIX, 'loaded. Connection Settings available');
    });
})();
