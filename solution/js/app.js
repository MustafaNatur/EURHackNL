import { GeoService }       from './services/GeoService.js';
import { DataService }      from './services/DataService.js';
import { MapController }    from './map/MapController.js';
import { SidebarController } from './ui/SidebarController.js';
import { LONELINESS_KEYS }  from './models/DistrictData.js';

/**
 * Composition root.
 *
 * Wires together the three layers:
 *   GeoService   — knows the shape of the city (static geometry)
 *   DataService  — knows how to obtain metrics for a district (fake for now)
 *   Map/Sidebar controllers — present that information to the user
 *
 * The controllers do not know about each other; this file is the only place
 * that orchestrates a flow across them.
 */
async function main() {
    const geoService     = new GeoService();
    const dataService    = new DataService();
    const sidebar        = new SidebarController('sidebar');
    const mapController  = new MapController('map', geoService);

    try {
        // Load geometry + database in parallel, THEN bake the loneliness
        // composite score into each feature's properties. This lets the
        // map's paint expressions colour buurten by their loneliness
        // level without a second source-update at runtime.
        const [fc, db] = await Promise.all([
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

    /** Tracks the in-flight request so a quick re-click cancels the previous render. */
    let activeRequestId = 0;

    mapController.onDistrictSelected(async (districtId, districtName, centroid, meta) => {
        const requestId = ++activeRequestId;

        sidebar.showLoading(districtName, meta);

        try {
            const data = await dataService.fetchDistrictData(
                districtId,
                districtName,
                centroid,
                { population: meta?.population }
            );
            if (requestId !== activeRequestId) return; // stale; newer selection took over
            sidebar.renderData({ ...data, meta });
        } catch (err) {
            if (requestId !== activeRequestId) return;
            console.error('Failed to load district data:', err);
            sidebar.renderData({
                districtId,
                districtName,
                year: new Date().getFullYear(),
                centroid,
                metrics: {},
                meta
            });
        }
    });
}

/**
 * Mutates the GeoJSON FeatureCollection in place, adding a numeric
 * `lonelinessScore` (0..100, composite of the 4 loneliness keys) and a
 * `lonelinessSource` ("csv" / "generated" / …) to each feature's
 * properties when a matching record exists in the database.
 *
 * @param {GeoJSON.FeatureCollection} fc
 * @param {{neighborhoods?: Record<string, any>}} db
 */
function enrichFeaturesWithLoneliness(fc, db) {
    const records = db?.neighborhoods ?? {};
    for (const feat of fc.features) {
        const id = feat.properties?.id;
        if (!id) continue;
        const rec = records[id];
        if (!rec?.metrics) continue;

        const values = LONELINESS_KEYS
            .map(k => rec.metrics[k])
            .filter(v => Number.isFinite(v));
        if (values.length === 0) continue;

        const avg = values.reduce((a, b) => a + b, 0) / values.length;
        feat.properties.lonelinessScore  = Math.round(avg * 10) / 10;
        feat.properties.lonelinessSource = rec.source ?? 'unknown';
    }
}

document.addEventListener('DOMContentLoaded', main);
