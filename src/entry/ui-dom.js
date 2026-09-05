/**
 * Shared jQuery DOM helpers for the entry modules.
 */
/**
 * Find the first descendant of $parent matching selector, creating it via
 * make() when absent. make() owns placement of any node it creates.
 * @param {object} $parent jQuery-wrapped search root
 * @param {string} selector jQuery selector for the child to find
 * @param {function(): object} make Called when absent; owns placement of the created node
 * @returns {object} jQuery-wrapped existing or newly created element
 */
export function ensureChild($parent, selector, make) {
    const $existing = $parent.find(selector).first();
    if ($existing.length) {
        return $existing;
    }
    return make();
}
