import { getPromptManager } from '../foundation/context.js';
import { getSettings } from '../foundation/state.js';
import { log } from '../foundation/logger.js';

// ─── Prompt Toggle Management ────────────────────────────────────────

/**
 * Capture current prompt toggle states from ST's prompt manager.
 * @returns {Map<string, boolean>} Map of prompt identifier to enabled state
 */
export function snapshotPromptToggles() {
    const snapshot = new Map();
    try {
        const promptManager = getPromptManager();
        if (!promptManager) {
            log('No prompt manager available, skipping toggle snapshot.');
            return snapshot;
        }
        const collection = promptManager.getPromptCollection();
        if (!collection?.collection) {
            return snapshot;
        }
        const orderList = promptManager.getPromptOrderEntries();
        if (!orderList) {
            return snapshot;
        }
        for (const entry of collection.collection) {
            for (const orderEntry of orderList) {
                if (orderEntry.identifier === entry.identifier) {
                    snapshot.set(entry.identifier, orderEntry.enabled);
                }
            }
        }
        log(`Snapshot captured: ${snapshot.size} prompt toggles`);
    } catch (e) {
        log('Error capturing snapshot:', e);
    }
    return snapshot;
}

/**
 *
 */
export function disableAllPromptToggles() {
    try {
        const promptManager = getPromptManager();
        if (!promptManager) {
            return;
        }
        const orderList = promptManager.getPromptOrderEntries();
        if (!orderList) {
            return;
        }
        let count = 0;
        for (const entry of orderList) {
            if (entry.enabled) {
                entry.enabled = false;
                count++;
            }
        }
        log(`Disabled ${count} prompt toggles`);
    } catch (e) {
        log('Error disabling prompt toggles:', e);
    }
}

/**
 *
 */
export function restorePromptToggles(snapshot) {
    if (!snapshot || snapshot.size === 0) {
        return;
    }
    try {
        const promptManager = getPromptManager();
        if (!promptManager) {
            return;
        }
        const orderList = promptManager.getPromptOrderEntries();
        if (!orderList) {
            return;
        }
        let count = 0;
        for (const entry of orderList) {
            if (snapshot.has(entry.identifier)) {
                entry.enabled = snapshot.get(entry.identifier);
                count++;
            }
        }
        log(`Restored ${count} prompt toggles`);
    } catch (e) {
        log('Error restoring prompt toggles:', e);
    }
}

// ─── Output Cleaning ─────────────────────────────────────────────────

/**
 * Strip reasoning tags, thinking blocks, and other model artifacts
 * from the summarizer output. Uses configurable patterns plus
 * regex for common reasoning block formats.
 * @param {string} raw - The raw summarizer response
 * @returns {string} Cleaned text
 */
export function cleanSummarizerOutput(raw) {
    let text = raw;

    const s = getSettings();

    // Remove configurable strip patterns
    for (const pattern of s.stripPatterns) {
        while (text.includes(pattern)) {
            text = text.replace(pattern, '');
        }
    }

    // Remove common reasoning blocks (content between tag pairs)
    const blockPatterns = [
        /<\|channel>thought[\s\S]*?<channel\|>/gi,
        /<thinking>[\s\S]*?<\/thinking>/gi,
        /<output>([\s\S]*?)<\/output>/gi,
        /<reasoning>[\s\S]*?<\/reasoning>/gi,
        /<thought>[\s\S]*?<\/thought>/gi,
        /<reflect>[\s\S]*?<\/reflect>/gi,
        /<inner_monologue>[\s\S]*?<\/inner_monologue>/gi,
    ];

    for (const regex of blockPatterns) {
        // For <output> tags, keep the content inside
        if (regex.source.includes('output')) {
            text = text.replace(regex, '$1');
        } else {
            text = text.replace(regex, '');
        }
    }

    // Clean up leftover whitespace
    text = text.replace(/\n{3,}/g, '\n').trim();

    return text;
}
