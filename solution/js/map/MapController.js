import { AppConfig } from '../config.js';
import { CityStatsControl } from '../ui/CityStatsControl.js';

/**
 * MapController
 * -------------
 * Encapsulates everything map-related: initializing MapLibre GL, rendering
 * district polygons, hover/click interaction, and selection highlight.
 *
 * The outside world only sees:
 *   - constructor(containerId, geoService)
 *   - init()                       : Promise<void>
 *   - onDistrictSelected(callback) : (id, name, centroid) => void
 *   - selectDistrict(id)           : programmatic selection (e.g. from URL)
 *
 * This keeps the GL-specific concepts isolated and lets us swap rendering
 * engines (Mapbox <-> MapLibre <-> Leaflet) without touching UI code.
 */
/**
 * Visual palette per buurt category. Defined once here so the map layers
 * and the on-screen legend stay in lock-step.
 */
export const CATEGORY_STYLES = Object.freeze({
    residential: { color: '#3b82f6', label: 'Residential',  description: 'Inhabited neighborhood' },
    harbour:     { color: '#475569', label: 'Harbour',      description: 'Port, terminals, refineries' },
    business:    { color: '#f59e0b', label: 'Business park', description: 'Offices / light industry' },
    green:       { color: '#22c55e', label: 'Green / rural', description: 'Park, forest or farmland' }
});

/**
 * Loneliness colour ramp — interpolated linearly between these stops.
 * Stops chosen to span the realistic CSV range (~22 .. ~58 %).
 */
export const LONELINESS_STOPS = Object.freeze([
    { score: 22, color: '#22c55e', label: 'Low' },
    { score: 32, color: '#a3e635', label: '' },
    { score: 40, color: '#facc15', label: 'Moderate' },
    { score: 48, color: '#f97316', label: '' },
    { score: 58, color: '#ef4444', label: 'High' }
]);

export class MapController {
    static SOURCE_ID = 'districts';
    static SOURCE_BOUNDARY = 'rotterdam-boundary';
    static LAYER_FILL = 'districts-fill';
    static LAYER_FILL_HOVER = 'districts-fill-hover';
    static LAYER_FILL_SELECTED = 'districts-fill-selected';
    static LAYER_LINE = 'districts-line';
    static LAYER_LINE_SELECTED = 'districts-line-selected';
    static LAYER_LABEL = 'districts-label';
    static LAYER_BOUNDARY_GLOW = 'rotterdam-boundary-glow';
    static LAYER_BOUNDARY_LINE = 'rotterdam-boundary-line';

    /**
     * @param {string} containerId    - DOM id of the map container
     * @param {import('../services/GeoService.js').GeoService} geoService
     */
    constructor(containerId, geoService) {
        this._containerId = containerId;
        this._geoService = geoService;
        /** @type {maplibregl.Map|null} */
        this._map = null;
        /** @type {string|null} */
        this._selectedId = null;
        /** @type {string|null} */
        this._hoveredId = null;
        /** @type {((id: string, name: string, centroid: [number,number]) => void) | null} */
        this._onSelected = null;
        /** @type {'loneliness'|'type'} */
        this._colorMode = 'loneliness';
        /** @type {LegendControl|null} */
        this._legend = null;
        /** @type {CityStatsControl|null} */
        this._cityStats = null;
    }

