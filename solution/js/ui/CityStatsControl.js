/**
 * CityStatsControl
 * ----------------
 * MapLibre control showing three rotterdam-wide aggregates of the
 * loneliness data:
 *
 *   - Average loneliness composite across residential buurten
 *   - Number of buurten in the "high" tier (composite >= 45)
 *   - Sum of residents living in those "high" buurten
 *
 * Each row also displays a delta against the timeline's baseline year
 * (the earliest year present in `feat.properties.lonelinessByYear`).
 * As the user scrubs the slider, `update(year)` re-computes and
 * re-renders — making the city numbers move in lockstep with the map.
 *
 * Data flow:
 *   - The FeatureCollection is the source of truth. Every feature has
 *     `category`, `population`, `lonelinessByYear` (set by
 *     `enrichFeaturesWithLoneliness` in app.js).
 *   - `update(year)` is invoked by `MapController.updateCityStats(...)`
 *     which itself is called by app.js on timeline events.
 *
 * No event listeners; this control is purely a re-render target.
 */

/** Tier threshold that mirrors SidebarController._lonelinessTier. */
const HIGH_LONELINESS_THRESHOLD = 45;

export class CityStatsControl {
    /**
     * @param {Object} options
     * @param {GeoJSON.FeatureCollection} options.fc
     * @param {number} [options.initialYear]
     */
    constructor(options) {
        this._fc = options.fc;
        this._initialYear = options.initialYear ?? null;
        const { min, max } = CityStatsControl._inferYearBounds(this._fc);
        this._baseYear = min;
        this._latestYear = max;
        this._baseStats = this._baseYear != null
            ? this._compute(this._baseYear)
            : { avg: 0, highCount: 0, highPop: 0, totalCount: 0 };
        /** @type {HTMLElement|null} */
        this._el = null;
        // Default to the latest year so the initial render matches the
        // colours the map is showing (enrichment seeds lonelinessScore
        // from the database's defaultYear).
        this._currentYear = this._initialYear ?? this._latestYear ?? this._baseYear;
    }

    onAdd() {
        const el = document.createElement('div');
        el.className = 'maplibregl-ctrl city-stats';
        this._el = el;
        if (this._currentYear != null) this._renderYear(this._currentYear);
        return el;
    }

    onRemove() {
        if (this._el?.parentNode) this._el.parentNode.removeChild(this._el);
        this._el = null;
    }

    /** @param {number} year */
    update(year) {
        this._currentYear = year;
        if (!this._el) return;
        this._renderYear(year);
    }

    // ----------------------------------------------------------------
    //  Rendering
    // ----------------------------------------------------------------

    /** @private */
    _renderYear(year) {
        const stats = this._compute(year);
        const isBase = year === this._baseYear;

        const rows = [
            CityStatsControl._renderRow({
                label: 'Average loneliness',
                value: `${stats.avg.toFixed(1)}<small>%</small>`,
                delta: isBase ? null : this._formatPpDelta(stats.avg, this._baseStats.avg)
            }),
            CityStatsControl._renderRow({
                label: 'High-loneliness buurten',
                value: `${stats.highCount}<small>/${stats.totalCount}</small>`,
                delta: isBase ? null : CityStatsControl._formatCountDelta(stats.highCount, this._baseStats.highCount, this._baseYear)
            }),
            CityStatsControl._renderRow({
                label: 'Residents at risk',
                value: CityStatsControl._formatCompact(stats.highPop),
                delta: isBase ? null : CityStatsControl._formatPopDelta(stats.highPop, this._baseStats.highPop, this._baseYear)
            })
        ];

        this._el.innerHTML = `
            <div class="city-stats__header">
                <span class="city-stats__eyebrow">Rotterdam overview</span>
                <span class="city-stats__year">${year}</span>
            </div>
            <ul class="city-stats__list">${rows.join('')}</ul>
        `;
    }

