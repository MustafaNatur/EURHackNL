import { FilterPanelView }     from './FilterPanelView.js';
import { RadarChartView }      from './RadarChartView.js';
import { TrendChartView }      from './TrendChartView.js';
import { EventsTabView }       from './EventsTabView.js';
import { AudiencesTabView }    from './AudiencesTabView.js';
import { METRIC_CATALOGUE }    from '../models/DistrictData.js';
import { DEFAULT_BENCHMARK }   from '../models/BenchmarkData.js';
import { AGE_GROUPS, GENDERS } from '../models/DemographicData.js';

/**
 * AnalyticsDashboard
 * ------------------
 * Root controller for the `#analytics` route. Renders the three-tab
 * surface — Insights · Events · Audiences — plus the shared filter
 * rail that the Insights tab consumes.
 *
 * Mount lifecycle:
 *   1. `mount(container)` — DOM is built, services are warmed up.
 *      DemographicService.load() is awaited (lazy: only happens on
 *      first visit to the route).
 *   2. While mounted, filter + tab interactions stay in this controller
 *      and never bubble out to the router.
 *   3. `unmount()` — DOM is removed, sub-views released.
 *
 * Insights tab is fully functional in this version. Events and
 * Audiences tabs are intentional placeholders pending Phase 3 / Phase 4;
 * they explain what's coming and link back to the map view.
 */
export class AnalyticsDashboard {
    /**
     * @param {{
     *   geoService:         any,
     *   dataService:        any,
     *   demographicService: any,
     *   eventStore:         any,
     *   aiService:          any
     * }} services
     */
    constructor(services) {
        this._services = services;
        /** @type {HTMLElement|null} */
        this._root = null;
        /** @type {'insights'|'events'|'audiences'} */
        this._activeTab = 'insights';

        /** @type {string|null} preferred buurt to focus when mounting */
        this._preferredDistrictId = null;

        this._filterPanel = null;
        this._radar       = null;
        this._trend       = null;
        /** @type {EventsTabView|null} */
        this._events     = null;
        /** @type {AudiencesTabView|null} */
        this._audiences  = null;

        this._mounted = false;
    }

    /**
     * Called from the map view whenever a buurt is selected, so that
     * opening Analytics pre-loads that buurt instead of the first one
     * in the dropdown.
     *
     * @param {string} districtId
     */
    setPreferredDistrict(districtId) {
        if (!districtId) return;
        this._preferredDistrictId = districtId;
        if (this._mounted && this._filterPanel) {
            this._filterPanel.setDistrict(districtId);
        }
    }

    /** @param {'insights'|'events'|'audiences'} tab */
    setActiveTab(tab) {
        if (!['insights', 'events', 'audiences'].includes(tab)) return;
        this._activeTab = tab;
        if (this._mounted) this._renderActiveTab();
    }

    async mount(container) {
        if (this._mounted) return;
        const root = document.createElement('div');
        root.className = 'analytics';
        root.innerHTML = `
            <div class="analytics__tabs" role="tablist" aria-label="Analytics sub-views">
                <button type="button" role="tab" class="analytics__tab" data-tab="insights">
                    <span class="analytics__tab-icon" aria-hidden="true">📈</span>
                    <span>
                        <span class="analytics__tab-label">Insights</span>
                        <span class="analytics__tab-hint">Identify — KPIs, benchmark, trend</span>
                    </span>
                </button>
                <button type="button" role="tab" class="analytics__tab" data-tab="events">
                    <span class="analytics__tab-icon" aria-hidden="true">🎉</span>
                    <span>
                        <span class="analytics__tab-label">Events</span>
                        <span class="analytics__tab-hint">Execute &amp; evaluate — registry</span>
                    </span>
                </button>
                <button type="button" role="tab" class="analytics__tab" data-tab="audiences">
                    <span class="analytics__tab-icon" aria-hidden="true">👥</span>
                    <span>
                        <span class="analytics__tab-label">Audiences</span>
                        <span class="analytics__tab-hint">Plan — target population</span>
                    </span>
                </button>
            </div>
            <div class="analytics__body" data-role="tab-body"></div>
        `;
        container.appendChild(root);
        this._root = root;

        for (const btn of root.querySelectorAll('[data-tab]')) {
            btn.addEventListener('click', () => this.setActiveTab(btn.getAttribute('data-tab')));
        }

        // Surface a skeleton state while the demographic file streams in
        // — the file is ~3 MB; the wait is real on first visit.
        this._renderLoadingTab();

        try {
            await this._services.demographicService.load();
        } catch (err) {
            console.error('AnalyticsDashboard: demographic load failed', err);
            this._renderErrorTab(err);
            this._mounted = true;
            return;
        }

        this._mounted = true;
        this._renderActiveTab();
    }

