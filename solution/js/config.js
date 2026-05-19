/**
 * Application configuration.
 * Centralizes constants that are environment- or deployment-specific.
 *
 * NOTE on the map SDK:
 *   We load MapLibre GL JS via CDN (see index.html). MapLibre exposes the
 *   exact same `maplibregl` namespace and API as Mapbox GL JS, which means
 *   the rest of the codebase is portable: to switch to Mapbox, replace the
 *   CDN <script>, swap `maplibregl` for `mapboxgl`, set MAPBOX_TOKEN below,
 *   and assign it via `mapboxgl.accessToken = AppConfig.mapToken`.
 */
export const AppConfig = Object.freeze({
    /** Optional Mapbox access token. Leave empty when using MapLibre + free tiles. */
    mapToken: '',

    /** Free, open-source vector style for MapLibre. No API key required. */
    mapStyleUrl: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',

    /** Initial map viewport (center of Rotterdam). */
    initialCenter: [4.47917, 51.9244],
    initialZoom: 11.4,
    minZoom: 9,
    maxZoom: 17,

    /**
     * Path to the official neighborhood (CBS "buurt") boundaries,
     * relative to index.html. ~91 buurten covering the entire municipality.
     */
    districtsGeoJsonPath: 'data/rotterdam_neighborhoods.geojson',

    /** Path to the Rotterdam municipal boundary polygon. */
    boundaryGeoJsonPath: 'data/rotterdam_boundary.geojson',

    /**
     * Path to the pre-built local "database" — a single JSON file holding
     * both real CSV-derived data and stable, pre-generated values for the
     * remaining buurten. Built by `scripts/build_database.py`.
     */
    databasePath: 'data/neighborhoods_database.json',

    /** Default reporting year used by DataService when none is specified. */
    defaultYear: 2022,

    /** Simulated network latency bounds for the fake DataService (milliseconds). */
    fakeRequestMinMs: 600,
    fakeRequestMaxMs: 1400
});