    /**
     * Initializes the map and waits for both `load` and the GeoJSON fetch.
     */
    async init() {
        // eslint-disable-next-line no-undef
        const gl = window.maplibregl;
        if (!gl) {
            throw new Error('MapLibre GL JS is not loaded. Check the <script> tag in index.html.');
        }

        this._map = new gl.Map({
            container: this._containerId,
            style: AppConfig.mapStyleUrl,
            center: AppConfig.initialCenter,
            zoom: AppConfig.initialZoom,
            minZoom: AppConfig.minZoom,
            maxZoom: AppConfig.maxZoom,
            attributionControl: { compact: true }
        });

        this._map.addControl(new gl.NavigationControl({ showCompass: false }), 'top-left');
        this._map.addControl(new gl.ScaleControl({ unit: 'metric' }), 'bottom-left');

        await this._geoService.load();

        // Order in the top-left stack (top to bottom):
        //   1. Navigation control (added above)
        //   2. City stats overview (added here, before legend so it appears above it)
        //   3. Legend with loneliness/type toggle (added below)
        this._cityStats = new CityStatsControl({
            fc: this._geoService.getFeatureCollection()
        });
        this._map.addControl(this._cityStats, 'top-left');

        this._legend = new LegendControl(
            this._colorMode,
            (mode) => this.setColorMode(mode)
        );
        this._map.addControl(this._legend, 'top-left');

        await new Promise(resolve => {
            if (this._map.loaded()) resolve();
            else this._map.once('load', () => resolve());
        });

        this._installLayers();
        this._installInteractions();
        this._fitToDistricts();
    }

    /**
     * Registers a callback to receive buurt selection events.
     * @param {(districtId: string, districtName: string, centroid: [number, number], meta: { isInhabited: boolean, population: number, parentDistrict: string }) => void} callback
     */
    onDistrictSelected(callback) {
        this._onSelected = callback;
    }

    /**
     * Switches the map fill colouring between 'loneliness' and 'type' modes.
     * The border colour always encodes the neighborhood type.
     * @param {'loneliness'|'type'} mode
     */
    setColorMode(mode) {
        if (mode !== 'loneliness' && mode !== 'type') return;
        if (mode === this._colorMode) return;
        this._colorMode = mode;
        const expr = this._buildFillExpression();
        for (const layerId of [
            MapController.LAYER_FILL,
            MapController.LAYER_FILL_HOVER,
            MapController.LAYER_FILL_SELECTED
        ]) {
            if (this._map.getLayer(layerId)) {
                this._map.setPaintProperty(layerId, 'fill-color', expr);
            }
        }
        this._legend?.setMode(mode);
    }

    /** @returns {'loneliness'|'type'} */
    getColorMode() {
        return this._colorMode;
    }

    /**
     * Builds the fill paint expression for the active colour mode.
     *  - 'type'      : pure categorical match by `category`.
     *  - 'loneliness': residential buurten with a `lonelinessScore`
     *                  property get the green→red gradient; everything
     *                  else falls back to its category colour.
     * @private
     */
    _buildFillExpression() {
        if (this._colorMode === 'type') {
            return MapController._buildTypeExpression();
        }
        return [
            'case',
            ['all',
                ['==', ['get', 'category'], 'residential'],
                ['has', 'lonelinessScore']
            ],
            MapController._buildLonelinessRamp(),
            MapController._buildTypeExpression()
        ];
    }

    /** @private */
    static _buildTypeExpression() {
        return [
            'match', ['get', 'category'],
            'residential', CATEGORY_STYLES.residential.color,
            'harbour',     CATEGORY_STYLES.harbour.color,
            'business',    CATEGORY_STYLES.business.color,
            'green',       CATEGORY_STYLES.green.color,
            CATEGORY_STYLES.residential.color
        ];
    }

    /** @private */
    static _buildLonelinessRamp() {
        const expr = ['interpolate', ['linear'], ['get', 'lonelinessScore']];
        for (const stop of LONELINESS_STOPS) expr.push(stop.score, stop.color);
        return expr;
    }

    /**
     * Programmatically select a district.
     * @param {string} districtId
     */
    selectDistrict(districtId) {
        const feature = this._geoService.getDistrictById(districtId);
        if (!feature) return;
        this._applySelection(districtId);
        this._notifySelection(feature);
    }

    /**
     * Re-publish the district FeatureCollection to MapLibre. Use this
     * after mutating feature properties (e.g. swapping `lonelinessScore`
     * for a different year) so the existing paint expressions re-evaluate
     * against the updated data.
     */
    refreshDistrictSource() {
        const src = this._map?.getSource(MapController.SOURCE_ID);
        if (!src) return;
        const fc = this._geoService.getFeatureCollection();
        src.setData(fc);
    }

