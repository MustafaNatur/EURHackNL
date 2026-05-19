import {
    METRIC_CATALOGUE,
    LONELINESS_KEYS,
    PUBLIC_PLACE_CATALOGUE,
    SOCIAL_PLACES_KEYS
} from '../models/DistrictData.js';
import { RecommendationView } from './RecommendationView.js';
import { LumaModal } from './LumaModal.js';

/**
 * SidebarController
 * -----------------
 * Owns the right-hand info panel. Two top-level screens:
 *
 *   stats           - the existing "Health & loneliness" / "Public places"
 *                     tabbed view of the selected neighborhood.
 *   recommendations - drill-in AI recommendations for the same buurt,
 *                     reached via the AI CTA in the stats body. The
 *                     panel keeps the same geometry; only the header
 *                     actions and the body morph.
 *
 * Inside `stats`, two sub-views are toggleable via tabs:
 *   - VIEW_HEALTH : metrics
 *   - VIEW_PLACES : public-place counts
 *
 * The recommendations screen is rendered by RecommendationView; this
 * controller only owns state and DOM lifecycle.
 */
export class SidebarController {
    static VIEW_HEALTH = 'health';
    static VIEW_PLACES = 'places';

    static SCREEN_STATS = 'stats';
    static SCREEN_RECS  = 'recommendations';

    /** @param {string} rootId */
    constructor(rootId) {
        this._root = document.getElementById(rootId);
        if (!this._root) {
            throw new Error(`Sidebar root #${rootId} not found in DOM`);
        }
        /** @type {'health'|'places'} */
        this._activeView = SidebarController.VIEW_HEALTH;
        /** @type {'stats'|'recommendations'} */
        this._screen = SidebarController.SCREEN_STATS;
        /** Last rendered data, kept so we can re-render on tab switch or back. */
        this._lastData = null;
        /** Last recommendations rendered, so click handlers can resolve indices. */
        this._lastRecs = null;
        /** @type {((data: any) => void) | null} */
        this._onAnalyze = null;
        /** @type {((rec: any) => void) | null} */
        this._onSaveEvent = null;
        this._installSkeleton();
    }

