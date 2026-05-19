import { AppConfig } from '../config.js';
import { METRIC_CATALOGUE } from '../models/DistrictData.js';
import { AGE_GROUPS, GENDERS } from '../models/DemographicData.js';

/**
 * DemographicService
 * ------------------
 * Reads `neighborhoods_demographic.json` (lazily, once per page lifetime)
 * and answers questions of the form "what does this metric look like for
 * 25–34 women in Charlois between 2018 and 2026?".
 *
 * The file is large (~3 MB), so:
 *   - It is fetched lazily — only when the first query arrives.
 *   - On load, slices are indexed by `districtId` into a `Map<id, Slice[]>`
 *     so per-buurt queries are O(slices-in-that-buurt) rather than O(file).
 *
 * The public API mirrors what the existing `DataService` offers for the
 * map view, plus the cross-buurt aggregations the analytics view needs.
 */
export class DemographicService {
    constructor(options = {}) {
        this._path = options.path ?? AppConfig.demographicPath;
        /** @type {Promise<void>|null} */
        this._loadPromise = null;
        /** @type {{
         *   schemaVersion: number,
         *   years: number[],
         *   ageGroups: string[],
         *   genders: string[],
         *   neighborhoods: Object.<string, {districtId: string, districtName: string, slices: any[]}>
         * }|null} */
        this._db = null;
        /** @type {Map<string, any[]>} per-buurt slice index */
        this._byDistrict = new Map();
        /** @type {Map<string, string>} id → name lookup, sorted alphabetically */
        this._namesById  = new Map();
    }

    /**
     * Lazy load the demographic JSON. Safe to call repeatedly.
     * @returns {Promise<void>}
     */
    async load() {
        if (this._db) return;
        if (!this._loadPromise) {
            this._loadPromise = fetch(this._path, { cache: 'reload' })
                .then(async (response) => {
                    if (!response.ok) {
                        throw new Error(`Failed to load demographic data: HTTP ${response.status}`);
                    }
                    this._db = await response.json();
                    this._index();
                });
        }
        return this._loadPromise;
    }

    /** True after `load()` has resolved. Cheap to test for readiness. */
    isLoaded() {
        return this._db != null;
    }

    /** @returns {number[]} */
    getYears() {
        return this._db?.years?.slice() ?? [];
    }

    /** @returns {string[]} */
    getAgeGroups() {
        return this._db?.ageGroups?.slice() ?? AGE_GROUPS.slice();
    }

    /** @returns {string[]} */
    getGenders() {
        return this._db?.genders?.slice() ?? GENDERS.slice();
    }

    /**
     * All buurten present in the demographic file, sorted alphabetically.
     * Excludes buurten with no CSV match (those are absent from the file
     * by design, see `build_database.py`).
     *
     * @returns {{ districtId: string, districtName: string }[]}
     */
    listDistricts() {
        return Array.from(this._namesById.entries())
            .map(([id, name]) => ({ districtId: id, districtName: name }))
            .sort((a, b) => a.districtName.localeCompare(b.districtName, 'nl'));
    }

    /**
     * Slices for a single buurt, optionally filtered by demographics.
     *
     * @param {string} districtId
     * @param {import('../models/DemographicData.js').DemographicFilter} [filter]
     * @returns {import('../models/DemographicData.js').DemographicSlice[]}
     */
    getSlices(districtId, filter = {}) {
        const all = this._byDistrict.get(districtId) ?? [];
        return DemographicService._applyFilter(all, filter);
    }

    /**
     * Filter-aware average across slices for one buurt × dimension.
     *
     * Returned shape matches the `HealthMetrics` object the rest of the
     * app expects, so the analytics radar chart can reuse
     * `METRIC_CATALOGUE` labels and `highIsBad` flags directly.
     *
     * @param {string} districtId
     * @param {import('../models/DemographicData.js').DemographicFilter} [filter]
     * @returns {Object.<string, number>}
     */
    getAggregated(districtId, filter = {}) {
        const slices = this.getSlices(districtId, filter);
        return DemographicService._averageMetrics(slices);
    }

    /**
     * Year-by-year series for one buurt × metric, averaged across the
     * filter's other dimensions.
     *
     * @param {string} districtId
     * @param {string} metricKey
     * @param {import('../models/DemographicData.js').DemographicFilter} [filter]
     * @returns {{ year: number, value: number }[]}
     */
    getTimeSeries(districtId, metricKey, filter = {}) {
        const slices = this.getSlices(districtId, { ...filter, years: undefined });
        const sums   = new Map();
        const counts = new Map();
        for (const s of slices) {
            const v = s.metrics?.[metricKey];
            if (!Number.isFinite(v)) continue;
            sums.set(s.year,   (sums.get(s.year)   ?? 0) + v);
            counts.set(s.year, (counts.get(s.year) ?? 0) + 1);
        }
        return Array.from(sums.keys())
            .sort((a, b) => a - b)
            .map(year => ({
                year,
                value: Math.round((sums.get(year) / counts.get(year)) * 10) / 10
            }));
    }

    /**
     * Cross-buurt average for a single metric under the given filter.
     * Used by the radar chart's "city average" overlay.
     *
     * @param {string} metricKey
     * @param {import('../models/DemographicData.js').DemographicFilter} [filter]
     * @returns {number}
     */
    getCityAverage(metricKey, filter = {}) {
        let sum = 0;
        let count = 0;
        for (const slices of this._byDistrict.values()) {
            const filtered = DemographicService._applyFilter(slices, filter);
            for (const s of filtered) {
                const v = s.metrics?.[metricKey];
                if (Number.isFinite(v)) {
                    sum += v;
                    count++;
                }
            }
        }
        if (count === 0) return 0;
        return Math.round((sum / count) * 10) / 10;
    }

