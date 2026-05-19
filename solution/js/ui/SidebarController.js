import {
    METRIC_CATALOGUE,
    LONELINESS_KEYS,
    PUBLIC_PLACE_CATALOGUE,
    SOCIAL_PLACES_KEYS
} from '../models/DistrictData.js';

/**
 * SidebarController
 * -----------------
 * Owns the right-hand info panel. Three states:
 *   - hidden  : initial state, off-screen
 *   - loading : neighborhood selected, request in flight (spinner)
 *   - data    : data rendered
 *
 * The panel offers two views — "Health & loneliness" and "Public places" —
 * controlled by a segmented tab control. The view choice is remembered so
 * the user can compare the same view across different neighborhoods.
 */
export class SidebarController {
    static VIEW_HEALTH = 'health';
    static VIEW_PLACES = 'places';

    /** @param {string} rootId */
    constructor(rootId) {
        this._root = document.getElementById(rootId);
        if (!this._root) {
            throw new Error(`Sidebar root #${rootId} not found in DOM`);
        }
        /** @type {'health'|'places'} */
        this._activeView = SidebarController.VIEW_HEALTH;
        /** Last rendered data, kept so we can re-render on tab switch. */
        this._lastData = null;
        this._installSkeleton();
    }

    /** @private */
    _installSkeleton() {
        this._root.classList.add('sidebar');
        this._root.innerHTML = `
            <button type="button" class="sidebar__close" aria-label="Close panel">&times;</button>
            <header class="sidebar__header">
                <span class="sidebar__eyebrow">Rotterdam neighborhood</span>
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
        this._bodyEl     = this._root.querySelector('[data-role="body"]');
        this._footerEl   = this._root.querySelector('[data-role="footer"]');
        this._tabsEl     = this._root.querySelector('[data-role="tabs"]');
        this._closeBtn   = this._root.querySelector('.sidebar__close');

        this._closeBtn.addEventListener('click', () => this.hide());
        this._tabsEl.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-view]');
            if (!btn) return;
            this._setActiveView(btn.dataset.view);
        });
    }

    hide() {
        this._root.classList.remove('sidebar--open');
    }

    /**
     * @param {string} districtName
     * @param {{category?: string, parentDistrict?: string}} [meta]
     */
    showLoading(districtName, meta = {}) {
        this._lastData = null;
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
        const meta = data.meta ?? {};
        this._root.classList.add('sidebar--open');
        this._titleEl.textContent = data.districtName;
        this._subtitleEl.innerHTML = SidebarController._renderSubtitle(meta, data.year, data.source);
        this._footerEl.innerHTML = SidebarController._renderFooter(data);
        this._renderActiveView();
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
        if (this._activeView === SidebarController.VIEW_HEALTH) {
            this._bodyEl.innerHTML = SidebarController._renderHealthView(this._lastData);
        } else {
            this._bodyEl.innerHTML = SidebarController._renderPlacesView(this._lastData);
        }
        this._bodyEl.scrollTop = 0;
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
                    Counts are illustrative. Categories marked
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
    static _renderSubtitle(meta, year, source) {
        const parts = [];
        if (year) parts.push(`Survey year ${year}`);
        if (meta?.parentDistrict) parts.push(`part of <strong>${meta.parentDistrict}</strong>`);
        parts.push(SidebarController._sourceLabel(source));
        return parts.join(' &middot; ');
    }

    /** @private */
    static _sourceLabel(source) {
        switch (source) {
            case 'csv':         return 'Source: <strong>CSV survey data</strong>';
            case 'csv-partial': return 'Source: CSV survey data (partial)';
            case 'generated':   return 'Source: simulated';
            case 'missing':     return 'Source: unavailable';
            default:            return 'Source: local database';
        }
    }

    /** @private */
    static _renderCategoryNotice(meta) {
        const cat = meta?.category ?? 'residential';
        if (cat === 'residential') return '';
        const messages = {
            harbour: {
                title: 'Harbour & port area.',
                body: 'Refineries, terminals or docks. Indicators are shown for consistency but apply to only a handful of residents.'
            },
            business: {
                title: 'Business park.',
                body: 'Offices and light industry. Very few people live here, so the indicators are mostly illustrative.'
            },
            green: {
                title: 'Park or rural area.',
                body: 'Predominantly green space (forest, lake, farmland). Indicators are illustrative only.'
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
        const sourceText = SidebarController._sourceDescriptor(data.source);
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
            <div class="footer-row">
                <span class="footer-label">Data source</span>
                <span class="footer-value footer-value--plain">${sourceText}</span>
            </div>
        `;
    }

    /** @private */
    static _sourceDescriptor(source) {
        switch (source) {
            case 'csv':         return 'CSV survey 2018-2022';
            case 'csv-partial': return 'CSV (partial)';
            case 'generated':   return 'Simulated';
            case 'missing':     return '—';
            default:            return 'Local database';
        }
    }
}
