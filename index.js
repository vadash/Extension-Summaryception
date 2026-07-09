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
import { getContext } from './src/foundation/context.js';
import { getSettings } from './src/foundation/state.js';
import { setInjectionUpdater, setUiUpdater } from './src/core/summarizer.js';
import { setUiRefresher } from './src/features/persist.js';
import { updateUI } from './src/entry/ui.js';
import { bindUIEvents } from './src/entry/ui-events.js';
import { initConnectionUI } from './src/entry/ui-connection.js';
import { initSettingsHelp } from './src/entry/settings-help.js';
import { initSettingsTabs } from './src/entry/ui-tabs.js';
import {
    registerSummaryceptionMemoryMacro,
    reassertInjectionSnapshot,
    updateInjection,
} from './src/features/injection.js';
import {
    bindPromptFreezeRecoveryEvents,
    onChatChanged,
    onAppReady,
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
    setUiUpdater(updateUI);
    setInjectionUpdater(updateInjection, reassertInjectionSnapshot);
    setUiRefresher(updateUI);

    const html = await renderExtensionTemplateAsync(
        'third-party/Extension-Summaryception',
        'settings',
        {},
    );
    $('#extensions_settings2').append(html);

    initSettingsHelp();
    bindUIEvents();
    bindPromptFreezeRecoveryEvents();
    initSettingsTabs();
    initConnectionUI();
    await registerSummaryceptionMemoryMacro();

    eventSource.on(eventTypes.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(eventTypes.CHAT_CHANGED, onChatChanged);
    eventSource.on(eventTypes.GENERATION_STARTED, onGenerationStarted);
    if (eventTypes.GENERATE_AFTER_DATA) {
        eventSource.on(eventTypes.GENERATE_AFTER_DATA, onGenerateAfterData);
    }
    if (eventTypes.GENERATION_ENDED) {
        eventSource.on(eventTypes.GENERATION_ENDED, onGenerationEnded);
    }
    if (eventTypes.GENERATION_STOPPED) {
        eventSource.on(eventTypes.GENERATION_STOPPED, onGenerationEnded);
    }

    registerSlashCommands();

    eventSource.on(eventTypes.APP_READY, async () => {
        await onAppReady();
        console.log(LOG_PREFIX, 'loaded. Connection Settings available');
    });
})();