    /**
     * City-wide year-by-year average for a metric. Used by the trend
     * chart's neutral "city average" line.
     *
     * @param {string} metricKey
     * @param {import('../models/DemographicData.js').DemographicFilter} [filter]
     * @returns {{ year: number, value: number }[]}
     */
    getCityTimeSeries(metricKey, filter = {}) {
        const yearFilter = { ...filter, years: undefined };
        const sums   = new Map();
        const counts = new Map();
        for (const slices of this._byDistrict.values()) {
            const filtered = DemographicService._applyFilter(slices, yearFilter);
            for (const s of filtered) {
                const v = s.metrics?.[metricKey];
                if (!Number.isFinite(v)) continue;
                sums.set(s.year,   (sums.get(s.year)   ?? 0) + v);
                counts.set(s.year, (counts.get(s.year) ?? 0) + 1);
            }
        }
        return Array.from(sums.keys())
            .sort((a, b) => a - b)
            .map(year => ({
                year,
                value: Math.round((sums.get(year) / counts.get(year)) * 10) / 10
            }));
    }

    /**
     * Rank all buurten by the metric under the given filter. Output is
     * sorted ascending or descending.
     *
     * @param {string} metricKey
     * @param {import('../models/DemographicData.js').DemographicFilter} [filter]
     * @param {'asc'|'desc'} [direction='desc']
     * @returns {{ districtId: string, districtName: string, value: number }[]}
     */
    getNeighborhoodsRanked(metricKey, filter = {}, direction = 'desc') {
        const rows = [];
        for (const [id, slices] of this._byDistrict.entries()) {
            const filtered = DemographicService._applyFilter(slices, filter);
            if (filtered.length === 0) continue;
            let sum = 0;
            let count = 0;
            for (const s of filtered) {
                const v = s.metrics?.[metricKey];
                if (Number.isFinite(v)) {
                    sum += v;
                    count++;
                }
            }
            if (count === 0) continue;
            rows.push({
                districtId:   id,
                districtName: this._namesById.get(id) ?? id,
                value:        Math.round((sum / count) * 10) / 10
            });
        }
        rows.sort((a, b) => direction === 'asc' ? a.value - b.value : b.value - a.value);
        return rows;
    }

    /**
     * Population-share approximation: the fraction of slices that match
     * the filter, relative to all slices for the same year span. Used by
     * the Audiences view as a "this segment is ~12 % of the surveyed
     * population" badge.
     *
     * Not exact population — there's no per-cell population count in the
     * survey — but it's a deterministic, comparable proxy.
     *
     * @param {import('../models/DemographicData.js').DemographicFilter} [filter]
     * @returns {number}  in [0, 1]
     */
    getPopulationShare(filter = {}) {
        const years = Array.isArray(filter.years) ? new Set(filter.years) : null;
        let matching = 0;
        let total    = 0;
        for (const slices of this._byDistrict.values()) {
            for (const s of slices) {
                if (years && !years.has(s.year)) continue;
                total++;
                if (DemographicService._matches(s, filter)) matching++;
            }
        }
        return total === 0 ? 0 : matching / total;
    }

    // ---------------- internals ----------------

    /** @private */
    _index() {
        this._byDistrict.clear();
        this._namesById.clear();
        const records = this._db?.neighborhoods ?? {};
        for (const [id, rec] of Object.entries(records)) {
            const slices = Array.isArray(rec?.slices) ? rec.slices : [];
            this._byDistrict.set(id, slices);
            this._namesById.set(id, rec?.districtName ?? id);
        }
    }

    /**
     * @private
     * @param {any[]} slices
     * @param {import('../models/DemographicData.js').DemographicFilter} filter
     */
    static _applyFilter(slices, filter) {
        if (!filter || (
            !filter.years   &&
            !filter.ages    &&
            !filter.genders
        )) {
            return slices;
        }
        return slices.filter(s => DemographicService._matches(s, filter));
    }

    /** @private */
    static _matches(slice, filter) {
        if (Array.isArray(filter.years)   && filter.years.length   > 0
            && !filter.years.includes(slice.year))   return false;
        if (Array.isArray(filter.ages)    && filter.ages.length    > 0
            && !filter.ages.includes(slice.age))     return false;
        if (Array.isArray(filter.genders) && filter.genders.length > 0
            && !filter.genders.includes(slice.gender)) return false;
        return true;
    }

    /**
     * Average all metric keys across the given slices. Missing metrics
     * from individual slices are dropped from the average for that key,
     * not zero-filled, so a slice missing one column doesn't bias the
     * other 17.
     *
     * @private
     */
    static _averageMetrics(slices) {
        const sums   = new Map();
        const counts = new Map();
        for (const s of slices) {
            const metrics = s?.metrics;
            if (!metrics) continue;
            for (const def of METRIC_CATALOGUE) {
                const v = metrics[def.key];
                if (!Number.isFinite(v)) continue;
                sums.set(def.key,   (sums.get(def.key)   ?? 0) + v);
                counts.set(def.key, (counts.get(def.key) ?? 0) + 1);
            }
        }
        const out = {};
        for (const def of METRIC_CATALOGUE) {
            const n = counts.get(def.key) ?? 0;
            out[def.key] = n > 0
                ? Math.round((sums.get(def.key) / n) * 10) / 10
                : 0;
        }
        return out;
    }
}
