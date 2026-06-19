/**
 * OxiCloud - Photos Timeline View
 * Photo grid grouped by day/month/year, with infinite scroll and multi-select.
 */

import { Modal } from '../../components/modal.js';
import { getCsrfHeaders } from '../../core/csrf.js';
import { i18n } from '../../core/i18n.js';
import { thumbnail } from '../thumbnail.js';
import { photosLightbox } from './photosLightbox.js';

/** @import {FileItem} from '../../core/types.js' */

/**
 * @typedef {'daily'|'monthly'|'yearly'} PhotoModeEnum
 */

/**
 * @typedef {Object} PhotoGroup
 * @property {string} label
 * @property {FileItem[]} files
 * @property {HTMLElement} section
 * @property {boolean} materialized
 */

const photosView = {
    /** @type {Array<FileItem>} All loaded photo items */
    items: [],
    /** @type {string|null} Cursor for next page */
    nextCursor: null,
    /** @type {boolean} Currently fetching */
    loading: false,
    /** @type {boolean} All items loaded */
    exhausted: false,
    /** @type {Set<string>} Selected item IDs */
    selected: new Set(),
    /** @type {IntersectionObserver|null} Materializes/dematerializes group tiles by viewport proximity */
    _materializeObserver: null,
    /** @type {IntersectionObserver|null} Infinite-scroll trigger on the sentinel */
    _sentinelObserver: null,
    /** @type {HTMLElement|null} */
    _container: null,
    /** @type {HTMLElement|null} The infinite-scroll sentinel element */
    _sentinelEl: null,
    /** @type {boolean} */
    _initialized: false,
    /** @type {PhotoModeEnum} */
    groupMode: 'monthly',
    /** @type {'square'|'justified'} */
    layoutMode: 'square',
    /** @type {Map<string, string>} fileId → thumbnail URL (persists across re-renders) */
    _videoThumbCache: new Map(),
    /** @type {Map<string, PhotoGroup>} group label → group record (DOM + data) */
    _groupData: new Map(),
    /** @type {string[]} Ordered group labels (timeline order) */
    _groupOrder: [],
    /** @type {(() => void)|null} Debounced window resize handler */
    _resizeHandler: null,
    /** @type {number} */
    _resizeTimer: 0,
    /** @type {string|null} Anchor id for shift-range selection */
    _selectAnchorId: null,

    PAGE_SIZE: 200,

    /** Auth headers (HttpOnly cookies) */
    _headers(json = false) {
        const h = getCsrfHeaders();
        if (json) h['Content-Type'] = 'application/json';
        return h;
    },

    /** Initialize / re-initialize the photos view */
    init() {
        if (!this._container) {
            const contentArea = document.querySelector('.content-area');
            if (!contentArea) return;
            const el = document.createElement('div');
            el.id = 'photos-container';
            el.className = 'photos-container';
            contentArea.appendChild(el);
            this._container = el;
        }
        if (!this._initialized) {
            this.groupMode = /** @type {'daily'|'monthly'|'yearly'} */ (localStorage.getItem('oxicloud-photos-group')) || 'monthly';
            this.layoutMode = /** @type {'square'|'justified'} */ (localStorage.getItem('oxicloud-photos-layout')) || 'square';
            this._initialized = true;
        }
    },

    /** Show the photos view and load data */
    show() {
        this.init();
        if (!this._container) return;
        this._container.classList.add('active');
        this.items = [];
        this.nextCursor = null;
        this.exhausted = false;
        this.selected.clear();
        this._groupData = new Map();
        this._groupOrder = [];
        this._destroyObserver();
        this._container.innerHTML = '';
        this._loadPage();
    },

    /** Hide the photos view */
    hide() {
        if (this._container) {
            this._container.classList.remove('active');
        }
        this._destroyObserver();
        this._unbindResize();
        this._hideSelectionBar();
    },

    /** Switch grouping mode */
    /**
     *
     * @param {PhotoModeEnum} mode
     * @returns
     */
    setGroupMode(mode) {
        if (this.groupMode === mode) return;
        this.groupMode = mode;
        localStorage.setItem('oxicloud-photos-group', mode);
        this._renderFull();
    },

    /**
     * Switch tile layout (square crop vs justified aspect-preserving rows).
     * @param {'square'|'justified'} mode
     */
    setLayoutMode(mode) {
        if (this.layoutMode === mode) return;
        this.layoutMode = mode;
        localStorage.setItem('oxicloud-photos-layout', mode);
        this._renderFull();
    },

    /** Fetch a page of photos from the API */
    async _loadPage() {
        if (this.loading || this.exhausted) return;
        this.loading = true;
        this._showLoading(true);
        const prevCount = this.items.length;

        try {
            let url = `/api/photos?limit=${this.PAGE_SIZE}`;
            if (this.nextCursor) {
                url += `&before=${this.nextCursor}`;
            }

            const res = await fetch(url, {
                credentials: 'include',
                headers: this._headers()
            });

            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            /** @type {FileItem[]} */
            const data = await res.json();

            if (!data || data.length === 0) {
                this.exhausted = true;
            } else {
                this.items.push(...data);
                const cursor = res.headers.get('X-Next-Cursor');
                if (cursor && data.length >= this.PAGE_SIZE) {
                    this.nextCursor = cursor;
                } else {
                    this.exhausted = true;
                }
            }
        } catch (err) {
            console.error('Error loading photos:', err);
            this.exhausted = true;
        } finally {
            this.loading = false;
            this._showLoading(false);
            if (prevCount === 0) {
                this._renderFull();
            } else {
                this._appendBatch(prevCount);
            }
        }
    },

    // ── Virtualized rendering ───────────────────────────────────────
    // The timeline can hold tens of thousands of items, so we never keep
    // every tile in the DOM. Each date-group is a <section> with a header
    // (always present, cheap) and a grid that is *materialized* (tiles in
    // the DOM) only while near the viewport, and *dematerialized* (emptied,
    // its height frozen as a spacer) once it scrolls far away. An
    // IntersectionObserver rooted on the scroll container drives the swap,
    // so the DOM node count stays bounded by a few screens regardless of
    // library size.
    //   _renderFull()   — rebuild the group skeleton (first load, mode switch, delete)
    //   _appendBatch(n) — append new groups for infinite-scroll pages

    /** Rebuild the group skeleton — first load, group-mode switch, or deletions. */
    _renderFull() {
        if (!this._container) return;
        this._destroyObserver();
        this._groupData = new Map();
        this._groupOrder = [];

        this._container.classList.remove('photos-group-daily', 'photos-group-monthly', 'photos-group-yearly');
        this._container.classList.add(`photos-group-${this.groupMode}`);
        this._container.classList.remove('photos-layout-square', 'photos-layout-justified');
        this._container.classList.add(`photos-layout-${this.layoutMode}`);

        if (this.items.length === 0 && this.exhausted) {
            this._renderEmpty();
            return;
        }
        if (this.items.length === 0) return;

        // Toolbar via innerHTML, then append group <section>s + sentinel as
        // real elements so we keep references for the observer.
        this._container.innerHTML = this._renderToolbar();
        this._container.onclick = (e) => this._handleClick(e);
        this._container.onkeydown = (e) => this._handleKeydown(e);

        const groups = this._groupItems(this.items);
        for (const [label, files] of groups) {
            /** @type {PhotoGroup} */
            const rec = { label, files, section: this._buildGroupEl(label, files), materialized: false };
            this._groupData.set(label, rec);
            this._groupOrder.push(label);
            this._container.appendChild(rec.section);
        }

        const sentinel = document.createElement('div');
        sentinel.className = 'photos-sentinel';
        this._container.appendChild(sentinel);
        this._sentinelEl = sentinel;

        this._setupObservers();
        this._eagerMaterialize();
        this._bindResize();
    },

    /** Append new groups for an infinite-scroll page without rebuilding the
     *  existing skeleton. The first new group may continue the previous tail
     *  label, in which case we merge into it. Complexity: O(new groups).
     * @param {number} startIndex
     */
    _appendBatch(startIndex) {
        if (!this._container || !this._sentinelEl) {
            this._renderFull();
            return;
        }
        const newItems = this.items.slice(startIndex);
        if (newItems.length === 0) return;

        const newGroups = this._groupItems(newItems);
        for (const [label, files] of newGroups) {
            const existing = this._groupData.get(label);
            if (existing) {
                // Continuation of a group already in the timeline.
                existing.files = existing.files.concat(files);
                const countEl = existing.section.querySelector('.photos-day-count');
                if (countEl) countEl.textContent = String(existing.files.length);
                const grid = /** @type {HTMLElement|null} */ (existing.section.querySelector('.photos-grid'));
                if (grid) {
                    if (existing.materialized) {
                        if (this.layoutMode === 'justified') {
                            // Justified rows must repack against the whole group.
                            grid.innerHTML = this._renderGroupTiles(existing.files);
                        } else {
                            let tilesHtml = '';
                            for (const file of files) tilesHtml += this._renderTile(file);
                            grid.insertAdjacentHTML('beforeend', tilesHtml);
                        }
                        this._setupVideoThumbnails(grid);
                        this._fadeInTiles(grid);
                    } else {
                        grid.style.minHeight = `${this._estimateHeight(existing.files.length)}px`;
                    }
                }
            } else {
                /** @type {PhotoGroup} */
                const rec = { label, files, section: this._buildGroupEl(label, files), materialized: false };
                this._groupData.set(label, rec);
                this._groupOrder.push(label);
                this._container.insertBefore(rec.section, this._sentinelEl);
                this._materializeObserver?.observe(rec.section);
            }
        }
    },

    /** Build a dematerialized group section (header + empty grid spacer).
     * @param {string} label
     * @param {FileItem[]} files
     * @returns {HTMLElement}
     */
    _buildGroupEl(label, files) {
        const section = document.createElement('section');
        section.className = 'photos-group';
        section.dataset.group = label;
        section.innerHTML =
            `<div class="photos-day-header" data-group="${this._escAttr(label)}">${this._escHtml(label)}<span class="photos-day-count">${files.length}</span></div>` +
            `<div class="photos-grid" style="min-height:${this._estimateHeight(files.length)}px"></div>`;
        return section;
    },

    /** Wire the two IntersectionObservers (materialization + infinite scroll). */
    _setupObservers() {
        const root = this._container?.parentElement || null;

        if (!('IntersectionObserver' in window)) {
            // Degrade gracefully: render every group (legacy behaviour).
            for (const label of this._groupOrder) {
                const rec = this._groupData.get(label);
                if (rec) this._materializeGroup(rec.section);
            }
            return;
        }

        this._materializeObserver = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    const section = /** @type {HTMLElement} */ (entry.target);
                    if (entry.isIntersecting) this._materializeGroup(section);
                    else this._dematerializeGroup(section);
                }
            },
            { root, rootMargin: '1200px 0px' }
        );
        for (const label of this._groupOrder) {
            const rec = this._groupData.get(label);
            if (rec) this._materializeObserver.observe(rec.section);
        }

        if (this._sentinelEl) {
            this._sentinelObserver = new IntersectionObserver(
                (entries) => {
                    if (entries[0].isIntersecting) this._loadPage();
                },
                { root, rootMargin: '600px 0px' }
            );
            this._sentinelObserver.observe(this._sentinelEl);
        }
    },

    /** Synchronously materialize the first groups within ~1.5 viewports so
     *  the initial paint has tiles before the observer's first callback. */
    _eagerMaterialize() {
        const budget = (this._container?.parentElement?.clientHeight || window.innerHeight) * 1.5;
        let acc = 0;
        for (const label of this._groupOrder) {
            const rec = this._groupData.get(label);
            if (!rec) continue;
            this._materializeGroup(rec.section);
            acc += rec.section.offsetHeight;
            if (acc > budget) break;
        }
    },

    /** Fill a group's grid with tiles (idempotent).
     * @param {HTMLElement} section
     */
    _materializeGroup(section) {
        const rec = this._groupData.get(section.dataset.group || '');
        if (!rec || rec.materialized) return;
        rec.materialized = true;
        const grid = /** @type {HTMLElement|null} */ (section.querySelector('.photos-grid'));
        if (!grid) return;
        grid.innerHTML = this._renderGroupTiles(rec.files);
        grid.style.minHeight = '';
        this._setupVideoThumbnails(grid);
        this._fadeInTiles(grid);
    },

    /** Empty a group's grid, freezing its current height as a spacer.
     * @param {HTMLElement} section
     */
    _dematerializeGroup(section) {
        const rec = this._groupData.get(section.dataset.group || '');
        if (!rec?.materialized) return;
        rec.materialized = false;
        const grid = /** @type {HTMLElement|null} */ (section.querySelector('.photos-grid'));
        if (!grid) return;
        grid.style.minHeight = `${grid.offsetHeight}px`;
        grid.innerHTML = '';
    },

    /** Current grid geometry (columns / gap / square tile px) for the active
     *  mode, used to estimate off-screen group heights.
     * @returns {{cols: number, gap: number, tile: number}}
     */
    _gridMetrics() {
        const width = this._gridWidth();
        const mobile = window.matchMedia('(max-width: 768px)').matches;
        let min;
        let gap;
        if (this.groupMode === 'yearly') {
            min = mobile ? 80 : 120;
            gap = mobile ? 4 : 10;
        } else if (this.groupMode === 'monthly') {
            min = mobile ? 110 : 180;
            gap = mobile ? 2 : 14;
        } else {
            min = mobile ? 100 : 150;
            gap = mobile ? 2 : 12;
        }
        const cols = Math.max(1, Math.floor((width + gap) / (min + gap)));
        const tile = (width - (cols - 1) * gap) / cols;
        return { cols, gap, tile };
    },

    /** Estimated pixel height of a grid holding `count` square tiles.
     * @param {number} count
     * @returns {number}
     */
    _estimateHeight(count) {
        if (this.layoutMode === 'justified') {
            const width = this._gridWidth();
            const target = window.matchMedia('(max-width: 768px)').matches ? 150 : 200;
            const perRow = Math.max(1, Math.round(width / (target * 1.4)));
            const rows = Math.max(1, Math.ceil(count / perRow));
            return Math.round(rows * target + (rows - 1) * 8);
        }
        const { cols, gap, tile } = this._gridMetrics();
        const rows = Math.max(1, Math.ceil(count / cols));
        return Math.round(rows * tile + (rows - 1) * gap);
    },

    /** Re-estimate spacer heights for dematerialized groups after a resize. */
    _bindResize() {
        if (this._resizeHandler) return;
        this._resizeHandler = () => {
            clearTimeout(this._resizeTimer);
            this._resizeTimer = window.setTimeout(() => this._onResize(), 150);
        };
        window.addEventListener('resize', this._resizeHandler);
    },

    _onResize() {
        if (!this._container?.classList.contains('active')) return;
        for (const label of this._groupOrder) {
            const rec = this._groupData.get(label);
            if (!rec || rec.materialized) continue;
            const grid = /** @type {HTMLElement|null} */ (rec.section.querySelector('.photos-grid'));
            if (grid) grid.style.minHeight = `${this._estimateHeight(rec.files.length)}px`;
        }
    },

    _unbindResize() {
        if (this._resizeHandler) {
            window.removeEventListener('resize', this._resizeHandler);
            this._resizeHandler = null;
        }
        clearTimeout(this._resizeTimer);
    },

    /**
     * Generate HTML for a single photo/video tile
     * @param {FileItem} file
     * @param {string} [sizeStyle] Inline `width:..;height:..` for justified rows.
     */
    _renderTile(file, sizeStyle) {
        const isVideo = file.mime_type?.startsWith('video/');
        const selected = this.selected.has(file.id) ? ' selected' : '';
        const cachedThumb = isVideo && this._videoThumbCache.has(file.id) ? this._videoThumbCache.get(file.id) : null;
        const thumbUrl = cachedThumb || `/api/files/${file.id}/thumbnail/preview`;
        const styleAttr = sizeStyle ? ` style="${sizeStyle}"` : '';
        let h = `<div class="photo-tile${selected}" data-id="${this._escAttr(file.id)}" data-mime="${this._escAttr(file.mime_type)}" data-name="${this._escAttr(file.name)}" tabindex="0" role="button" aria-label="${this._escAttr(file.name)}"${styleAttr}>`;
        h += `<div class="photo-check"><i class="fas fa-check"></i></div>`;
        const srcset = cachedThumb
            ? ''
            : ` srcset="/api/files/${file.id}/thumbnail/icon 150w, /api/files/${file.id}/thumbnail/preview 400w, /api/files/${file.id}/thumbnail/large 800w" sizes="(max-width: 768px) 33vw, 200px"`;
        h += `<img src="${thumbUrl}"${srcset} loading="lazy" decoding="async" alt="${this._escAttr(file.name)}">`;
        if (isVideo) h += `<div class="video-badge"><i class="fas fa-play"></i></div>`;
        h += `</div>`;
        return h;
    },

    /**
     * Inner HTML for a group's grid in the current layout mode.
     * @param {FileItem[]} files
     * @returns {string}
     */
    _renderGroupTiles(files) {
        if (this.layoutMode !== 'justified') {
            let html = '';
            for (const file of files) html += this._renderTile(file);
            return html;
        }
        const rows = this._justifiedRows(files, this._gridWidth());
        let html = '';
        for (const row of rows) {
            html += `<div class="photos-jrow" style="height:${row.height}px">`;
            for (const t of row.tiles) {
                html += this._renderTile(t.file, `width:${t.w}px;height:${t.h}px`);
            }
            html += '</div>';
        }
        return html;
    },

    /**
     * Pack files into justified rows (Flickr-style): each full row is scaled so
     * it fills the container width while preserving every tile's aspect ratio.
     * Missing dimensions fall back to a 1:1 aspect.
     * @param {FileItem[]} files
     * @param {number} width Available content width in px.
     * @returns {Array<{height: number, tiles: Array<{file: FileItem, w: number, h: number}>}>}
     */
    _justifiedRows(files, width) {
        const gap = 8;
        const target = window.matchMedia('(max-width: 768px)').matches ? 150 : 200;
        /** @type {Array<{height: number, tiles: Array<{file: FileItem, w: number, h: number}>}>} */
        const rows = [];
        /** @type {Array<{file: FileItem, aspect: number}>} */
        let cur = [];
        let aspectSum = 0;
        for (const file of files) {
            let aspect = file.width && file.height ? file.width / file.height : 1;
            if (!Number.isFinite(aspect) || aspect <= 0) aspect = 1;
            aspect = Math.min(Math.max(aspect, 0.4), 3);
            cur.push({ file, aspect });
            aspectSum += aspect;
            const rowWidth = aspectSum * target + (cur.length - 1) * gap;
            if (rowWidth >= width) {
                const h = (width - (cur.length - 1) * gap) / aspectSum;
                rows.push({
                    height: Math.round(h),
                    tiles: cur.map((t) => ({ file: t.file, w: Math.max(1, Math.round(t.aspect * h)), h: Math.round(h) }))
                });
                cur = [];
                aspectSum = 0;
            }
        }
        if (cur.length) {
            rows.push({
                height: target,
                tiles: cur.map((t) => ({ file: t.file, w: Math.max(1, Math.round(t.aspect * target)), h: target }))
            });
        }
        return rows;
    },

    /** Current grid content width in px (for layout / height estimates). */
    _gridWidth() {
        const sample = /** @type {HTMLElement|null} */ (this._container?.querySelector('.photos-grid'));
        return sample?.clientWidth || (this._container?.clientWidth || 1200) - 16;
    },

    /**
     * Fade tiles in as their thumbnails finish loading (kills the pop-in).
     * Idempotent — only wires images not already marked loaded.
     * @param {ParentNode} [scope] Limit to a subtree (a group grid); defaults to the whole container.
     */
    _fadeInTiles(scope) {
        const root = scope || this._container;
        root?.querySelectorAll('.photo-tile img:not(.is-loaded)').forEach((el) => {
            const img = /** @type {HTMLImageElement} */ (el);
            if (img.complete) {
                img.classList.add('is-loaded');
            } else {
                const done = () => img.classList.add('is-loaded');
                img.addEventListener('load', done, { once: true });
                img.addEventListener('error', done, { once: true });
            }
        });
    },

    // ── Client-side video thumbnail generation ──────────────────────
    // Uses the browser's native video decoder (<video> + <canvas>) to
    // extract a frame, show it immediately, and upload to the server
    // for permanent caching.  Zero server-side dependencies (no ffmpeg).

    /** Attach error handlers to video tile images within a freshly
     *  materialized grid; on failure, extract a frame from the video using
     *  the browser's built-in codec.
     * @param {ParentNode} [scope] Subtree to scan; defaults to the whole container.
     */
    _setupVideoThumbnails(scope) {
        const root = scope || this._container;
        const tiles = /** @type {NodeListOf<HTMLDivElement>|undefined} */ (root?.querySelectorAll('.photo-tile[data-mime^="video/"]'));

        if (!tiles) return;

        for (const tile of tiles) {
            const fileId = tile.dataset.id;
            if (!fileId) continue;
            if (this._videoThumbCache.has(fileId)) continue;

            const img = tile.querySelector('img');
            if (!img) continue;

            img.addEventListener(
                'error',
                () => {
                    this._generateVideoThumbnail(tile, img);
                },
                { once: true }
            );
        }
    },

    /**
     * Extract a frame and upload all thumbnail sizes via thumbnail.queueGenerate().
     * @param {HTMLDivElement} tile
     * @param {HTMLImageElement} img
     */
    async _generateVideoThumbnail(tile, img) {
        const fileId = tile.dataset.id;
        // TODO: remove this HACK, this is not evolutive...
        const file = /** @type {FileItem} */ ({ id: fileId, icon_special_class: 'video-icon', name: tile.dataset.name, mime_type: tile.dataset.mime });

        try {
            await thumbnail.queueGenerate(file, null, (previewDataUrl) => {
                img.src = previewDataUrl;
                this._videoThumbCache.set(fileId, previewDataUrl);
            });
            // Switch to permanent server URL so the data URL can be GC'd
            this._videoThumbCache.set(fileId, `/api/files/${fileId}/thumbnail/preview?v=1`);
        } catch {
            // Keep generic play badge on error
        }
    },

    /** Render the group mode toolbar */
    _renderToolbar() {
        const modes = [
            ['daily', i18n.t('photos.view_daily')],
            ['monthly', i18n.t('photos.view_monthly')],
            ['yearly', i18n.t('photos.view_yearly')]
        ];
        let html = '<div class="photos-toolbar">';

        // Layout toggle (square crop ↔ justified rows)
        html += '<div class="view-toggle photos-layout-toggle">';
        html += `<button class="toggle-btn${this.layoutMode === 'square' ? ' active' : ''}" data-layout-mode="square" title="${this._escAttr(i18n.t('photos.layout_square'))}" aria-label="${this._escAttr(i18n.t('photos.layout_square'))}"><i class="fas fa-table-cells"></i></button>`;
        html += `<button class="toggle-btn${this.layoutMode === 'justified' ? ' active' : ''}" data-layout-mode="justified" title="${this._escAttr(i18n.t('photos.layout_justified'))}" aria-label="${this._escAttr(i18n.t('photos.layout_justified'))}"><i class="fas fa-grip"></i></button>`;
        html += '</div>';

        // Grouping toggle (day / month / year)
        html += '<div class="view-toggle">';
        for (const [mode, label] of modes) {
            const active = this.groupMode === mode ? ' active' : '';
            html += `<button class="toggle-btn${active}" data-group-mode="${mode}">${this._escHtml(label)}</button>`;
        }
        html += '</div></div>';
        return html;
    },

    /** Render empty state */
    _renderEmpty() {
        if (!this._container) return;
        this._container.innerHTML = `
            <div class="photos-empty">
                <i class="fas fa-images"></i>
                <p class="photos-empty-title">${i18n.t('photos.empty_state')}</p>
                <p>${i18n.t('photos.empty_hint')}</p>
            </div>`;
    },

    /**
     *  Group items by the current groupMode
     * @param {FileItem[]} items
     */
    _groupItems(items) {
        const map = new Map();
        for (const item of items) {
            const ts = (item.sort_date || item.created_at) * 1000;
            const d = new Date(ts);
            let key;
            if (this.groupMode === 'yearly') {
                key = String(d.getFullYear());
            } else if (this.groupMode === 'monthly') {
                key = d.toLocaleDateString(undefined, {
                    year: 'numeric',
                    month: 'long'
                });
            } else {
                key = d.toLocaleDateString(undefined, {
                    weekday: 'long',
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric'
                });
            }
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(item);
        }
        return map;
    },

    /**
     * Handle click on photo tile or toolbar
     * @param {MouseEvent} e
     */
    _handleClick(e) {
        // Handle group mode toggle
        const target = /** @type {Element} */ (e.target);
        const modeBtn = /** @type {HTMLButtonElement} */ (target.closest('[data-group-mode]'));
        if (modeBtn) {
            this.setGroupMode(/** @type {PhotoModeEnum} */ (modeBtn.dataset.groupMode));
            return;
        }

        const layoutBtn = /** @type {HTMLButtonElement} */ (target.closest('[data-layout-mode]'));
        if (layoutBtn) {
            this.setLayoutMode(/** @type {'square'|'justified'} */ (layoutBtn.dataset.layoutMode));
            return;
        }

        const tile = /** @type {HTMLDivElement} */ (target.closest('.photo-tile'));
        if (!tile) return;

        const id = tile.dataset.id;
        const check = target.closest('.photo-check');

        // Shift-click extends the selection from the last anchor.
        if (id && e.shiftKey && this._selectAnchorId) {
            this._selectRange(this._selectAnchorId, id);
            return;
        }

        // If clicking checkbox or in selection mode, toggle select
        if (check || this.selected.size > 0) {
            this._toggleSelect(id, tile);
            this._selectAnchorId = id || null;
            return;
        }

        // Otherwise open lightbox
        const idx = this.items.findIndex((f) => f.id === id);
        if (idx >= 0) {
            photosLightbox.open(this.items, idx);
        }
    },

    /**
     * Select every item between the anchor and the target (inclusive), in
     * timeline order. Tracked in the Set so it survives dematerialized
     * groups; currently-visible tiles get the class applied immediately.
     * @param {string} anchorId
     * @param {string} toId
     */
    _selectRange(anchorId, toId) {
        const a = this.items.findIndex((f) => f.id === anchorId);
        const b = this.items.findIndex((f) => f.id === toId);
        if (a < 0 || b < 0) return;
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        for (let i = lo; i <= hi; i++) this.selected.add(this.items[i].id);
        this._container?.querySelectorAll('.photo-tile').forEach((el) => {
            const t = /** @type {HTMLElement} */ (el);
            if (t.dataset.id && this.selected.has(t.dataset.id)) t.classList.add('selected');
        });
        this._selectAnchorId = toId;
        this._updateSelectionBar();
    },

    /**
     * Keyboard activation for focused tiles: Enter opens the lightbox (or
     * toggles selection when in selection mode); Space toggles selection.
     * @param {KeyboardEvent} e
     */
    _handleKeydown(e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const target = /** @type {Element} */ (e.target);
        const tile = /** @type {HTMLDivElement} */ (target.closest('.photo-tile'));
        if (!tile) return;
        e.preventDefault();
        const id = tile.dataset.id;
        if (e.key === ' ' || this.selected.size > 0) {
            this._toggleSelect(id, tile);
            this._selectAnchorId = id || null;
            return;
        }
        const idx = this.items.findIndex((f) => f.id === id);
        if (idx >= 0) photosLightbox.open(this.items, idx);
    },

    /**
     * Toggle selection of an item
     * @param {string} id
     * @param {HTMLDivElement} tile
     */
    _toggleSelect(id, tile) {
        if (this.selected.has(id)) {
            this.selected.delete(id);
            tile.classList.remove('selected');
        } else {
            this.selected.add(id);
            tile.classList.add('selected');
        }
        this._updateSelectionBar();
    },

    /** Show/update selection bar */
    _updateSelectionBar() {
        let bar = document.getElementById('photos-selection-bar');

        if (this.selected.size === 0) {
            this._hideSelectionBar();
            return;
        }

        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'photos-selection-bar';
            bar.className = 'photos-selection-bar';
            document.body.appendChild(bar);
        }

        const count = this.selected.size;
        bar.innerHTML = `
            <span class="selection-count">${count} ${i18n.t('photos.items_selected')}</span>
            <button id="photos-sel-download" title="Download"><i class="fas fa-download"></i></button>
            <button id="photos-sel-delete" title="Delete"><i class="fas fa-trash"></i></button>
            <button id="photos-sel-clear" title="Clear"><i class="fas fa-times"></i></button>
        `;

        const bar_clear = /** @type {HTMLButtonElement} */ (bar.querySelector('#photos-sel-clear'));
        if (bar_clear) {
            bar_clear.onclick = () => {
                this.selected.clear();
                this._container.querySelectorAll('.photo-tile.selected').forEach((t) => {
                    t.classList.remove('selected');
                });
                this._hideSelectionBar();
            };
        }

        const bar_delete = /** @type {HTMLButtonElement} */ (bar.querySelector('#photos-sel-delete'));
        if (bar_delete) {
            bar_delete.onclick = async () => {
                const ok = await Modal.confirmDialog({
                    title: i18n.t('photos.delete_title'),
                    message: i18n.t('photos.delete_selected_confirm'),
                    confirmText: i18n.t('actions.delete'),
                    icon: 'fa-trash'
                });
                if (!ok) return;

                // One batch request per chunk instead of one DELETE per photo.
                // The photos view is files-only, so every id is a file id.
                const ids = [...this.selected];
                const CHUNK_SIZE = 1000; // backend MAX_BATCH_SIZE
                const trashed = new Set();

                try {
                    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
                        const chunk = ids.slice(i, i + CHUNK_SIZE);
                        const response = await fetch('/api/batch/trash', {
                            method: 'POST',
                            credentials: 'include',
                            headers: this._headers(true),
                            body: JSON.stringify({ file_ids: chunk, folder_ids: [] })
                        });
                        // 200 = all trashed, 206 = partial; both carry `successful`.
                        if (!response.ok && response.status !== 206) {
                            console.error('Batch trash failed:', response.status);
                            continue;
                        }
                        const data = await response.json();
                        const ok = Array.isArray(data?.successful) ? data.successful : chunk;
                        for (const id of ok) trashed.add(id);
                    }
                } catch (err) {
                    console.error('Batch trash error:', err);
                }

                if (trashed.size > 0) {
                    this.items = this.items.filter((f) => !trashed.has(f.id));
                    for (const id of trashed) this.selected.delete(id);
                    this._renderFull();
                }
                // Refresh (or hide) the bar to reflect any items left selected.
                this._updateSelectionBar();
            };
        }

        const bar_download = /** @type {HTMLButtonElement} */ (bar.querySelector('#photos-sel-download'));
        if (bar_download) {
            bar_download.onclick = async () => {
                for (const fid of this.selected) {
                    const a = document.createElement('a');
                    a.href = `/api/files/${fid}`;
                    a.download = '';
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                }
            };
        }

        bar.style.display = 'flex';
    },

    _hideSelectionBar() {
        const bar = document.getElementById('photos-selection-bar');
        if (bar) bar.style.display = 'none';
    },

    /** @param {boolean} show */
    _showLoading(show) {
        if (!this._container) return;
        let loader = this._container.querySelector('.photos-loading');
        if (show && !loader) {
            loader = document.createElement('div');
            loader.className = 'photos-loading';
            loader.innerHTML = '<i class="fas fa-spinner"></i> Loading...';
            this._container.appendChild(loader);
        } else if (!show && loader) {
            loader.remove();
        }
    },

    _destroyObserver() {
        if (this._materializeObserver) {
            this._materializeObserver.disconnect();
            this._materializeObserver = null;
        }
        if (this._sentinelObserver) {
            this._sentinelObserver.disconnect();
            this._sentinelObserver = null;
        }
    },

    /** @param {any} s */
    _escHtml(s) {
        const d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
    },

    /** @param {any} s */
    _escAttr(s) {
        return String(s || '')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;');
    }
};

photosLightbox.setPhotosView(photosView);

export { photosView };
