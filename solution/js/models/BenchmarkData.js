/**
 * BenchmarkData
 * -------------
 * Per the trimmed scope, the demo ships with a single hardcoded
 * Rotterdam 2030 well-being target. There is no UI to author or save
 * custom benchmarks — that flow is documented in IMPLEMENTATION_PLAN.md
 * Section 7.7 as a follow-up if/when policy targets are versioned.
 *
 * Values reflect a plausible policy target: ~30 % relative reduction
 * versus 2022 city averages for the four loneliness sub-metrics, with
 * matching targets for the most informative co-indicators. They are NOT
 * an official municipal target — only a defensible placeholder so the
 * radar chart has something to overlay.
 */

/**
 * @typedef {Object} BenchmarkTarget
 * @property {string}                  id
 * @property {string}                  name
 * @property {number}                  year
 * @property {Object.<string, number>} targets   - metricKey → target percentage
 * @property {string}                  [source]  - human-readable provenance
 */

/** @type {BenchmarkTarget} */
export const DEFAULT_BENCHMARK = Object.freeze({
    id: 'rotterdam-2030-target',
    name: 'Rotterdam 2030 well-being target',
    year: 2030,
    targets: Object.freeze({
        lonely:                       38,
        severelyLonely:                9,
        emotionallyLonely:            24,
        sociallyLonely:               27,
        strugglingMakeEnds:           14,
        receivesSupportFromOthers:    20,
        volunteerWork:                32,
        highRiskAnxietyOrDepression:  12,
        veryMuchStressLast4Weeks:     20,
        weeklyExercising:             62
    }),
    source: 'Placeholder; not an official municipal target.'
});
