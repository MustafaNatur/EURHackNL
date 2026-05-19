import { AppConfig } from '../config.js';
import { METRIC_CATALOGUE, PUBLIC_PLACE_CATALOGUE } from '../models/DistrictData.js';

/**
 * DataService
 * -----------
 * Single boundary between the UI and the data backend.
 *
 * The data backend is currently a static JSON file produced by
 * `scripts/build_database.py`. That file mixes:
 *   - real CSV survey data (where the buurt's name matched a CSV row)
 *   - deterministic, seed-based pre-generated values (everywhere else).
 *
 * Either way the values are now stable — clicking the same neighborhood
 * twice always returns identical numbers.
 *
 * Replacing this with a real backend later: keep the same public API and
 * have `fetchDistrictData` hit an HTTP endpoint. No other module changes.
 */
export class DataService {
    /**
     * @param {Object} [options]
     * @param {number} [options.minLatencyMs]
     * @param {number} [options.maxLatencyMs]
     */
    constructor(options = {}) {
        this._minLatencyMs = options.minLatencyMs ?? AppConfig.fakeRequestMinMs;
        this._maxLatencyMs = options.maxLatencyMs ?? AppConfig.fakeRequestMaxMs;
        /** @type {Promise<Object>|null} */
        this._loadPromise = null;
        /** @type {Object|null} */
        this._db = null;
    }

    /**
     * Lazily loads the local database. Safe to call repeatedly — the
     * underlying fetch happens at most once for the lifetime of the
     * service.
     * @returns {Promise<Object>}
     */
    async load() {
        if (this._db) return this._db;
        if (!this._loadPromise) {
            this._loadPromise = fetch(AppConfig.databasePath).then(async (response) => {
                if (!response.ok) {
                    throw new Error(`Failed to load database: HTTP ${response.status}`);
                }
                this._db = await response.json();
                return this._db;
            });
        }
        return this._loadPromise;
    }

    /**
     * Fetch the metrics dataset for a single neighborhood.
     * Still simulates a network round-trip via `fakeRequestMinMs/MaxMs`,
     * so the loading spinner in the sidebar remains realistic.
     *
     * @param {string}            districtId
     * @param {string}            districtName
     * @param {[number, number]}  centroid     - [longitude, latitude]
     * @param {Object}            [opts]
     * @param {number}            [opts.year]  - currently informational only
     * @param {number}            [opts.population]
     * @returns {Promise<import('../models/DistrictData.js').DistrictData & {source?: string, publicPlaces?: {key:string, count:number}[]}>}
     */
    async fetchDistrictData(districtId, districtName, centroid, opts = {}) {
        await Promise.all([
            this.load(),
            this._simulateLatency()
        ]);

        const record = this._db?.neighborhoods?.[districtId];
        const year   = opts.year ?? record?.year ?? this._db?.year ?? AppConfig.defaultYear;

        if (record) {
            return {
                districtId:   record.districtId,
                districtName: record.districtName ?? districtName,
                year,
                centroid,
                source:       record.source ?? 'unknown',
                metrics:      DataService._normalizeMetrics(record.metrics),
                publicPlaces: DataService._normalizePlaces(record.publicPlaces)
            };
        }

        // Defensive fallback: should never trigger if the database is up-to-date
        // with the GeoJSON, but keeps the UI from crashing on a missing id.
        console.warn(`No database entry for ${districtId}; returning empty record.`);
        return {
            districtId,
            districtName,
            year,
            centroid,
            source: 'missing',
            metrics: DataService._emptyMetrics(),
            publicPlaces: DataService._emptyPlaces()
        };
    }

    /** @private */
    _simulateLatency() {
        const delay = this._minLatencyMs + Math.random() * (this._maxLatencyMs - this._minLatencyMs);
        return new Promise(resolve => setTimeout(resolve, delay));
    }

    /** Ensures every metric in the catalogue is present (filling missing keys with 0). @private */
    static _normalizeMetrics(input = {}) {
        const out = {};
        for (const def of METRIC_CATALOGUE) {
            const v = input[def.key];
            out[def.key] = Number.isFinite(v) ? v : 0;
        }
        return out;
    }

    /** @private */
    static _normalizePlaces(input) {
        if (!Array.isArray(input)) return DataService._emptyPlaces();
        const byKey = new Map(input.map(p => [p.key, Number(p.count) || 0]));
        return PUBLIC_PLACE_CATALOGUE.map(def => ({
            key: def.key,
            count: byKey.get(def.key) ?? 0
        }));
    }

    /** @private */
    static _emptyMetrics() {
        const out = {};
        for (const def of METRIC_CATALOGUE) out[def.key] = 0;
        return out;
    }

    /** @private */
    static _emptyPlaces() {
        return PUBLIC_PLACE_CATALOGUE.map(def => ({ key: def.key, count: 0 }));
    }
}