    /**
     * Recompute and re-render the top-left "Rotterdam overview" panel
     * for the given year. Cheap (a single pass over the FeatureCollection)
     * so it's safe to call on every slider tick.
     * @param {number} year
     */
    updateCityStats(year) {
        this._cityStats?.update(year);
    }

    /** @private */
    _installLayers() {
        const fc = this._geoService.getFeatureCollection();

        this._map.addSource(MapController.SOURCE_ID, {
            type: 'geojson',
            data: fc,
            promoteId: 'id'
        });

        // Borders always encode the neighborhood type — this gives a
        // consistent secondary signal regardless of which colour mode
        // the fill is in.
        const borderExpr = MapController._buildTypeExpression();
        const fillExpr   = this._buildFillExpression();

        // Base fill — colour driven by the active colour mode.
        this._map.addLayer({
            id: MapController.LAYER_FILL,
            type: 'fill',
            source: MapController.SOURCE_ID,
            paint: {
                'fill-color': fillExpr,
                'fill-opacity': 0.45
            }
        });

        // Hover overlay — only the hovered buurt
        this._map.addLayer({
            id: MapController.LAYER_FILL_HOVER,
            type: 'fill',
            source: MapController.SOURCE_ID,
            paint: {
                'fill-color': fillExpr,
                'fill-opacity': 0.6
            },
            filter: ['==', ['get', 'id'], '']
        });

        // Selected overlay — only the selected buurt
        this._map.addLayer({
            id: MapController.LAYER_FILL_SELECTED,
            type: 'fill',
            source: MapController.SOURCE_ID,
            paint: {
                'fill-color': fillExpr,
                'fill-opacity': 0.75
            },
            filter: ['==', ['get', 'id'], '']
        });

        // Default border — encodes neighborhood type, always.
        this._map.addLayer({
            id: MapController.LAYER_LINE,
            type: 'line',
            source: MapController.SOURCE_ID,
            paint: {
                'line-color': borderExpr,
                'line-width': 1.2,
                'line-opacity': 0.7
            }
        });

        // Selected border
        this._map.addLayer({
            id: MapController.LAYER_LINE_SELECTED,
            type: 'line',
            source: MapController.SOURCE_ID,
            paint: {
                'line-color': '#fbbf24',
                'line-width': 3
            },
            filter: ['==', ['get', 'id'], '']
        });

        // Rotterdam municipal boundary — drawn above all buurt layers so
        // it visually frames the city. A wide, soft "glow" line is layered
        // under a crisp inner line for emphasis.
        const boundary = this._geoService.getBoundary();
        if (boundary) {
            this._map.addSource(MapController.SOURCE_BOUNDARY, {
                type: 'geojson',
                data: boundary
            });
            this._map.addLayer({
                id: MapController.LAYER_BOUNDARY_GLOW,
                type: 'line',
                source: MapController.SOURCE_BOUNDARY,
                layout: { 'line-join': 'round', 'line-cap': 'round' },
                paint: {
                    'line-color': '#0ea5e9',
                    'line-width': 10,
                    'line-opacity': 0.18,
                    'line-blur': 6
                }
            });
            this._map.addLayer({
                id: MapController.LAYER_BOUNDARY_LINE,
                type: 'line',
                source: MapController.SOURCE_BOUNDARY,
                layout: { 'line-join': 'round', 'line-cap': 'round' },
                paint: {
                    'line-color': '#0c4a6e',
                    'line-width': 2.2,
                    'line-opacity': 0.9,
                    'line-dasharray': [2.5, 1.2]
                }
            });
        }

        // Neighborhood labels — only visible once zoomed in enough
        // to avoid overcrowding the city-wide view.
        this._map.addLayer({
            id: MapController.LAYER_LABEL,
            type: 'symbol',
            source: MapController.SOURCE_ID,
            minzoom: 11.5,
            layout: {
                'text-field': ['get', 'name'],
                'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
                'text-size': [
                    'interpolate', ['linear'], ['zoom'],
                    11.5, 9,
                    13, 11,
                    15, 13
                ],
                'text-anchor': 'center',
                'text-allow-overlap': false,
                'text-padding': 4
            },
            paint: {
                'text-color': '#0f172a',
                'text-halo-color': 'rgba(255,255,255,0.9)',
                'text-halo-width': 1.4
            }
        });
    }

