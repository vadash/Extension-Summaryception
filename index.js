/**
 * Summaryception v6.0.0 - Layered Recursive Summarization for SillyTavern
 *
 * NON-DESTRUCTIVE: Uses SillyTavern's native /hide and /unhide commands
 * to exclude summarized messages from LLM context while keeping them
 * fully visible and readable in the chat UI.
 *
 * AGPL-3.0
 */

import { LOG_PREFIX } from './src/foundation/constants.js';
import { getSettings } from './src/foundation/state.js';
import { setInjectionUpdater, setUiUpdater } from './src/core/summarizer.js';
import { setUiRefresher } from './src/features/persist.js';
import { updateUI } from './src/entry/ui.js';
import { bindUIEvents } from './src/entry/ui-events.js';
import { initConnectionUI } from './src/entry/ui-connection.js';
import { reassertInjectionSnapshot, updateInjection } from './src/features/injection.js';
import {
    onChatChanged,
    onGenerationEnded,
    onGenerationStarted,
    onMessageReceived,
} from './src/entry/events.js';
import { registerSlashCommands } from './src/entry/commands.js';

(async function init() {
    const { eventSource, event_types, renderExtensionTemplateAsync } = SillyTavern.getContext();

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

    bindUIEvents();
    initConnectionUI();

    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    if (event_types.GENERATION_ENDED) {
        eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);
    }
    if (event_types.GENERATION_STOPPED) {
        eventSource.on(event_types.GENERATION_STOPPED, onGenerationEnded);
    }

    registerSlashCommands();

    eventSource.on(event_types.APP_READY, () => {
        updateInjection();
        updateUI();
        console.log(LOG_PREFIX, 'v6.0.0 loaded. Connection Settings available');
    });
})();