    async unmount() {
        if (!this._mounted) return;
        this._filterPanel?.unmount();
        this._radar?.unmount();
        this._trend?.unmount();
        await this._events?.unmount();
        await this._audiences?.unmount();
        this._filterPanel = null;
        this._radar = null;
        this._trend = null;
        this._events = null;
        this._audiences = null;
        this._root?.remove();
        this._root = null;
        this._mounted = false;
    }

    // ---------------- internals ----------------

    /** @private */
    _renderLoadingTab() {
        const body = this._root?.querySelector('[data-role="tab-body"]');
        if (!body) return;
        body.innerHTML = `
            <div class="analytics__loading">
                <div class="loading__spinner" role="status" aria-label="Loading"></div>
                <p>Streaming the demographic dataset…</p>
                <p class="analytics__loading-hint">First visit only. After this, switching back is instant.</p>
            </div>
        `;
    }

    /** @private */
    _renderErrorTab(err) {
        const body = this._root?.querySelector('[data-role="tab-body"]');
        if (!body) return;
        const message = err instanceof Error ? err.message : String(err);
        body.innerHTML = `
            <div class="analytics__error">
                <h3>Couldn't load demographic data</h3>
                <p>${escapeText(message)}</p>
                <p>Rebuild via <code>python3 solution/scripts/build_database.py</code>.</p>
            </div>
        `;
    }

    /** @private */
    _renderActiveTab() {
        const body = this._root?.querySelector('[data-role="tab-body"]');
        if (!body) return;

        for (const btn of this._root.querySelectorAll('[data-tab]')) {
            const active = btn.getAttribute('data-tab') === this._activeTab;
            btn.classList.toggle('analytics__tab--active', active);
            btn.setAttribute('aria-selected', active ? 'true' : 'false');
        }

        // Sub-views are torn down on every tab switch — they're cheap to
        // build and this keeps Chart.js from leaking canvases between tabs.
        this._filterPanel?.unmount();
        this._radar?.unmount();
        this._trend?.unmount();
        this._events?.unmount();
        this._audiences?.unmount();
        this._filterPanel = null;
        this._radar = null;
        this._trend = null;
        this._events = null;
        this._audiences = null;
        body.innerHTML = '';

        if (this._activeTab === 'insights') {
            this._renderInsights(body);
        } else if (this._activeTab === 'events') {
            this._renderEvents(body);
        } else if (this._activeTab === 'audiences') {
            this._renderAudiences(body);
        }
    }

    /** @private */
    async _renderEvents(body) {
        this._events = new EventsTabView({
            eventStore:  this._services.eventStore,
            dataService: this._services.dataService,
            aiService:   this._services.aiService
        });
        await this._events.mount(body);
    }

    /** @private */
    async _renderAudiences(body) {
        this._audiences = new AudiencesTabView({
            demographicService: this._services.demographicService,
            aiService:          this._services.aiService,
            eventStore:         this._services.eventStore
        });
        await this._audiences.mount(body);
    }