    /** @private */
    _installInteractions() {
        const fillLayer = MapController.LAYER_FILL;

        this._map.on('mousemove', fillLayer, (e) => {
            if (!e.features?.length) return;
            const id = e.features[0].properties.id;
            this._setHovered(id);
            this._map.getCanvas().style.cursor = 'pointer';
        });

        this._map.on('mouseleave', fillLayer, () => {
            this._setHovered(null);
            this._map.getCanvas().style.cursor = '';
        });

        this._map.on('click', fillLayer, (e) => {
            if (!e.features?.length) return;
            const props = e.features[0].properties;
            const id = props.id;
            this._applySelection(id);
            this._notifySelection(this._geoService.getDistrictById(id));
        });
    }

    /** @private */
    _setHovered(id) {
        if (id === this._hoveredId) return;
        this._hoveredId = id;
        this._map.setFilter(
            MapController.LAYER_FILL_HOVER,
            ['==', ['get', 'id'], id ?? '']
        );
    }

    /** @private */
    _applySelection(id) {
        this._selectedId = id;
        const filter = ['==', ['get', 'id'], id];
        this._map.setFilter(MapController.LAYER_FILL_SELECTED, filter);
        this._map.setFilter(MapController.LAYER_LINE_SELECTED, filter);
        this._flyToDistrict(id);
    }

    /**
     * Fly to a buurt by fitting its bounding box.
     * This adapts to feature size — small inner-city buurten zoom in close,
     * while huge harbor buurten like Maasvlakte stay zoomed-out.
     * @private
     */
    _flyToDistrict(id) {
        const feature = this._geoService.getDistrictById(id);
        if (!feature) return;
        const bounds = MapController._computeBounds({ features: [feature] });
        if (!bounds) return;
        this._map.fitBounds(bounds, {
            padding: { top: 60, bottom: 60, left: 60, right: 400 },
            maxZoom: 14.5,
            duration: 900
        });
    }

    /** @private */
    _notifySelection(feature) {
        if (!feature || !this._onSelected) return;
        const props = feature.properties ?? {};
        const id = props.id ?? feature.id;
        const name = props.name ?? '';
        const centroid = this._geoService.getCentroidById(id) ?? [0, 0];
        const meta = {
            category: props.category ?? 'residential',
            isInhabited: props.isInhabited !== false,
            population: Number(props.population) || 0,
            parentDistrict: props.districtName ?? ''
        };
        this._onSelected(id, name, centroid, meta);
    }

    /**
     * Fit the initial view to the inhabited city core. We skip industrial
     * harbor buurten (Maasvlakte, Botlek, …) when computing bounds so the
     * urban area isn't dwarfed at startup — but they remain on the map and
     * clickable.
     * @private
     */
    _fitToDistricts() {
        const fc = this._geoService.getFeatureCollection();
        const inhabited = {
            features: fc.features.filter(f => f.properties?.isInhabited !== false)
        };
        const bounds = MapController._computeBounds(inhabited);
        if (!bounds) return;
        this._map.fitBounds(bounds, { padding: 40, duration: 0 });
    }

    /**
     * Computes a bounding box [[minLng, minLat], [maxLng, maxLat]] for the
     * given FeatureCollection. Returns null when empty.
     * @private
     */
    static _computeBounds(fc) {
        let minLng = Infinity, minLat = Infinity;
        let maxLng = -Infinity, maxLat = -Infinity;

        const walk = (coords) => {
            if (typeof coords[0] === 'number') {
                const [lng, lat] = coords;
                if (lng < minLng) minLng = lng;
                if (lat < minLat) minLat = lat;
                if (lng > maxLng) maxLng = lng;
                if (lat > maxLat) maxLat = lat;
                return;
            }
            for (const c of coords) walk(c);
        };

        for (const f of fc.features) walk(f.geometry.coordinates);
        if (!isFinite(minLng)) return null;
        return [[minLng, minLat], [maxLng, maxLat]];
    }
}

