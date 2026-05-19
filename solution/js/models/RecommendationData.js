/**
 * RecommendationData
 * -------------------
 * Shape of the AI-generated recommendations that the (fake) AIService
 * produces for a single neighborhood.
 *
 * The list is a discriminated union over `kind`, so each card type
 * keeps its own specific fields while sharing a small common header
 * (`title`, `rationale`, `priority`, `expectedImpact`).
 *
 * The keys used inside recommendations deliberately reuse identifiers
 * from `DistrictData.js`:
 *
 *   - `venuePlaceKey` / `placeKey` -> keys from PUBLIC_PLACE_CATALOGUE
 *   - `expectedImpact.metric`      -> keys from METRIC_CATALOGUE
 *
 * That way the UI can resolve human-readable labels and icons from a
 * single source of truth without the AI having to inline strings.
 */

/** @typedef {'event'|'place'|'reduction'|'policy'} RecommendationKind */
/** @typedef {'high'|'medium'|'low'} RecommendationPriority */

/**
 * @typedef {{ metric: string, delta: number } | { qualitative: string }} ExpectedImpact
 *
 * - `{ metric, delta }`     - quantitative; metric is a key from
 *                             METRIC_CATALOGUE, delta is a signed
 *                             percentage-point change (negative = better
 *                             for `highIsBad` metrics).
 * - `{ qualitative }`       - free text when an indicator is not a
 *                             clean fit (e.g. "Improves social cohesion").
 */

/**
 * @typedef {Object} BaseRecommendation
 * @property {RecommendationKind}     kind
 * @property {string}                 title
 * @property {string}                 rationale
 * @property {RecommendationPriority} priority
 * @property {ExpectedImpact}         expectedImpact
 */

/**
 * @typedef {BaseRecommendation & {
 *   kind: 'event',
 *   audience: string,
 *   recurrence: string,
 *   venuePlaceKey?: string
 * }} EventRecommendation
 */

/**
 * @typedef {BaseRecommendation & {
 *   kind: 'place',
 *   action: 'build'|'expand'|'renovate',
 *   placeKey: string,
 *   quantity: number
 * }} PlaceRecommendation
 */

/**
 * @typedef {BaseRecommendation & {
 *   kind: 'reduction',
 *   targetLabel: string
 * }} ReductionRecommendation
 */

/**
 * @typedef {BaseRecommendation & {
 *   kind: 'policy',
 *   department: string
 * }} PolicyRecommendation
 */

/**
 * @typedef {EventRecommendation
 *         | PlaceRecommendation
 *         | ReductionRecommendation
 *         | PolicyRecommendation} Recommendation
 */

/**
 * Ordered presentation metadata for the four recommendation kinds.
 * `order` controls the section order in the rendered output; `icon`,
 * `label` and `tone` are consumed by RecommendationView when building
 * cards and section headers.
 *
 * `tone` maps to existing CSS tokens (--accent / --good / --warn / --bad)
 * so the recommendation panel reuses the same palette as the stats view.
 */
export const RECOMMENDATION_KINDS = Object.freeze({
    event:     { order: 0, label: 'Event',          icon: '🎉', tone: 'accent' },
    place:     { order: 1, label: 'Public place',   icon: '🏛',  tone: 'good'   },
    reduction: { order: 2, label: 'Reduce / remove', icon: '🚫', tone: 'bad'    },
    policy:    { order: 3, label: 'Policy action',  icon: '📋', tone: 'warn'   }
});

/** Human-readable labels for the three AI processing stages. */
export const AI_STAGES = Object.freeze([
    {
        id: 'analyzing',
        label: 'Analyzing',
        detail: 'Reading health and social indicators'
    },
    {
        id: 'thinking',
        label: 'Thinking',
        detail: 'Cross-referencing public-place inventory'
    },
    {
        id: 'generating',
        label: 'Generating',
        detail: 'Drafting tailored interventions'
    }
]);

/** @type {RecommendationPriority[]} */
export const PRIORITY_ORDER = Object.freeze(['high', 'medium', 'low']);