    /** @private */
    _renderInsights(body) {
        const dem = this._services.demographicService;
        const districts = dem.listDistricts();
        const initialDistrictId = this._preferredDistrictId
            && districts.some(d => d.districtId === this._preferredDistrictId)
            ? this._preferredDistrictId
            : (districts[0]?.districtId ?? null);

        const layout = document.createElement('div');
        layout.className = 'analytics-insights';
        layout.innerHTML = `
            <div class="analytics-insights__rail" data-slot="filters"></div>
            <div class="analytics-insights__main">
                <div data-slot="radar"></div>
                <div data-slot="trend"></div>
            </div>
        `;
        body.appendChild(layout);

        this._filterPanel = new FilterPanelView({
            districts,
            years: dem.getYears(),
            ages: dem.getAgeGroups(),
            genders: dem.getGenders(),
            initialDistrictId,
            initialYear: this._services.dataService.getDefaultYear?.()
                ?? dem.getYears().at(-1)
        });
        this._filterPanel.mount(layout.querySelector('[data-slot="filters"]'));

        this._radar = new RadarChartView();
        this._radar.mount(layout.querySelector('[data-slot="radar"]'));

        this._trend = new TrendChartView();
        this._trend.mount(layout.querySelector('[data-slot="trend"]'));

        this._filterPanel.addEventListener('filterchange', () => this._refreshCharts());
        this._trend.addEventListener('metricchange', () => this._refreshTrend());

        // Initial render.
        this._refreshCharts();
    }

    /** @private */
    _refreshCharts() {
        const dem = this._services.demographicService;
        const fp  = this._filterPanel;
        if (!fp) return;
        const state = fp.getState();
        if (!state.districtId) return;

        // Radar uses a single snapshot year so it isn't averaged across
        // an extended range — that would smear the most-recent signal.
        const radarFilter = {
            years:   [state.snapshotYear],
            ages:    state.filter.ages,
            genders: state.filter.genders
        };
        const metrics      = dem.getAggregated(state.districtId, radarFilter);
        const cityAverage  = AnalyticsDashboard._buildCityAverages(dem, radarFilter);

        const districtName = (dem.listDistricts()
            .find(d => d.districtId === state.districtId)
            ?? { districtName: 'Selected buurt' }).districtName;

        const filterSummary = AnalyticsDashboard._summariseFilter(state, dem);

        this._radar.update({
            districtName,
            filterSummary: `${state.snapshotYear} · ${filterSummary}`,
            metrics,
            cityAverage,
            benchmark: DEFAULT_BENCHMARK.targets
        });

        this._refreshTrend();
    }

    /** @private */
    _refreshTrend() {
        const dem = this._services.demographicService;
        const fp  = this._filterPanel;
        if (!fp || !this._trend) return;
        const state = fp.getState();
        if (!state.districtId) return;

        const metric = this._trend.activeMetric();
        const districtName = (dem.listDistricts()
            .find(d => d.districtId === state.districtId)
            ?? { districtName: 'Selected buurt' }).districtName;

        const buurtSeries = dem.getTimeSeries(state.districtId, metric, {
            ages:    state.filter.ages,
            genders: state.filter.genders
        }).filter(p => state.filter.years.includes(p.year));

        const citySeries = dem.getCityTimeSeries(metric, {
            ages:    state.filter.ages,
            genders: state.filter.genders
        }).filter(p => state.filter.years.includes(p.year));

        const benchmarkValue = DEFAULT_BENCHMARK.targets[metric];
        const benchmark = Number.isFinite(benchmarkValue)
            ? { value: benchmarkValue, label: DEFAULT_BENCHMARK.name }
            : null;

        this._trend.update({
            districtName,
            filterSummary: AnalyticsDashboard._summariseFilter(state, dem),
            buurtSeries,
            citySeries,
            benchmark
        });
    }

    /** @private */
    static _buildCityAverages(dem, filter) {
        const out = {};
        for (const def of METRIC_CATALOGUE) {
            out[def.key] = dem.getCityAverage(def.key, filter);
        }
        return out;
    }

    /** @private */
    static _summariseFilter(state, dem) {
        const allAges    = dem.getAgeGroups();
        const allGenders = dem.getGenders();
        const ages    = state.filter.ages?.length    === allAges.length    ? 'all ages'    : state.filter.ages.join(', ');
        const genders = state.filter.genders?.length === allGenders.length ? 'all genders' : state.filter.genders.join(', ');
        return `${ages}, ${genders}`;
    }

}

function escapeText(s) {
    return String(s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
}

// Eat unused-import warnings; AGE_GROUPS / GENDERS keep the module
// graph tidy by re-exporting through the dashboard for the placeholder
// views below.
export { AGE_GROUPS, GENDERS };
