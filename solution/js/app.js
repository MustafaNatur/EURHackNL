import { GeoService }            from './services/GeoService.js';
import { DataService }           from './services/DataService.js';
import { DemographicService }    from './services/DemographicService.js';
import { EventStore }            from './services/EventStore.js';
import { AIService }             from './services/AIService.js';
import { MapController }         from './map/MapController.js';
import { SidebarController }     from './ui/SidebarController.js';
import { TimelineController }    from './ui/TimelineController.js';
import { AnalyticsDashboard }    from './ui/AnalyticsDashboard.js';
import { Toast }                 from './ui/Toast.js';
import { Router }                from './router.js';
import { LONELINESS_KEYS }       from './models/DistrictData.js';

/**
 * Composition root.
 *
 * Two top-level views, mounted/unmounted by the hash router:
 *
 *   #map        — existing geography-first explorer (MapController +
 *                  TimelineController + SidebarController).
 *   #analytics  — audience-first analytics surface with three sub-tabs:
 *                  Insights · Events · Audiences (AnalyticsDashboard).
 *
 * Both views share the same singleton services (Geo, Data, Demographic,
 * Event, AI) so an action in one view (e.g. "Save to registry" from a map
 * recommendation card) is immediately visible in the other.
 *
 * The map view fully initialises on first mount and then sleeps when
 * unmounted — its timeline autoplay is paused and the polygons stay
 * rendered (MapLibre keeps the GL context warm), so navigating back is
 * instant. The analytics view is lazy: its DemographicService only
 * fetches the 3 MB demographic JSON when the route is first opened.
 */
