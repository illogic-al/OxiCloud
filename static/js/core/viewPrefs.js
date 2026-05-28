// @ts-check

/**
 * View preferences — persist groupBy, sort-direction, and grid/list view
 * per section in localStorage.
 *
 * Each section has its own key (`oxicloud.view.<section>`) so that, for
 * example, Favorites can be in list view with "Type" grouping while Files
 * is in grid view with no grouping.
 *
 * Section keys match `app.currentSection` values:
 *   'files' | 'favorites' | 'sharedwithme' | 'recent' | 'trash' |
 *   'photos' | 'music' | 'shared'
 *
 * All errors (quota, private browsing, JSON parse) are silently swallowed.
 *
 * Usage:
 *   import * as viewPrefs from '../core/viewPrefs.js';
 *
 *   // Read
 *   const { groupBy, reversed, view } = viewPrefs.load('files');
 *
 *   // Write all fields at once
 *   viewPrefs.save('files', 'type', true, 'list');
 *
 *   // Write only the view (grid/list) toggle, keeping stored groupBy/reversed
 *   viewPrefs.saveView('favorites', 'grid');
 *
 *   // Resolve which view (grid/list) to apply on section entry
 *   const v = viewPrefs.resolveView('sharedwithme');   // 'grid' | 'list'
 */

const _PREFIX = 'oxicloud.view.';

/**
 * @typedef {'grid'|'list'|''} ViewMode
 * @typedef {{ groupBy: string, reversed: boolean, view: ViewMode }} ViewPrefs
 */

/**
 * Load saved preferences for a section.
 * Returns safe defaults when nothing is stored or storage is unavailable.
 * @param {string} section
 * @returns {ViewPrefs}
 */
function load(section) {
    try {
        const raw = localStorage.getItem(_PREFIX + section);
        if (!raw) return { groupBy: '', reversed: false, view: '' };
        const p = JSON.parse(raw);
        return {
            groupBy: typeof p.groupBy === 'string' ? p.groupBy : '',
            reversed: Boolean(p.reversed),
            view: p.view === 'grid' || p.view === 'list' ? p.view : ''
        };
    } catch {
        return { groupBy: '', reversed: false, view: '' };
    }
}

/**
 * Persist all preferences for a section.
 * @param {string}   section
 * @param {string}   groupBy
 * @param {boolean}  reversed
 * @param {ViewMode} view
 */
function save(section, groupBy, reversed, view) {
    try {
        localStorage.setItem(_PREFIX + section, JSON.stringify({ groupBy, reversed, view }));
    } catch {
        // Silently ignore quota errors or restricted environments.
    }
}

/**
 * Update only the grid/list view for a section, preserving groupBy and reversed.
 * @param {string}   section
 * @param {ViewMode} view
 */
function saveView(section, view) {
    const current = load(section);
    save(section, current.groupBy, current.reversed, view);
}

/**
 * Resolve the view mode to apply when entering a section.
 * Priority: section-specific pref → legacy global `oxicloud-view` key → `'grid'`.
 * @param {string} section
 * @returns {'grid'|'list'}
 */
function resolveView(section) {
    const prefs = load(section);
    if (prefs.view) return prefs.view;
    // Fall back to the pre-existing global key (backward compatibility).
    const global = localStorage.getItem('oxicloud-view');
    return global === 'list' ? 'list' : 'grid';
}

export { load, resolveView, save, saveView };
