import { TOAST_TITLE } from '../foundation/constants.js';
import { getChatStore } from '../foundation/state.js';
import {
    deleteSnippetAt,
    getSnippetRegenerationTarget,
    getSnippetTextAt,
    regenerateSnippetAt,
    updateSnippetTextAt,
} from '../features/snippet-manager.js';
import { showBusySummaryToast } from './ui-dialogs.js';

let uiRefresher = null;

/**
 * Register the callback used to re-render the full UI after snippet mutations.
 * Registered by index.js to avoid a circular import with ui.js.
 * @param {() => void} callback
 * @returns {void}
 */
export function initSnippetBrowser(callback) {
    uiRefresher = callback;
}

function refreshUI() {
    if (typeof uiRefresher === 'function') {
        uiRefresher();
    }
}

/**
 * @typedef {object} SnippetBrowserItem
 * @property {string} key - Stable row key for this render pass
 * @property {number} layerIndex - Source layer index
 * @property {number} snippetIndex - Source snippet index within the layer
 * @property {string} text - Snippet text
 * @property {string} meta - Compact source metadata label
 * @property {boolean} canRedo - Whether the row can be regenerated
 */

/**
 * @typedef {object} SnippetBrowserLayer
 * @property {string} key - Stable layer key for this render pass
 * @property {number} index - Source layer index
 * @property {string} label - Layer heading
 * @property {SnippetBrowserItem[]} snippets - Snippets in display order
 */

/**
 * @typedef {object} SnippetBrowserView
 * @property {boolean} empty - Whether there are no snippets to display
 * @property {SnippetBrowserLayer[]} layers - Non-empty layers, deepest first
 */

const SNIPPET_BROWSER_EVENT_NS = '.summaryceptionSnippetBrowser';

/**
 * Render the snippet browser with fine-grained DOM updates.
 * @returns {void}
 */
export function updateSnippetBrowser() {
    const store = getChatStore();
    const browser = $('#sc_snippet_browser');
    if (!browser.length) {
        return;
    }

    bindSnippetBrowserHandlers(browser);
    renderSnippetBrowser(browser, buildSnippetBrowserViewModel(store));
}

/**
 * Build a DOM-neutral view model for the snippet browser.
 * @param {ReturnType<typeof getChatStore>} store
 * @returns {SnippetBrowserView}
 */
export function buildSnippetBrowserViewModel(store) {
    const layers = [];
    const sourceLayers = Array.isArray(store.layers) ? store.layers : [];
    for (let i = sourceLayers.length - 1; i >= 0; i--) {
        const layer = sourceLayers[i];
        if (!layer || layer.length === 0) {
            continue;
        }
        const label = i === 0 ? 'Layer 0 (Turn Summaries)' : `Layer ${i} (Meta-Summary)`;
        layers.push({
            key: getSnippetLayerKey(i),
            index: i,
            label,
            snippets: layer.map((snippet, j) => buildSnippetBrowserItem(snippet, i, j)),
        });
    }
    return { empty: layers.length === 0, layers };
}

/**
 * Build the stable row key used by the snippet browser renderer.
 * @param {number} layerIndex
 * @param {number} snippetIndex
 * @returns {string}
 */
export function getSnippetBrowserRowKey(layerIndex, snippetIndex) {
    return `snippet:${layerIndex}:${snippetIndex}`;
}

function getSnippetLayerKey(layerIndex) {
    return `layer:${layerIndex}`;
}

function buildSnippetBrowserItem(snippet, layerIndex, snippetIndex) {
    return {
        key: getSnippetBrowserRowKey(layerIndex, snippetIndex),
        layerIndex,
        snippetIndex,
        text: snippet.text,
        meta: getSnippetMeta(snippet),
        canRedo: Boolean(layerIndex === 0 && snippet.sourceMessageIds?.length),
    };
}

function getSnippetMeta(snippet) {
    const sourceCount = snippet.sourceMessageIds?.length || 0;
    const rangeStr = sourceCount
        ? `${sourceCount} source messages`
        : snippet.mergedCount
          ? `merged ${snippet.mergedCount} from L${snippet.fromLayer}`
          : '';
    const seedStr = snippet.promoted ? ' promoted' : '';
    return `${rangeStr}${seedStr}`;
}

function bindSnippetBrowserHandlers(browser) {
    if (browser.data('scSnippetBrowserHandlersBound')) {
        return;
    }

    browser.data('scSnippetBrowserHandlersBound', true);
    browser
        .on(`click${SNIPPET_BROWSER_EVENT_NS}`, '.sc-snippet-text', onSnippetTextClick)
        .on(`click${SNIPPET_BROWSER_EVENT_NS}`, '.sc-snippet-redo', onSnippetRedoClick)
        .on(`click${SNIPPET_BROWSER_EVENT_NS}`, '.sc-snippet-delete', onSnippetDeleteClick);
}