async function main() {
    // ----- Shared services (instantiated once, used by both views) -----
    const geoService         = new GeoService();
    const dataService        = new DataService();
    const demographicService = new DemographicService();
    const eventStore         = new EventStore();
    const aiService          = new AIService();

    // ----- Map view DOM + controllers -----
    const sidebar       = new SidebarController('sidebar');
    const mapController = new MapController('map', geoService);
    let   timeline      = null;
    let   fc            = null;
    let   db            = null;

    /** Tracks the in-flight district fetch so a quick re-click cancels the previous render. */
    let activeRequestId   = 0;
    let activeAnalysisId  = 0;
    let selectedCentroid  = null;
    let selectedMeta      = null;
    /** True after `mountMap()` has run its one-shot init. */
    let mapInitialised    = false;

    // ----- Analytics view (lazily attached on first mount) -----
    const analyticsView   = document.getElementById('view-analytics');
    const analytics       = new AnalyticsDashboard({
        geoService,
        dataService,
        demographicService,
        eventStore,
        aiService
    });

    // ----- Router wiring -----
    const router = new Router({ defaultRoute: 'map' });
    router.register('map', {
        mount:   () => mountMap(),
        unmount: () => unmountMap()
    });
    router.register('analytics', {
        mount:   () => mountAnalytics(),
        unmount: () => unmountAnalytics()
    });

    // Bridge from "Save to registry" toasts that fire from the map view
    // to a navigation into the analytics Events tab.
    Toast.onAction('navigate-events', () => {
        analytics.setActiveTab('events');
        router.navigate('analytics');
    });

    // Forward map selections to the analytics view so opening the
    // dashboard "remembers" the buurt the user last clicked on the map.
    mapController.onDistrictSelected(async (districtId, districtName, centroid, meta) => {
        const requestId = ++activeRequestId;
        activeAnalysisId++;
        selectedCentroid = centroid;
        selectedMeta = meta;

        analytics.setPreferredDistrict(districtId);
        sidebar.showLoading(districtName, meta);

        try {
            const data = await dataService.fetchDistrictData(
                districtId,
                districtName,
                centroid,
                {
                    year: timeline?.getCurrentYear() ?? dataService.getDefaultYear(),
                    population: meta?.population
                }
            );
            if (requestId !== activeRequestId) return;
            sidebar.renderData({ ...data, meta });
        } catch (err) {
            if (requestId !== activeRequestId) return;
            console.error('Failed to load district data:', err);
            sidebar.renderData({
                districtId,
                districtName,
                year: timeline?.getCurrentYear() ?? dataService.getDefaultYear(),
                centroid,
                metrics: {},
                meta
            });
        }
    });

    sidebar.onAnalyzeRequested(async (districtData) => {
        const analysisId = ++activeAnalysisId;
        sidebar.showRecommendationsLoading('analyzing');

        try {
            const recs = await aiService.generate(districtData, {
                onStage: (stage) => {
                    if (analysisId !== activeAnalysisId) return;
                    sidebar.showRecommendationsLoading(stage);
                }
            });
            if (analysisId !== activeAnalysisId) return;
            sidebar.showRecommendations(recs);
        } catch (err) {
            if (analysisId !== activeAnalysisId) return;
            console.error('AI analysis failed:', err);
            sidebar.showRecommendationsError(err);
        }
    });

    // When the user saves a recommendation card to the registry, the
    // sidebar emits `save-event-to-registry`. We persist via EventStore
    // and surface a toast with an action to jump into the registry.
    sidebar.onSaveEventRequested((rec) => {
        if (!sidebar.selectedDistrictId) return;
        const districtName = sidebar.selectedDistrictName ?? '';
        try {
            const record = eventStore.fromRecommendation(
                rec,
                sidebar.selectedDistrictId,
                districtName
            );
            eventStore.add(record);
            Toast.show({
                message: `Saved “${record.title}” to the event registry`,
                action: { label: 'Open registry', id: 'navigate-events' }
            });
        } catch (err) {
            console.error('Failed to save recommendation to registry:', err);
            Toast.show({ message: 'Could not save event — see console for details.', tone: 'bad' });
        }
    });

    // ----- Boot the router -----
    try {
        await router.start();
    } catch (err) {
        console.error('Router failed to start:', err);
    }

    // ================================================================
    //  #map mount / unmount
    // ================================================================

    async function mountMap() {
        showView('map');
        if (mapInitialised) {
            // Re-entering the route — no init work needed. The MapLibre
            // canvas keeps rendering, so the user sees the same map state
            // they left.
            return;
        }

        try {
            if (!fc || !db) {
                [fc, db] = await Promise.all([
                    geoService.load(),
                    dataService.load()
                ]);
                enrichFeaturesWithLoneliness(fc, db);
            }
            await mapController.init();
        } catch (err) {
            console.error('Failed to initialise map:', err);
            const mapEl = document.getElementById('map');
            if (mapEl) {
                mapEl.innerHTML =
                    `<div style="padding:24px;color:#b91c1c;">Map failed to load: ${err.message}</div>`;
            }
            return;
        }

        timeline = new TimelineController('map', {
            years: dataService.getYears(),
            initialYear: dataService.getDefaultYear()
        });
        timeline.init();
        mapController.updateCityStats(timeline.getCurrentYear());

        timeline.onYearChange((year) => {
            applyYearToFeatures(fc, year);
            mapController.refreshDistrictSource();
            mapController.updateCityStats(year);

            // Only refresh the sidebar when it's on the stats screen —
            // we don't disrupt an active recommendations drill-in.
            const districtId = sidebar.selectedDistrictId;
            if (!districtId) return;
            if (sidebar.screen !== SidebarController.SCREEN_STATS) return;

            const data = dataService.getDistrictDataSync(districtId, year, {
                centroid: selectedCentroid ?? [0, 0]
            });
            sidebar.renderData({ ...data, meta: selectedMeta ?? {} });
        });

        mapInitialised = true;
    }

    function unmountMap() {
        // We don't tear down MapLibre — keeping it warm makes route
        // transitions instant. But the timeline's autoplay timer must
        // not keep firing while another view is on screen.
        timeline?.pause?.();
        hideView('map');
    }

    // ================================================================
    //  #analytics mount / unmount
    // ================================================================

    async function mountAnalytics() {
        showView('analytics');
        // Ensure the main DB is loaded — Analytics relies on it for the
        // city-average benchmark line and for buurt names in dropdowns.
        if (!db) {
            try {
                db = await dataService.load();
                if (fc) enrichFeaturesWithLoneliness(fc, db);
            } catch (err) {
                console.error('Failed to load core database for analytics:', err);
            }
        }
        await analytics.mount(analyticsView);
    }

    async function unmountAnalytics() {
        await analytics.unmount();
        hideView('analytics');
    }

    // ================================================================
    //  View visibility helper
    // ================================================================

    function showView(name) {
        // Scope to direct children of .layout so sidebar tab buttons
        // (which also carry data-view) are never accidentally hidden.
        for (const el of document.querySelectorAll('.layout > [data-view]')) {
            const active = el.getAttribute('data-view') === name;
            el.hidden = !active;
        }
        document.body.setAttribute('data-active-view', name);
    }

    function hideView(name) {
        const el = document.querySelector(`.layout > [data-view="${name}"]`);
        if (el) el.hidden = true;
    }
}

