import { AppConfig } from '../config.js';
import {
    METRIC_CATALOGUE,
    PUBLIC_PLACE_CATALOGUE,
    OUTREACH_CHANNEL_CATALOGUE,
    LONELINESS_KEYS
} from '../models/DistrictData.js';

/**
 * DataService
 * -----------
 * Single boundary between the UI and the data backend.
 *
 * The data backend is currently a static JSON file produced by
 * `scripts/build_database.py`. That file (schema v2) holds, for every
 * buurt, a year-indexed table of metrics:
 *
 *     neighborhoods[id].metricsByYear = {
 *       "2018": { lonely: 36.1, ... },
 *       ...
 *       "2026": { ... }
 *     }
 *
 * plus year-independent `publicPlaces` counts. Values are either real
 * CSV survey data (where the buurt's name matched) or deterministic,
 * seed-based pre-generated values; either way they are stable across
 * reloads.
 *
 * Two consumption patterns:
 *
 *   - Async, with simulated latency, for user-initiated clicks on a
 *     buurt: `fetchDistrictData(...)`. Returns the same shape as before.
 *   - Sync, used by the year-scrubber timeline to repaint instantly:
 *     `getDistrictDataSync(...)`. No latency.
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
            // `cache: 'reload'` forces a network round-trip and bypasses
            // any stale browser-cached copy of the database. Critical when
            // the schema is bumped (e.g. v1 -> v2) and the disk file has
            // grown new top-level fields that the previous cached payload
            // is missing.
            this._loadPromise = fetch(AppConfig.databasePath, { cache: 'reload' })
                .then(async (response) => {
                    if (!response.ok) {
                        throw new Error(`Failed to load database: HTTP ${response.status}`);
                    }
                    this._db = await response.json();
                    DataService._amplifyForDemo(this._db);
                    return this._db;
                });
        }
        return this._loadPromise;
    }

    /** @returns {number[]} ascending list of years available in the database. */
    getYears() {
        const ys = this._db?.years;
        if (Array.isArray(ys) && ys.length > 0) return ys.slice().sort((a, b) => a - b);
        // Fallback for the v1 schema or a missing list: synthesize a
        // single-year list around whatever default year we can recover.
        return [this.getDefaultYear()];
    }

    /** @returns {number} the year picked as default by the build script. */
    getDefaultYear() {
        return this._db?.defaultYear ?? this._db?.year ?? AppConfig.defaultYear;
    }

    /**
     * Synchronous lookup used by the timeline to repaint the sidebar
     * instantly when the user scrubs. Requires `load()` to have completed.
     *
     * @param {string} districtId
     * @param {number} year
     * @param {{ centroid?: [number, number], districtName?: string }} [opts]
     * @returns {import('../models/DistrictData.js').DistrictData & {source?: string, publicPlaces?: {key:string, count:number}[]}}
     */
    getDistrictDataSync(districtId, year, opts = {}) {
        if (!this._db) {
            throw new Error('DataService.getDistrictDataSync called before load()');
        }
        const record = this._db.neighborhoods?.[districtId];
        const centroid = opts.centroid ?? [0, 0];

        if (!record) {
            return {
                districtId,
                districtName: opts.districtName ?? '',
                year,
                centroid,
                source: 'missing',
                metrics: DataService._emptyMetrics(),
                publicPlaces: DataService._emptyPlaces(),
                outreachChannels: DataService._emptyOutreach()
            };
        }

        const resolvedYear = DataService._resolveYear(record, year, this._db);
        // v2: metricsByYear[year]. v1 (legacy): a single flat `metrics`
        // dict, used regardless of the requested year.
        const yearMetrics = record.metricsByYear?.[String(resolvedYear)]
                         ?? record.metrics
                         ?? {};

        return {
            districtId:       record.districtId,
            districtName:     record.districtName ?? opts.districtName ?? '',
            year:             resolvedYear,
            centroid,
            source:           record.source ?? 'unknown',
            metrics:          DataService._normalizeMetrics(yearMetrics),
            publicPlaces:     DataService._normalizePlaces(record.publicPlaces),
            outreachChannels: DataService._normalizeOutreach(record.outreachChannels)
        };
    }

    /**
     * Fetch the metrics dataset for a single neighborhood, simulating a
     * network round-trip via `fakeRequestMinMs/MaxMs`.
     *
     * @param {string}            districtId
     * @param {string}            districtName
     * @param {[number, number]}  centroid     - [longitude, latitude]
     * @param {Object}            [opts]
     * @param {number}            [opts.year]
     * @param {number}            [opts.population]
     * @returns {Promise<import('../models/DistrictData.js').DistrictData & {source?: string, publicPlaces?: {key:string, count:number}[]}>}
     */
    async fetchDistrictData(districtId, districtName, centroid, opts = {}) {
        await Promise.all([
            this.load(),
            this._simulateLatency()
        ]);

        const year = opts.year ?? this.getDefaultYear();

        try {
            return this.getDistrictDataSync(districtId, year, { centroid, districtName });
        } catch (err) {
            console.warn(`No database entry for ${districtId}; returning empty record.`, err);
            return {
                districtId,
                districtName,
                year,
                centroid,
                source: 'missing',
                metrics: DataService._emptyMetrics(),
                publicPlaces: DataService._emptyPlaces(),
                outreachChannels: DataService._emptyOutreach()
            };
        }
    }

    /** @private */
    _simulateLatency() {
        const delay = this._minLatencyMs + Math.random() * (this._maxLatencyMs - this._minLatencyMs);
        return new Promise(resolve => setTimeout(resolve, delay));
    }

    /**
     * Pick the closest available year inside `record.metricsByYear`. If
     * the requested year exists exactly, returns it. Otherwise falls back
     * to the database's default year, then to whatever the record happens
     * to provide.
     * @private
     */
    static _resolveYear(record, requestedYear, db) {
        const byYear = record?.metricsByYear ?? {};
        if (byYear[String(requestedYear)]) return requestedYear;
        const def = db?.defaultYear ?? db?.year;
        if (def != null && byYear[String(def)]) return def;
        const keys = Object.keys(byYear).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
        if (keys.length > 0) return keys[keys.length - 1];
        // Legacy v1 records: no metricsByYear, fall back to record.year
        // or db.year, finally the requested year as a last resort.
        return record?.year ?? def ?? requestedYear;
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

    /**
     * Same normalization pattern as `_normalizePlaces` but for the
     * `OUTREACH_CHANNEL_CATALOGUE` keys. Guarantees that every channel in
     * the catalogue is present in the returned array (filling missing
     * keys with 0) so the UI can render the full inventory grid even when
     * a buurt's record predates the catalogue addition.
     * @private
     */
    static _normalizeOutreach(input) {
        if (!Array.isArray(input)) return DataService._emptyOutreach();
        const byKey = new Map(input.map(c => [c.key, Number(c.count) || 0]));
        return OUTREACH_CHANNEL_CATALOGUE.map(def => ({
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

    /** @private */
    static _emptyOutreach() {
        return OUTREACH_CHANNEL_CATALOGUE.map(def => ({ key: def.key, count: 0 }));
    }

    // ----------------------------------------------------------------
    //  Demo amplification
    // ----------------------------------------------------------------

    /**
     * Mutates `db.neighborhoods[*].metricsByYear[*]` in place to amplify
     * the year-over-year variance of the four loneliness metrics. See
     * `AppConfig.demoTimelineAmplify` for the rationale.
     *
     * Per buurt, three deterministic ingredients combine into the year's
     * value (anchored on the buurt's mean):
     *
     *   1. Variance amplification of the raw deviations (factor).
     *   2. A bipolar linear ramp from the middle year out to the extremes.
     *      The ramp magnitude at the extremes is at least 40% of the
     *      configured max, so no buurt stays flat. Span-invariant: the
     *      maximum offset is `demoAmplifyTrendMaxPp` regardless of how
     *      many years the timeline covers.
     *   3. A sinusoidal "wave" component with per-buurt amplitude and
     *      phase, so even buurten with similar ramps don't move in
     *      lockstep — some peak mid-window, others trough.
     *
     * Determinism: all three components are seeded by the districtId via
     * an FNV-1a hash, so the same buurt always tells the same story.
     *
     * Safety: amplified values are clamped to [0, 100]. The 14
     * non-loneliness metrics are left untouched so the rest of the
     * sidebar stays anchored to reality.
     *
     * @private
     */
    static _amplifyForDemo(db) {
        if (!AppConfig.demoTimelineAmplify) return;
        const years = Array.isArray(db?.years) ? db.years.slice().sort((a, b) => a - b) : [];
        if (years.length < 2) return;

        const middle    = (years[0] + years[years.length - 1]) / 2;
        const span      = years[years.length - 1] - years[0];
        const halfSpan  = Math.max(1, span / 2);                   // pivot to extremes
        const factor    = AppConfig.demoAmplifyFactor    ?? 1;
        const trendMax  = AppConfig.demoAmplifyTrendMaxPp ?? 0;
        const waveMax   = AppConfig.demoAmplifyWaveMaxPp ?? 0;

        for (const [id, rec] of Object.entries(db.neighborhoods ?? {})) {
            if (!rec?.metricsByYear) continue;
            const { trendPp, waveAmp, wavePhase } = DataService._trajectoryFor(id, trendMax, waveMax);

            for (const key of LONELINESS_KEYS) {
                const series = years.map(y => rec.metricsByYear[String(y)]?.[key]);
                const finite = series.filter(Number.isFinite);
                if (finite.length === 0) continue;
                const mean = finite.reduce((a, b) => a + b, 0) / finite.length;

                for (let i = 0; i < years.length; i++) {
                    const year = years[i];
                    const m = rec.metricsByYear[String(year)];
                    if (!m) continue;
                    const raw = series[i];
                    if (!Number.isFinite(raw)) continue;
                    // Linear ramp in [-trendPp, +trendPp] — span-invariant.
                    const ramp = trendPp * ((year - middle) / halfSpan);
                    // One full sine cycle across the year span — so peaks
                    // and troughs land inside the slider, not at the edges.
                    const wave = waveAmp * Math.sin(
                        2 * Math.PI * (year - years[0]) / Math.max(1, span) + wavePhase
                    );
                    const amplified = mean + (raw - mean) * factor + ramp + wave;
                    m[key] = Math.max(0, Math.min(100, Math.round(amplified * 10) / 10));
                }
            }
        }
    }

    /**
     * Deterministic per-buurt trajectory parameters.
     *
     *   trendPp   : max pp offset at the extreme years (bipolar);
     *               magnitude in [0.4*trendMax, trendMax]
     *   waveAmp   : pp peak amplitude in [0.4*waveMax, waveMax]
     *   wavePhase : 0..2π
     *
     * @private
     */
    static _trajectoryFor(id, trendMax, waveMax) {
        const a = DataService._hashUnit(id, 'trend');
        const b = DataService._hashUnit(id, 'wave-amp');
        const c = DataService._hashUnit(id, 'wave-phase');

        const sign = a < 0.5 ? -1 : 1;
        const t    = a < 0.5 ? a * 2 : (a - 0.5) * 2;        // [0, 1)
        // Keep the inner 40% of the range empty so no buurt is flat.
        const trendPp = sign * (trendMax * 0.4 + t * trendMax * 0.6);

        const waveAmp = waveMax * (0.4 + b * 0.6);
        const wavePhase = c * 2 * Math.PI;
        return { trendPp, waveAmp, wavePhase };
    }

    /** FNV-1a hash of (id, salt) mapped to [0, 1). @private */
    static _hashUnit(id, salt) {
        let h = 2166136261 >>> 0;
        const str = `${id}|${salt}`;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return (h >>> 0) / 4294967296;
    }
}