function renderSnippetBrowser(browser, view) {
    const previousScrollTop = browser.scrollTop();

    if (view.empty) {
        renderEmptySnippetBrowser(browser);
        browser.scrollTop(previousScrollTop);
        return;
    }

    browser.children('.sc-muted').remove();
    removeMissingChildElements(
        browser,
        '.sc-browser-layer',
        new Set(view.layers.map((layer) => layer.key)),
    );

    let cursor = null;
    for (const layer of view.layers) {
        const layerEl = getOrCreateChildElement(browser, 'sc-browser-layer', layer.key);
        updateLayerElement(layerEl, layer);
        renderLayerSnippets(layerEl, layer);
        cursor = placeElementAfterCursor(browser, layerEl, cursor);
    }

    browser.scrollTop(previousScrollTop);
}

function renderEmptySnippetBrowser(browser) {
    if (hasFocusedSnippetEdit(browser)) {
        return;
    }

    browser.children().remove();
    $('<div class="sc-muted"></div>').text('No snippets to display.').appendTo(browser);
}

function removeMissingChildElements(parent, selector, keys) {
    parent.children(selector).each(function () {
        const child = $(this);
        if (!keys.has(child.attr('data-key')) && !hasFocusedSnippetEdit(child)) {
            child.remove();
        }
    });
}

function getOrCreateChildElement(parent, className, key) {
    const existing = parent
        .children(`.${className}`)
        .filter(function () {
            return $(this).attr('data-key') === key;
        })
        .first();

    if (existing.length) {
        return existing;
    }

    return $(`<div class="${className}"></div>`);
}

function updateLayerElement(layerEl, layer) {
    layerEl.attr({ 'data-key': layer.key, 'data-layer': String(layer.index) });

    let title = layerEl.children('.sc-browser-layer-title').first();
    if (!title.length) {
        title = $('<div class="sc-browser-layer-title"></div>').prependTo(layerEl);
    }
    title.text(layer.label);
}

function renderLayerSnippets(layerEl, layer) {
    const rowKeys = new Set(layer.snippets.map((snippet) => snippet.key));
    removeMissingChildElements(layerEl, '.sc-snippet', rowKeys);

    let cursor = layerEl.children('.sc-browser-layer-title').first();
    for (const snippet of layer.snippets) {
        const row = getOrCreateChildElement(layerEl, 'sc-snippet', snippet.key);
        updateSnippetRow(row, snippet);
        cursor = placeElementAfterCursor(layerEl, row, cursor);
    }
}

function placeElementAfterCursor(parent, element, cursor) {
    if (cursor?.length) {
        if (!cursor.next().is(element)) {
            element.insertAfter(cursor);
        }
        return element;
    }

    if (!parent.children().first().is(element)) {
        parent.prepend(element);
    }
    return element;
}

function updateSnippetRow(row, snippet) {
    row.attr({
        'data-key': snippet.key,
        'data-layer': String(snippet.layerIndex),
        'data-idx': String(snippet.snippetIndex),
    });

    if (hasFocusedSnippetEdit(row)) {
        return;
    }

    row.children('.sc-snippet-edit').remove();
    const text = ensureSnippetText(row, snippet);
    const meta = ensureSnippetMeta(row, snippet);
    const redo = ensureSnippetRedo(row, snippet);
    const remove = ensureSnippetDelete(row);

    row.append(text, meta);
    if (redo) {
        row.append(redo);
    }
    row.append(remove);
}

function ensureSnippetText(row, snippet) {
    let text = row.children('.sc-snippet-text').first();
    if (!text.length) {
        text = $('<span class="sc-snippet-text"></span>');
    }
    text.attr({
        'data-layer': String(snippet.layerIndex),
        'data-idx': String(snippet.snippetIndex),
        title: 'Click to edit',
    });
    text.text(snippet.text);
    return text;
}

function ensureSnippetMeta(row, snippet) {
    let meta = row.children('.sc-snippet-meta').first();
    if (!meta.length) {
        meta = $('<span class="sc-snippet-meta"></span>');
    }
    meta.text(snippet.meta);
    return meta;
}

function ensureSnippetButton(row, className, label) {
    let button = row.children(`.${className}`).first();
    if (!button.length) {
        button = $(`<button class="${className} menu_button"></button>`);
    }
    button.attr({
        type: 'button',
        title: label,
        'aria-label': label,
    });
    return button;
}

function ensureSnippetRedo(row, snippet) {
    let redo = row.children('.sc-snippet-redo').first();
    if (!snippet.canRedo) {
        redo.remove();
        return null;
    }
    redo = ensureSnippetButton(row, 'sc-snippet-redo', 'Regenerate this snippet');
    redo.addClass('fa-solid fa-rotate-right');
    return redo;
}

function ensureSnippetDelete(row) {
    const remove = ensureSnippetButton(row, 'sc-snippet-delete', 'Delete this snippet');
    remove.addClass('fa-solid fa-xmark');
    return remove;
}