/**
 * Custom MapLibre control rendering a stateful legend with a
 * mode-toggle. The toggle flips the map's fill colouring between
 * "Loneliness" and "Type"; the legend body redraws accordingly.
 */
class LegendControl {
    /**
     * @param {'loneliness'|'type'} initialMode
     * @param {(mode: 'loneliness'|'type') => void} onModeChange
     */
    constructor(initialMode, onModeChange) {
        this._mode = initialMode;
        this._onModeChange = onModeChange;
    }

    onAdd() {
        const el = document.createElement('div');
        el.className = 'maplibregl-ctrl legend';
        el.innerHTML = `
            <div class="legend__toggle" role="tablist">
                <button type="button" role="tab" data-mode="loneliness"
                        class="legend__toggle-btn">Loneliness</button>
                <button type="button" role="tab" data-mode="type"
                        class="legend__toggle-btn">Type</button>
            </div>
            <div class="legend__body" data-role="body"></div>
        `;
        this._el     = el;
        this._bodyEl = el.querySelector('[data-role="body"]');

        el.querySelector('.legend__toggle').addEventListener('click', (e) => {
            const btn = e.target.closest('[data-mode]');
            if (!btn) return;
            this._onModeChange?.(btn.dataset.mode);
        });

        this._renderBody();
        this._syncToggle();
        return el;
    }

    onRemove() {
        this._el?.parentNode?.removeChild(this._el);
        this._el = null;
    }

    /** @param {'loneliness'|'type'} mode */
    setMode(mode) {
        if (mode === this._mode) return;
        this._mode = mode;
        this._renderBody();
        this._syncToggle();
    }

    /** @private */
    _syncToggle() {
        if (!this._el) return;
        for (const btn of this._el.querySelectorAll('[data-mode]')) {
            const active = btn.dataset.mode === this._mode;
            btn.classList.toggle('legend__toggle-btn--active', active);
            btn.setAttribute('aria-selected', active ? 'true' : 'false');
        }
    }

    /** @private */
    _renderBody() {
        if (!this._bodyEl) return;
        this._bodyEl.innerHTML = this._mode === 'loneliness'
            ? LegendControl._renderLonelinessBody()
            : LegendControl._renderTypeBody();
    }

    /** @private */
    static _renderTypeBody() {
        const items = Object.entries(CATEGORY_STYLES).map(([, s]) => `
            <li class="legend__item" title="${s.description}">
                <span class="legend__swatch" style="background:${s.color}"></span>
                <span class="legend__label">${s.label}</span>
            </li>
        `).join('');
        return `
            <div class="legend__title">Neighborhood type</div>
            <ul class="legend__list">${items}</ul>
        `;
    }

    /** @private */
    static _renderLonelinessBody() {
        // Build the gradient with HIGH at the top (red) and LOW at the
        // bottom (green) — matches the convention "more = up".
        const reversed = [...LONELINESS_STOPS].reverse();
        const gradient = reversed
            .map((s, i) => `${s.color} ${(i / (reversed.length - 1)) * 100}%`)
            .join(', ');
        const low  = LONELINESS_STOPS[0];
        const high = LONELINESS_STOPS[LONELINESS_STOPS.length - 1];
        const mid  = LONELINESS_STOPS[Math.floor(LONELINESS_STOPS.length / 2)];
        return `
            <div class="legend__title">Loneliness level</div>
            <div class="legend__vscale">
                <div class="legend__vbar" style="background:linear-gradient(to bottom, ${gradient})"></div>
                <div class="legend__vlabels">
                    <span><strong>High</strong><br>${high.score}%+</span>
                    <span class="legend__vlabel-mid">${mid.score}%</span>
                    <span><strong>Low</strong><br>${low.score}%</span>
                </div>
            </div>
            <p class="legend__hint">
                Non-residential areas keep their type colour
                (harbour, business, parks). Borders always encode the
                neighborhood type.
            </p>
        `;
    }
}