/**
 * Mutates the GeoJSON FeatureCollection in place, adding:
 *   - `lonelinessByYear`  : { 2018: 32.4, ..., 2026: 38.2 } per buurt
 *   - `lonelinessScore`   : the active year's score (initially the default)
 *   - `lonelinessSource`  : "csv" / "csv-partial" / "generated"
 *
 * Idempotent — safe to call multiple times.
 *
 * @param {GeoJSON.FeatureCollection} fc
 * @param {{
 *   neighborhoods?: Record<string, any>,
 *   years?: number[],
 *   defaultYear?: number
 * }} db
 */
function enrichFeaturesWithLoneliness(fc, db) {
    const records = db?.neighborhoods ?? {};
    const years = Array.isArray(db?.years) && db.years.length > 0
        ? db.years
        : [db?.defaultYear ?? db?.year ?? new Date().getFullYear()];
    const defaultYear = db?.defaultYear ?? db?.year ?? years[years.length - 1];

    const score = (metrics) => {
        if (!metrics) return null;
        const vals = LONELINESS_KEYS
            .map(k => metrics[k])
            .filter(v => Number.isFinite(v));
        if (vals.length === 0) return null;
        const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
        return Math.round(avg * 10) / 10;
    };

    for (const feat of fc.features) {
        const id = feat.properties?.id;
        if (!id) continue;
        const rec = records[id];
        if (!rec) continue;

        const byYear = {};
        if (rec.metricsByYear) {
            for (const year of years) {
                const s = score(rec.metricsByYear[String(year)]);
                if (s != null) byYear[year] = s;
            }
        } else if (rec.metrics) {
            const s = score(rec.metrics);
            if (s != null) {
                for (const year of years) byYear[year] = s;
            }
        }

        if (Object.keys(byYear).length === 0) continue;

        feat.properties.lonelinessByYear = byYear;
        feat.properties.lonelinessScore  =
            byYear[defaultYear] ?? byYear[years[years.length - 1]] ?? null;
        feat.properties.lonelinessSource = rec.source ?? 'unknown';
    }
}

/**
 * For each feature, replace `lonelinessScore` with the score for the
 * requested year (when present). Leaves features without a per-year
 * table untouched.
 *
 * @param {GeoJSON.FeatureCollection} fc
 * @param {number} year
 */
function applyYearToFeatures(fc, year) {
    for (const feat of fc.features) {
        const byYear = feat.properties?.lonelinessByYear;
        if (!byYear) continue;
        const next = byYear[year];
        if (Number.isFinite(next)) {
            feat.properties.lonelinessScore = next;
        }
    }
}

document.addEventListener('DOMContentLoaded', main);