    /** @private */
    static _renderRow({ label, value, delta }) {
        const deltaHtml = delta
            ? `<span class="city-stats__delta city-stats__delta--${delta.tone}">${delta.text}</span>`
            : `<span class="city-stats__delta city-stats__delta--neutral">Baseline year</span>`;
        return `
            <li class="city-stats__row">
                <div class="city-stats__row-top">
                    <span class="city-stats__lbl">${label}</span>
                    <span class="city-stats__num">${value}</span>
                </div>
                ${deltaHtml}
            </li>
        `;
    }

    // ----------------------------------------------------------------
    //  Aggregation
    // ----------------------------------------------------------------

    /**
     * Walks the FC once and produces all three aggregates for the year.
     * Only residential buurten contribute — the non-residential ones
     * (harbour / business / green) are excluded as they were on the
     * sidebar too.
     * @private
     */
    _compute(year) {
        let totalScore = 0;
        let totalCount = 0;
        let highCount = 0;
        let highPop = 0;

        for (const feat of this._fc.features) {
            const props = feat.properties;
            if (!props) continue;
            if (props.category !== 'residential') continue;
            const score = props.lonelinessByYear?.[year];
            if (!Number.isFinite(score)) continue;

            totalScore += score;
            totalCount += 1;

            if (score >= HIGH_LONELINESS_THRESHOLD) {
                highCount += 1;
                highPop += Number(props.population) || 0;
            }
        }

        return {
            avg: totalCount > 0 ? totalScore / totalCount : 0,
            highCount,
            highPop,
            totalCount
        };
    }

    /**
     * Walk every feature's `lonelinessByYear` and return the smallest /
     * largest year present anywhere in the FC.
     * @private
     */
    static _inferYearBounds(fc) {
        let min = Infinity;
        let max = -Infinity;
        for (const feat of fc.features) {
            const byYear = feat.properties?.lonelinessByYear;
            if (!byYear) continue;
            for (const k of Object.keys(byYear)) {
                const y = Number(k);
                if (!Number.isFinite(y)) continue;
                if (y < min) min = y;
                if (y > max) max = y;
            }
        }
        return {
            min: min === Infinity  ? null : min,
            max: max === -Infinity ? null : max
        };
    }

    // ----------------------------------------------------------------
    //  Delta formatting (good = downward, bad = upward)
    // ----------------------------------------------------------------

    /** @private */
    _formatPpDelta(cur, base) {
        const d = cur - base;
        if (Math.abs(d) < 0.05) {
            return { text: `unchanged vs ${this._baseYear}`, tone: 'neutral' };
        }
        const tone = d > 0 ? 'bad' : 'good';
        const arrow = d > 0 ? '↑' : '↓';
        return {
            text: `${arrow} ${Math.abs(d).toFixed(1)} pp vs ${this._baseYear}`,
            tone
        };
    }

    /** @private */
    static _formatCountDelta(cur, base, baseYear) {
        const d = cur - base;
        if (d === 0) return { text: `unchanged vs ${baseYear}`, tone: 'neutral' };
        const tone = d > 0 ? 'bad' : 'good';
        const sign = d > 0 ? '+' : '−';
        return { text: `${sign}${Math.abs(d)} vs ${baseYear}`, tone };
    }

    /** @private */
    static _formatPopDelta(cur, base, baseYear) {
        const d = cur - base;
        if (Math.abs(d) < 50) return { text: `unchanged vs ${baseYear}`, tone: 'neutral' };
        const tone = d > 0 ? 'bad' : 'good';
        const sign = d > 0 ? '+' : '−';
        return {
            text: `${sign}${CityStatsControl._formatCompact(Math.abs(d))} vs ${baseYear}`,
            tone
        };
    }

    /**
     * 86420 -> "86.4k", 1240000 -> "1.24M". Falls back to a localized
     * integer for values under 1,000.
     * @private
     */
    static _formatCompact(n) {
        const abs = Math.abs(n);
        if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
        if (abs >= 10_000)    return `${Math.round(n / 1_000)}k`;
        if (abs >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
        return Math.round(n).toLocaleString();
    }
}
