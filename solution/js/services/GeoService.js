import { AppConfig } from '../config.js';

/**
 * GeoService
 * ----------
 * Loads and exposes Rotterdam district polygon geometry.
 *
 * Responsibilities:
 *  - Fetch the GeoJSON once and cache it.
 *  - Compute (and cache) a centroid for each district.
 *  - Provide lookup helpers used by MapController and SidebarController.
 */
export class GeoService {
    constructor() {
        /** @type {GeoJSON.FeatureCollection|null} */
        this._featureCollection = null;
        /** @type {GeoJSON.FeatureCollection|null} */
        this._boundary = null;
        /** @type {Map<string, GeoJSON.Feature>} */
        this._byId = new Map();
        /** @type {Map<string, [number, number]>} */
        this._centroidById = new Map();
    }

    /**
     * Loads both the buurten and the municipal boundary GeoJSONs in parallel.
     * Safe to call multiple times — subsequent calls are no-ops.
     * @returns {Promise<GeoJSON.FeatureCollection>}
     */
    async load() {
        if (this._featureCollection) return this._featureCollection;

        const [districtsRes, boundaryRes] = await Promise.all([
            fetch(AppConfig.districtsGeoJsonPath),
            fetch(AppConfig.boundaryGeoJsonPath)
        ]);
        if (!districtsRes.ok) {
            throw new Error(`Failed to load districts GeoJSON: HTTP ${districtsRes.status}`);
        }
        if (!boundaryRes.ok) {
            throw new Error(`Failed to load boundary GeoJSON: HTTP ${boundaryRes.status}`);
        }

        const fc = await districtsRes.json();
        const boundary = await boundaryRes.json();

        for (const feature of fc.features) {
            const id = feature.properties?.id ?? feature.id;
            if (!id) continue;
            this._byId.set(id, feature);
            this._centroidById.set(id, GeoService._computeCentroid(feature.geometry));
        }

        this._featureCollection = fc;
        this._boundary = boundary;
        return fc;
    }

    /** @returns {GeoJSON.FeatureCollection} */
    getFeatureCollection() {
        if (!this._featureCollection) {
            throw new Error('GeoService.load() must be awaited before access.');
        }
        return this._featureCollection;
    }

    /** @returns {GeoJSON.FeatureCollection|null} */
    getBoundary() {
        return this._boundary;
    }

    /** @returns {GeoJSON.Feature|undefined} */
    getDistrictById(id) {
        return this._byId.get(id);
    }

    /** @returns {[number, number]|undefined} centroid [lng, lat] */
    getCentroidById(id) {
        return this._centroidById.get(id);
    }

    /**
     * Average-vertex centroid (simple, robust enough for "panTo" use).
     * Handles Polygon and MultiPolygon geometries.
     * @private
     * @param {GeoJSON.Geometry} geometry
     * @returns {[number, number]}
     */
    static _computeCentroid(geometry) {
        const rings = [];
        if (geometry.type === 'Polygon') {
            rings.push(geometry.coordinates[0]);
        } else if (geometry.type === 'MultiPolygon') {
            for (const poly of geometry.coordinates) rings.push(poly[0]);
        }

        let lngSum = 0, latSum = 0, count = 0;
        for (const ring of rings) {
            for (const [lng, lat] of ring) {
                lngSum += lng;
                latSum += lat;
                count += 1;
            }
        }
        return count === 0
            ? [0, 0]
            : [lngSum / count, latSum / count];
    }
}
