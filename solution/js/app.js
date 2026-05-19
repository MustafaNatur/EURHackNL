import { GeoService }         from './services/GeoService.js';
import { DataService }        from './services/DataService.js';
import { AIService }          from './services/AIService.js';
import { MapController }      from './map/MapController.js';
import { SidebarController }  from './ui/SidebarController.js';
import { TimelineController } from './ui/TimelineController.js';
import { LONELINESS_KEYS }    from './models/DistrictData.js';

/**
 * Composition root.
 *
 * Wires together the layers:
 *   GeoService   — knows the shape of the city (static geometry)
 *   DataService  — knows how to obtain metrics for a district (fake for now)
 *   AIService    — fakes the loneliness-recommendation AI flow
 *   Map / Sidebar / Timeline controllers — present that information.
 *
 * The controllers do not know about each other; this file is the only place
 * that orchestrates a flow across them.
 *
 * Year flow (timeline):
 *   1. enrichFeaturesWithLoneliness bakes `lonelinessByYear: { 2018..2026 }`
 *      and an initial `lonelinessScore` onto every GeoJSON feature.
 *   2. When TimelineController emits a new year, `applyYearToFeatures`
 *      swaps `lonelinessScore` to that year's value and we ask the map
 *      to re-issue setData, which causes paint expressions to re-evaluate.
 *   3. If the sidebar is currently showing the stats screen for a buurt,
 *      we synchronously refresh it with that buurt's metrics for the
 *      new year — no latency, no race-conditions.
 */
async function main() {
    const geoService     = new GeoService();
    const dataService    = new DataService();
    const aiService      = new AIService();
    const sidebar        = new SidebarController('sidebar');
    const mapController  = new MapController('map', geoService);

    let fc;
    let db;
    try {
        [fc, db] = await Promise.all([
            geoService.load(),
            dataService.load()
        ]);
        enrichFeaturesWithLoneliness(fc, db);

        await mapController.init();
    } catch (err) {
        console.error('Failed to initialise map:', err);
        document.getElementById('map').innerHTML =
            `<div style="padding:24px;color:#b91c1c;">Map failed to load: ${err.message}</div>`;
        return;
    }

    const timeline = new TimelineController('map', {
        years: dataService.getYears(),
        initialYear: dataService.getDefaultYear()
    });
    timeline.init();
    mapController.updateCityStats(timeline.getCurrentYear());

    /** Tracks the in-flight district fetch so a quick re-click cancels the previous render. */
    let activeRequestId = 0;
    /** Tracks the in-flight AI analysis, bumped whenever a new buurt is selected. */
    let activeAnalysisId = 0;
    /** Cached centroid+meta for the currently selected district (needed for sync re-renders). */
    let selectedCentroid = null;
    let selectedMeta = null;

    mapController.onDistrictSelected(async (districtId, districtName, centroid, meta) => {
        const requestId = ++activeRequestId;
        activeAnalysisId++;
        selectedCentroid = centroid;
        selectedMeta = meta;

        sidebar.showLoading(districtName, meta);

        try {
            const data = await dataService.fetchDistrictData(
                districtId,
                districtName,
                centroid,
                {
                    year: timeline.getCurrentYear(),
                    population: meta?.population
                }
            );
            if (requestId !== activeRequestId) return; // stale; newer selection took over
            sidebar.renderData({ ...data, meta });
        } catch (err) {
            if (requestId !== activeRequestId) return;
            console.error('Failed to load district data:', err);
            sidebar.renderData({
                districtId,
                districtName,
                year: timeline.getCurrentYear(),
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

    timeline.onYearChange((year) => {
        applyYearToFeatures(fc, year);
        mapController.refreshDistrictSource();
        mapController.updateCityStats(year);

        // Only refresh the sidebar when it's on the stats screen — we
        // don't want to disrupt an active recommendations drill-in.
        const districtId = sidebar.selectedDistrictId;
        if (!districtId) return;
        if (sidebar.screen !== SidebarController.SCREEN_STATS) return;

        const data = dataService.getDistrictDataSync(districtId, year, {
            centroid: selectedCentroid ?? [0, 0]
        });
        sidebar.renderData({ ...data, meta: selectedMeta ?? {} });
    });
}

/**
 * Mutates the GeoJSON FeatureCollection in place, adding:
 *   - `lonelinessByYear`  : { 2018: 32.4, ..., 2026: 38.2 } per buurt
 *   - `lonelinessScore`   : the active year's score (initially the default)
 *   - `lonelinessSource`  : "csv" / "csv-partial" / "generated"
 *
 * This is run once at startup so subsequent year scrubs are O(features)
 * with no async work.
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
            // Legacy v1: a single year of metrics. Project it across the
            // year list so the timeline still has something to render.
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