function hasFocusedSnippetEdit(scope) {
    return scope.find('.sc-snippet-edit:focus').length > 0;
}

function onSnippetTextClick() {
    const position = getSnippetPosition($(this));
    if (!position) {
        return;
    }

    const snippetText = getSnippetTextAt(position.layerIdx, position.snippetIdx);
    if (snippetText.status !== 'found') {
        return;
    }

    startSnippetEdit($(this), position, snippetText.text);
}

function getSnippetPosition(element) {
    const row = element.closest('.sc-snippet');
    const layerIdx = Number.parseInt(String(row.attr('data-layer')), 10);
    const snippetIdx = Number.parseInt(String(row.attr('data-idx')), 10);

    if (!Number.isInteger(layerIdx) || !Number.isInteger(snippetIdx)) {
        return null;
    }
    return { layerIdx, snippetIdx };
}

function startSnippetEdit(textEl, position, initialText) {
    let finished = false;
    const textarea = $('<textarea class="sc-snippet-edit"></textarea>').val(initialText);
    const finish = async (shouldSave) => {
        if (finished) {
            return;
        }
        finished = true;
        try {
            if (shouldSave) {
                await commitSnippetEdit(textarea, position);
            }
        } finally {
            updateSnippetBrowser();
        }
    };

    textarea
        .on('keydown', async function (e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                await finish(true);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                await finish(false);
            }
        })
        .on('blur', async () => {
            await finish(true);
        });

    textEl.replaceWith(textarea);
    resizeSnippetEdit(textarea);
    textarea.focus().select();
}

async function commitSnippetEdit(textarea, position) {
    const result = await updateSnippetTextAt(
        position.layerIdx,
        position.snippetIdx,
        textarea.val(),
    );
    if (result.status === 'updated') {
        toastr.success('Snippet updated', TOAST_TITLE, {
            timeOut: 1500,
        });
    }
}

function resizeSnippetEdit(textarea) {
    const element = textarea[0];
    if (!element) {
        return;
    }
    element.style.height = 'auto';
    element.style.height = element.scrollHeight + 'px';
}

async function onSnippetRedoClick() {
    const position = getSnippetPosition($(this));
    if (!position) {
        return;
    }

    const target = getSnippetRegenerationTarget(position.layerIdx, position.snippetIdx);
    if (target.status !== 'ready') {
        handleRegenerationTargetStatus(target);
        return;
    }
    if (!confirm(`Regenerate summary for turns ${target.range[0]}-${target.range[1]}?`)) {
        return;
    }

    toastr.info(
        `Regenerating summary for turns ${target.range[0]}-${target.range[1]}...`,
        TOAST_TITLE,
        {
            timeOut: 3000,
            progressBar: true,
        },
    );
    await runSnippetRegeneration($(this), position);
}

async function onSnippetDeleteClick() {
    const position = getSnippetPosition($(this));
    if (!position) {
        return;
    }

    const result = await deleteSnippetAt(position.layerIdx, position.snippetIdx);
    if (result.status === 'deleted') {
        refreshUI();
        toastr.info(`Snippet removed from Layer ${result.layerIndex}`, TOAST_TITLE);
    }
}

function handleRegenerationTargetStatus(target) {
    if (target.status === 'ready') {
        return true;
    }
    if (target.status === 'busy') {
        showBusySummaryToast();
        return false;
    }
    if (target.status === 'unsupported') {
        toastr.warning(
            'Only Layer 0 (turn summary) snippets can be regenerated. Promoted meta-summaries have no source turns.',
            TOAST_TITLE,
            { timeOut: 5000 },
        );
    }
    return false;
}

async function runSnippetRegeneration(btn, position) {
    btn.prop('disabled', true).removeClass('fa-rotate-right').addClass('fa-spinner fa-spin');
    try {
        const result = await regenerateSnippetAt(position.layerIdx, position.snippetIdx);
        handleRegenerationResult(result);
    } finally {
        btn.prop('disabled', false).removeClass('fa-spinner fa-spin').addClass('fa-rotate-right');
    }
}

function handleRegenerationResult(result) {
    if (result.status === 'regenerated') {
        refreshUI();
        toastr.success(
            `Snippet regenerated for turns ${result.range[0]}-${result.range[1]}`,
            TOAST_TITLE,
            { timeOut: 3000 },
        );
        return;
    }
    if (result.status === 'empty-source') {
        toastr.error('Source turns are empty - cannot regenerate.', TOAST_TITLE);
    } else if (result.status === 'failed') {
        toastr.error('Regeneration failed - original snippet kept.', TOAST_TITLE);
    } else if (result.status === 'busy') {
        showBusySummaryToast();
    } else if (result.status === 'unsupported') {
        handleRegenerationTargetStatus(result);
    }
}