    /** @private */
    _installSkeleton() {
        this._root.classList.add('sidebar');
        this._root.innerHTML = `
            <button type="button" class="sidebar__close" aria-label="Close panel">&times;</button>
            <header class="sidebar__header">
                <button type="button" class="sidebar__back" data-role="back" hidden>
                    <span class="sidebar__back-arrow" aria-hidden="true">←</span>
                    Back to indicators
                </button>
                <span class="sidebar__eyebrow" data-role="eyebrow">Rotterdam neighborhood</span>
                <h2 class="sidebar__title" data-role="title">—</h2>
                <p class="sidebar__subtitle" data-role="subtitle"></p>
                <div class="tabs" role="tablist" data-role="tabs">
                    <button type="button" role="tab" data-view="${SidebarController.VIEW_HEALTH}"
                            class="tabs__btn tabs__btn--active" aria-selected="true">
                        Health &amp; loneliness
                    </button>
                    <button type="button" role="tab" data-view="${SidebarController.VIEW_PLACES}"
                            class="tabs__btn" aria-selected="false">
                        Public places
                    </button>
                </div>
            </header>
            <div class="sidebar__body" data-role="body"></div>
            <footer class="sidebar__footer" data-role="footer"></footer>
        `;

        this._titleEl    = this._root.querySelector('[data-role="title"]');
        this._subtitleEl = this._root.querySelector('[data-role="subtitle"]');
        this._eyebrowEl  = this._root.querySelector('[data-role="eyebrow"]');
        this._bodyEl     = this._root.querySelector('[data-role="body"]');
        this._footerEl   = this._root.querySelector('[data-role="footer"]');
        this._tabsEl     = this._root.querySelector('[data-role="tabs"]');
        this._backBtn    = this._root.querySelector('[data-role="back"]');
        this._closeBtn   = this._root.querySelector('.sidebar__close');

        this._closeBtn.addEventListener('click', () => this.hide());
        this._backBtn.addEventListener('click', () => this._navigateBack());
        this._tabsEl.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-view]');
            if (!btn) return;
            this._setActiveView(btn.dataset.view);
        });

        // Delegated handlers for body interactions. We listen on the
        // stable body element so innerHTML swaps don't drop the wiring.
        this._bodyEl.addEventListener('click', (e) => {
            const analyze = e.target.closest('[data-role="analyze"]');
            if (analyze && !analyze.disabled) {
                this._emitAnalyze();
                return;
            }
            const host = e.target.closest('[data-role="host-luma"]');
            if (host) {
                this._openLumaForCard(host);
                return;
            }
            const save = e.target.closest('[data-role="save-event"]');
            if (save && !save.disabled) {
                this._saveEventFromCard(save);
                return;
            }
        });
    }

    /** @private */
    _saveEventFromCard(buttonEl) {
        if (!this._lastRecs || !this._onSaveEvent) return;
        const idx = Number(buttonEl.getAttribute('data-rec-index'));
        if (!Number.isFinite(idx)) return;
        const rec = this._lastRecs[idx];
        if (!rec || rec.kind !== 'event') return;
        try {
            this._onSaveEvent(rec);
            // Reflect "saved" state on the card so the user doesn't
            // double-click a second time. Disable + swap label only;
            // the card itself stays interactive (Luma button still works).
            buttonEl.disabled = true;
            buttonEl.classList.add('save-event-btn--saved');
            const labelEl = buttonEl.querySelector('.save-event-btn__label');
            if (labelEl) labelEl.textContent = 'Saved to registry';
        } catch (err) {
            console.error('Sidebar: save-to-registry handler threw', err);
        }
    }

    /** @private */
    _openLumaForCard(buttonEl) {
        if (!this._lastRecs) return;
        const idx = Number(buttonEl.getAttribute('data-rec-index'));
        if (!Number.isFinite(idx)) return;
        const rec = this._lastRecs[idx];
        if (!rec || rec.kind !== 'event') return;
        LumaModal.show(rec, {
            districtName:   this._lastData?.districtName,
            parentDistrict: this._lastData?.meta?.parentDistrict
        });
    }

    hide() {
        this._root.classList.remove('sidebar--open');
        this._setScreen(SidebarController.SCREEN_STATS);
        // Drop cached district state so external triggers (e.g. the
        // year-scrub timeline) don't silently re-open a closed panel.
        this._lastData = null;
        this._lastRecs = null;
    }

    /**
     * Register a callback fired when the user taps the AI CTA. The
     * callback receives the last data the sidebar rendered (same shape
     * as `renderData`'s argument).
     * @param {(data: any) => void} callback
     */
    onAnalyzeRequested(callback) {
        this._onAnalyze = callback;
    }

    /**
     * Register a callback fired when the user taps "Save to registry"
     * on an event-kind recommendation card. The callback receives the
     * full `EventRecommendation` object so the host can decide how to
     * persist it.
     * @param {(rec: any) => void} callback
     */
    onSaveEventRequested(callback) {
        this._onSaveEvent = callback;
    }

    /**
     * Which top-level screen the sidebar is currently showing.
     * Useful to consumers that want to refresh the stats screen without
     * disrupting an active recommendations drill-in.
     * @returns {'stats'|'recommendations'}
     */
    get screen() {
        return this._screen;
    }

    /**
     * The id of the currently-rendered district, or `null` when nothing
     * is loaded yet. Mirrors `_lastData.districtId` without exposing the
     * full internal state.
     * @returns {string|null}
     */
    get selectedDistrictId() {
        return this._lastData?.districtId ?? null;
    }

    /**
     * Name of the currently-rendered district, or `null`. Used by the
     * "Save to registry" flow which records the buurt name on the event.
     * @returns {string|null}
     */
    get selectedDistrictName() {
        return this._lastData?.districtName ?? null;
    }

    /**
     * @param {string} districtName
     * @param {{category?: string, parentDistrict?: string}} [meta]
     */
    showLoading(districtName, meta = {}) {
        this._lastData = null;
        this._lastRecs = null;
        this._setScreen(SidebarController.SCREEN_STATS);
        this._root.classList.add('sidebar--open');
        this._titleEl.textContent = districtName;
        this._subtitleEl.innerHTML = SidebarController._renderSubtitle(meta);
        this._bodyEl.innerHTML = `
            <div class="loading">
                <div class="loading__spinner" role="status" aria-label="Loading"></div>
                <p class="loading__label">Loading neighborhood data</p>
            </div>
        `;
        this._footerEl.innerHTML = '';
    }

    /**
     * @param {import('../models/DistrictData.js').DistrictData & {
     *   meta?: {category?: string, isInhabited?: boolean, population?: number, parentDistrict?: string},
     *   publicPlaces?: {key:string, count:number}[]
     * }} data
     */
    renderData(data) {
        this._lastData = data;
        this._lastRecs = null;
        const meta = data.meta ?? {};
        this._setScreen(SidebarController.SCREEN_STATS);
        this._root.classList.add('sidebar--open');
        this._titleEl.textContent = data.districtName;
        this._subtitleEl.innerHTML = SidebarController._renderSubtitle(meta, data.year);
        this._footerEl.innerHTML = SidebarController._renderFooter(data);
        this._renderActiveView();
    }

    // ----------------------------------------------------------------
    //  Recommendations screen
    // ----------------------------------------------------------------

    /**
     * Switch to the recommendations screen and show the AI staged loader
     * at the given stage id (one of AI_STAGES[].id).
     * @param {string} stageId
     */
    showRecommendationsLoading(stageId) {
        this._setScreen(SidebarController.SCREEN_RECS);
        this._bodyEl.innerHTML = RecommendationView.renderLoader(stageId);
    }

    /**
     * @param {import('../models/RecommendationData.js').Recommendation[]} recs
     */
    showRecommendations(recs) {
        this._setScreen(SidebarController.SCREEN_RECS);
        this._lastRecs = recs;
        // Forward the buurt's outreach inventory and population so the
        // view can render the "How to reach" inventory grid and the
        // summary counters next to the AI cards.
        const ctx = {
            outreachChannels: this._lastData?.outreachChannels ?? [],
            population:       this._lastData?.meta?.population ?? 0
        };
        this._bodyEl.innerHTML = RecommendationView.renderRecommendations(recs, ctx);
        this._bodyEl.scrollTop = 0;
    }

    /**
     * @param {Error|string} err
     */
    showRecommendationsError(err) {
        this._setScreen(SidebarController.SCREEN_RECS);
        const msg = err instanceof Error ? err.message : String(err);
        this._bodyEl.innerHTML = RecommendationView.renderError(msg);
    }

    /** @private */
    _navigateBack() {
        if (this._lastData) {
            this.renderData(this._lastData);
        } else {
            this._setScreen(SidebarController.SCREEN_STATS);
            this._bodyEl.innerHTML = '';
        }
    }

    /** @private */
    _emitAnalyze() {
        if (!this._onAnalyze || !this._lastData) return;
        this._onAnalyze(this._lastData);
    }

    // ----------------------------------------------------------------
    //  Screen / view state
    // ----------------------------------------------------------------

    /** @private */
    _setScreen(screen) {
        if (screen === this._screen) {
            // Still re-sync DOM state in case it diverged.
        }
        this._screen = screen;
        const onRecs = screen === SidebarController.SCREEN_RECS;
        this._root.classList.toggle('sidebar--screen-rec', onRecs);
        this._tabsEl.hidden = onRecs;
        this._backBtn.hidden = !onRecs;
        // Belt-and-suspenders: the tab buttons share the `data-view`
        // attribute namespace with the router's top-level views, so a
        // stray global `[data-view]` selector elsewhere can flip them
        // to hidden. Re-assert visibility whenever we (re)enter stats.
        if (!onRecs) {
            for (const btn of this._tabsEl.querySelectorAll('[data-view]')) {
                btn.hidden = false;
            }
        }
        this._eyebrowEl.textContent = onRecs
            ? 'AI assistant'
            : 'Rotterdam neighborhood';
    }

    /** @private */
    _setActiveView(view) {
        if (view !== SidebarController.VIEW_HEALTH && view !== SidebarController.VIEW_PLACES) return;
        if (view === this._activeView) return;
        this._activeView = view;

        for (const btn of this._tabsEl.querySelectorAll('[data-view]')) {
            const active = btn.dataset.view === view;
            btn.classList.toggle('tabs__btn--active', active);
            btn.setAttribute('aria-selected', active ? 'true' : 'false');
        }
        if (this._lastData) this._renderActiveView();
    }

    /** @private */
    _renderActiveView() {
        if (!this._lastData) return;
        const cta = SidebarController._renderAnalyzeCta(this._lastData);
        const body = this._activeView === SidebarController.VIEW_HEALTH
            ? SidebarController._renderHealthView(this._lastData)
            : SidebarController._renderPlacesView(this._lastData);
        this._bodyEl.innerHTML = `${cta}${body}`;
        this._bodyEl.scrollTop = 0;
    }

    // ----------------------------------------------------------------
    //  AI CTA
    // ----------------------------------------------------------------

    /** @private */
    static _renderAnalyzeCta(data) {
        const cat = data.meta?.category ?? 'residential';
        const isResidential = cat === 'residential';
        const disabledAttr = isResidential ? '' : 'disabled';
        const titleAttr = isResidential
            ? 'Generate AI-tailored interventions for this buurt'
            : 'Few residents — analysis is not meaningful for this area type';
        const hint = isResidential
            ? 'Generate tailored interventions for this neighborhood'
            : 'Analysis is reserved for residential buurten';
        return `
            <button type="button" class="ai-cta" data-role="analyze"
                    title="${titleAttr}" ${disabledAttr}>
                <span class="ai-cta__sparkle" aria-hidden="true">✦</span>
                <span class="ai-cta__text">
                    <span class="ai-cta__title">Analyze and propose enhancements</span>
                    <span class="ai-cta__hint">${hint}</span>
                </span>
                <span class="ai-cta__arrow" aria-hidden="true">→</span>
            </button>
        `;
    }

    // ----------------------------------------------------------------
    //  Health view
    // ----------------------------------------------------------------

    /** @private */
    static _renderHealthView(data) {
        const meta = data.meta ?? {};
        const loneliness = SidebarController._lonelinessScore(data.metrics);
        const groups = SidebarController._groupMetrics(data.metrics);
        return `
            ${SidebarController._renderCategoryNotice(meta)}
            ${SidebarController._renderLonelinessBadge(loneliness)}
            ${groups.map(g => SidebarController._renderGroup(g)).join('')}
        `;
    }

    /** @private */
    static _lonelinessScore(metrics) {
        const vals = LONELINESS_KEYS.map(k => metrics[k]).filter(v => Number.isFinite(v));
        if (vals.length === 0) return 0;
        const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
        return Math.round(avg * 10) / 10;
    }

    /** @private */
    static _lonelinessTier(score) {
        if (score >= 45) return { className: 'badge--high',   label: 'High loneliness' };
        if (score >= 30) return { className: 'badge--medium', label: 'Moderate loneliness' };
        return { className: 'badge--low', label: 'Lower loneliness' };
    }

    /** @private */
    static _renderLonelinessBadge(score) {
        const tier = SidebarController._lonelinessTier(score);
        const pct = Math.max(0, Math.min(100, score));
        return `
            <section class="badge ${tier.className}">
                <div class="badge__ring" style="--pct:${pct}">
                    <span class="badge__value">${score.toFixed(1)}<small>%</small></span>
                </div>
                <div class="badge__meta">
                    <span class="badge__label">${tier.label}</span>
                    <span class="badge__hint">Composite of lonely, severely, emotionally &amp; socially lonely</span>
                </div>
            </section>
        `;
    }

    /** @private */
    static _groupMetrics(metrics) {
        const order = ['Loneliness', 'Social', 'Mental', 'Physical'];
        const grouped = new Map(order.map(name => [name, []]));
        for (const def of METRIC_CATALOGUE) {
            const value = metrics[def.key];
            grouped.get(def.group)?.push({ ...def, value });
        }
        return Array.from(grouped.entries())
            .filter(([, rows]) => rows.length > 0)
            .map(([name, rows]) => ({ name, rows }));
    }

    /** @private */
    static _renderGroup(group) {
        return `
            <section class="group">
                <h3 class="group__title">${group.name}</h3>
                <ul class="metric-list">
                    ${group.rows.map(SidebarController._renderMetric).join('')}
                </ul>
            </section>
        `;
    }

    /** @private */
    static _renderMetric(row) {
        const v = Number.isFinite(row.value) ? row.value : 0;
        const pct = Math.max(0, Math.min(100, v));
        const toneClass = SidebarController._toneClass(row, v);
        return `
            <li class="metric">
                <div class="metric__head">
                    <span class="metric__label">${row.label}</span>
                    <span class="metric__value">${v.toFixed(1)}%</span>
                </div>
                <div class="metric__bar">
                    <span class="metric__bar-fill ${toneClass}" style="width:${pct}%"></span>
                </div>
            </li>
        `;
    }

    /** @private */
    static _toneClass(row, value) {
        const high = row.highIsBad ? value >= 50 : value < 30;
        const mid  = row.highIsBad ? value >= 30 : value < 50;
        if (high) return 'metric__bar-fill--bad';
        if (mid)  return 'metric__bar-fill--warn';
        return 'metric__bar-fill--good';
    }

    // ----------------------------------------------------------------
    //  Public places view
    // ----------------------------------------------------------------

    /** @private */
    static _renderPlacesView(data) {
        const counts = new Map((data.publicPlaces ?? []).map(p => [p.key, p.count]));
        const social = SOCIAL_PLACES_KEYS.reduce((sum, k) => sum + (counts.get(k) ?? 0), 0);
        const total  = (data.publicPlaces ?? []).reduce((sum, p) => sum + p.count, 0);
        const meta   = data.meta ?? {};

        const maxCount = Math.max(1, ...PUBLIC_PLACE_CATALOGUE.map(d => counts.get(d.key) ?? 0));

        const groups = SidebarController._groupPlaces(counts);

        return `
            ${SidebarController._renderCategoryNotice(meta)}
            <section class="places-summary">
                <div class="places-summary__row">
                    <div class="places-summary__stat">
                        <span class="places-summary__num">${social}</span>
                        <span class="places-summary__lbl">Loneliness-reducing venues</span>
                    </div>
                    <div class="places-summary__stat">
                        <span class="places-summary__num">${total}</span>
                        <span class="places-summary__lbl">All public places</span>
                    </div>
                </div>
                <p class="places-summary__note">
                    Categories marked
                    <span class="dot dot--good"></span> are positively associated with reduced loneliness,
                    <span class="dot dot--warn"></span> are context-dependent, and
                    <span class="dot dot--neutral"></span> have weak or indirect links.
                </p>
            </section>
            ${groups.map(g => SidebarController._renderPlaceGroup(g, maxCount)).join('')}
        `;
    }

    /** @private */
    static _groupPlaces(counts) {
        const order = [
            { id: 'reduces', title: 'Strongly social' },
            { id: 'mixed',   title: 'Context-dependent' },
            { id: 'neutral', title: 'General infrastructure' }
        ];
        return order.map(g => ({
            ...g,
            rows: PUBLIC_PLACE_CATALOGUE
                .filter(def => def.influence === g.id)
                .map(def => ({ ...def, count: counts.get(def.key) ?? 0 }))
        })).filter(g => g.rows.length > 0);
    }

    /** @private */
    static _renderPlaceGroup(group, maxCount) {
        return `
            <section class="group">
                <h3 class="group__title">${group.title}</h3>
                <ul class="places">
                    ${group.rows.map(r => SidebarController._renderPlace(r, maxCount)).join('')}
                </ul>
            </section>
        `;
    }

    /** @private */
    static _renderPlace(row, maxCount) {
        const pct = Math.round((row.count / maxCount) * 100);
        const tone = row.influence === 'reduces' ? 'good'
                   : row.influence === 'mixed'   ? 'warn'
                   : 'neutral';
        return `
            <li class="place">
                <div class="place__head">
                    <span class="place__icon" aria-hidden="true">${row.icon}</span>
                    <span class="place__label">${row.label}</span>
                    <span class="place__count">${row.count}</span>
                </div>
                <div class="place__bar">
                    <span class="place__bar-fill place__bar-fill--${tone}" style="width:${pct}%"></span>
                </div>
            </li>
        `;
    }

    // ----------------------------------------------------------------
    //  Shared bits
    // ----------------------------------------------------------------

    /** @private */
    static _renderSubtitle(meta, year) {
        const parts = [];
        if (year) parts.push(`Survey year ${year}`);
        if (meta?.parentDistrict) parts.push(`part of <strong>${meta.parentDistrict}</strong>`);
        return parts.join(' &middot; ');
    }

    /** @private */
    static _renderCategoryNotice(meta) {
        const cat = meta?.category ?? 'residential';
        if (cat === 'residential') return '';
        const messages = {
            harbour: {
                title: 'Harbour & port area.',
                body: 'Refineries, terminals or docks — few residents live here.'
            },
            business: {
                title: 'Business park.',
                body: 'Offices and light industry — very few residents live here.'
            },
            green: {
                title: 'Park or rural area.',
                body: 'Predominantly green space (forest, lake, farmland).'
            }
        };
        const m = messages[cat];
        if (!m) return '';
        return `
            <div class="notice notice--muted">
                <strong>${m.title}</strong> ${m.body}
            </div>
        `;
    }

    /** @private */
    static _renderFooter(data) {
        const [lng, lat] = data.centroid;
        const pop = data.meta?.population;
        const popRow = Number.isFinite(pop) && pop > 0 ? `
            <div class="footer-row">
                <span class="footer-label">Population</span>
                <code class="footer-value">${pop.toLocaleString()}</code>
            </div>` : '';
        return `
            <div class="footer-row">
                <span class="footer-label">CBS buurtcode</span>
                <code class="footer-value">${data.districtId}</code>
            </div>
            ${popRow}
            <div class="footer-row">
                <span class="footer-label">Centroid</span>
                <code class="footer-value">${lat.toFixed(5)}, ${lng.toFixed(5)}</code>
            </div>
        `;
    }
}
