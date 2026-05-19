/**
 * PopulationSegment
 * -----------------
 * Predefined demographic segments used by the Audiences tab. Per the
 * trimmed scope, the UI does NOT let users author custom segments — the
 * five system segments below cover the policy questions the audience-
 * first view is meant to answer.
 *
 * Each segment is a `DemographicFilter` plus presentation metadata. Two
 * runtime consumers:
 *
 *   - `PopulationTargetView` — renders the segment cards in the left
 *     column, calls `DemographicService.getPopulationShare(filter)` for
 *     the "% of survey population" badge.
 *   - `AIService.generateForSegment(segment, buurtenData)` — uses the
 *     filter to aggregate metrics across the highest-risk buurten.
 */

/**
 * @typedef {Object} PopulationSegment
 * @property {string}                                       id
 * @property {string}                                       name
 * @property {string}                                       summary
 * @property {import('./DemographicData.js').DemographicFilter} filter
 * @property {string}                                       [reachKind]
 *   Hint for the reach-method recommendation engine: which broad
 *   cohort behaviour applies. Matches the `cohort` field in
 *   `MARKETING_CHANNELS`.
 */

/** @type {PopulationSegment[]} */
export const SYSTEM_SEGMENTS = Object.freeze([
    {
        id: 'young-adults',
        name: 'Young adults 18–24',
        summary: 'Highest social-media reachability; emotional loneliness peaks here, often tied to study and first-job transitions.',
        filter: { ages: ['18-24'] },
        reachKind: 'youth'
    },
    {
        id: 'young-women',
        name: 'Young women 18–24',
        summary: 'A sub-cohort that consistently reports higher anxiety/depression risk than peers; responds to expressive event formats.',
        filter: { ages: ['18-24'], genders: ['Female'] },
        reachKind: 'youth'
    },
    {
        id: 'middle-aged',
        name: 'Middle-aged adults 35–54',
        summary: 'Most likely to volunteer; effective when targeted via workplace channels and school networks.',
        filter: { ages: ['35-44', '45-54'] },
        reachKind: 'family'
    },
    {
        id: 'older-adults',
        name: 'Older adults 55–64',
        summary: 'Severe-loneliness signals emerge here; respond best to GP referrals, trusted-face flyers, and welzijn outreach.',
        filter: { ages: ['55-64'] },
        reachKind: 'senior'
    },
    {
        id: 'older-women',
        name: 'Older women 55–64',
        summary: 'Highest known-affected cohort for emotional loneliness; small-format wellbeing groups out-perform mass-reach campaigns.',
        filter: { ages: ['55-64'], genders: ['Female'] },
        reachKind: 'senior'
    }
]);

/**
 * Reach-method recommendation table used by `PopulationTargetView`.
 * Maps the cohort hint baked into each segment to an ordered list of
 * channel keys (matching `MARKETING_CHANNELS`) most likely to land for
 * that cohort. Order is the recommendation ordering, not alphabetical.
 */
export const REACH_METHODS_BY_COHORT = Object.freeze({
    youth: Object.freeze([
        { channel: 'social_media',   rationale: 'Highest organic reach for under-25s; cheap to A/B test creative.' },
        { channel: 'school_network', rationale: 'University & MBO student networks forward event invites at a higher rate than direct mail.' },
        { channel: 'whatsapp_group', rationale: 'Buurtapp groups are how this cohort hears about hyper-local events from peers.' }
    ]),
    family: Object.freeze([
        { channel: 'school_network', rationale: 'Newsletters that kids physically carry home into the kitchen out-perform direct-to-parent mail.' },
        { channel: 'newsletter',     rationale: 'Local press inserts reach parents on the school run and weekend errands.' },
        { channel: 'whatsapp_group', rationale: 'Active buurtapp groups amplify weekend family-friendly events.' }
    ]),
    senior: Object.freeze([
        { channel: 'gp_referral',    rationale: 'Housebound residents see the GP routinely; social-prescribing intake is the strongest single channel.' },
        { channel: 'social_worker',  rationale: 'Welzijn door-knocks reach residents who distrust formal channels and rarely see posters.' },
        { channel: 'flyer',          rationale: 'A trusted-face flyer drop primes the doorstep visit and signals legitimacy.' }
    ]),
    broad: Object.freeze([
        { channel: 'flyer',          rationale: 'Lowest-friction baseline reach across all demographics.' },
        { channel: 'community_screen', rationale: 'Digital screens at community centres pick up the residents who self-serve.' },
        { channel: 'newsletter',     rationale: 'Mass distribution at low marginal cost; broad cohort, low precision.' }
    ])
});
