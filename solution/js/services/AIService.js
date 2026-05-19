import { AppConfig } from '../config.js';
import {
    METRIC_CATALOGUE,
    PUBLIC_PLACE_CATALOGUE,
    LONELINESS_KEYS
} from '../models/DistrictData.js';
import { AI_STAGES } from '../models/RecommendationData.js';

/**
 * AIService
 * ---------
 * Stand-in for a real LLM call. Produces a list of structured
 * `Recommendation` entities tailored to a single neighborhood, while
 * simulating a multi-stage thinking process the UI can visualize
 * (Analyzing -> Thinking -> Generating).
 *
 * The public shape is intentionally close to a future server call:
 *
 *     const recs = await aiService.generate(districtData, { onStage })
 *
 * Replacing this with a real backend later: keep `generate()` and the
 * `Recommendation` shape, swap the body for `fetch(...)`. No UI changes.
 *
 * Determinism:
 *   The list is seeded by `districtData.districtId` so the same buurt
 *   always yields the same recommendations — matching the convention
 *   used elsewhere in the demo (see `scripts/build_database.py`).
 */
export class AIService {
    /**
     * @param {Object} [options]
     * @param {number} [options.stageMinMs]
     * @param {number} [options.stageMaxMs]
     */
    constructor(options = {}) {
        this._stageMinMs = options.stageMinMs ?? AppConfig.aiStageMinMs;
        this._stageMaxMs = options.stageMaxMs ?? AppConfig.aiStageMaxMs;
    }

    /**
     * Generate recommendations for one district.
     *
     * @param {import('../models/DistrictData.js').DistrictData & {
     *   publicPlaces?: {key:string, count:number}[],
     *   meta?: {category?: string, population?: number, parentDistrict?: string}
     * }} districtData
     * @param {Object} [opts]
     * @param {(stageId: string) => void} [opts.onStage]
     *   Called with each stage id from AI_STAGES *before* its delay runs,
     *   so the UI can update its loader.
     * @returns {Promise<import('../models/RecommendationData.js').Recommendation[]>}
     */
    async generate(districtData, opts = {}) {
        const onStage = typeof opts.onStage === 'function' ? opts.onStage : () => {};

        for (const stage of AI_STAGES) {
            onStage(stage.id);
            await this._delay();
        }

        return AIService._compose(districtData);
    }

    /** @private */
    _delay() {
        const ms = this._stageMinMs + Math.random() * (this._stageMaxMs - this._stageMinMs);
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ----------------------------------------------------------------
    //  Synthesis
    // ----------------------------------------------------------------

    /**
     * Pure function: takes a district's data and returns a deterministic
     * Recommendation[] derived from its actual metrics & places.
     * @private
     */
    static _compose(districtData) {
        const metrics = districtData?.metrics ?? {};
        const placesByKey = new Map(
            (districtData?.publicPlaces ?? []).map(p => [p.key, p.count])
        );
        const seed = AIService._hashSeed(districtData?.districtId ?? 'unknown');
        const rng  = AIService._seededRng(seed);

        const candidates = [
            ...AIService._eventCandidates(metrics, placesByKey),
            ...AIService._placeCandidates(metrics, placesByKey),
            ...AIService._reductionCandidates(metrics, placesByKey),
            ...AIService._policyCandidates(metrics, placesByKey)
        ].filter(Boolean);

        return AIService._selectFinal(candidates, rng);
    }

    /**
     * Score-rank, ensure kind diversity, and trim to 5-6 entries.
     * Deterministic given `rng`.
     * @private
     */
    static _selectFinal(candidates, rng) {
        const priorityWeight = { high: 3, medium: 2, low: 1 };

        const withJitter = candidates.map(rec => ({
            rec,
            // Tiny deterministic jitter so equal-priority items don't
            // always sort in declaration order.
            score: priorityWeight[rec.priority] * 100 + rng() * 10
        }));
        withJitter.sort((a, b) => b.score - a.score);

        const final = [];
        const seenKinds = new Set();

        // Pass 1: take the top-ranked of each kind we've not seen yet,
        // so the result always spans as many kinds as we have candidates for.
        for (const { rec } of withJitter) {
            if (final.length >= 6) break;
            if (seenKinds.has(rec.kind)) continue;
            final.push(rec);
            seenKinds.add(rec.kind);
        }
        // Pass 2: fill remaining slots with the next best regardless of kind.
        for (const { rec } of withJitter) {
            if (final.length >= 6) break;
            if (final.includes(rec)) continue;
            final.push(rec);
        }

        return final;
    }

    // ----------------------------------------------------------------
    //  Candidate generators
    // ----------------------------------------------------------------

    /** @private */
    static _eventCandidates(metrics, places) {
        /** @type {import('../models/RecommendationData.js').EventRecommendation[]} */
        const out = [];
        const sev   = metrics.severelyLonely     ?? 0;
        const soc   = metrics.sociallyLonely     ?? 0;
        const emo   = metrics.emotionallyLonely  ?? 0;
        const move  = metrics.movementImpairment ?? 0;
        const health = metrics.goodExperiencedHealth ?? 100;
        const vol   = metrics.volunteerWork       ?? 0;
        const exer  = metrics.weeklyExercising    ?? 0;

        if (sev >= 12) {
            out.push({
                kind: 'event',
                title: 'Weekly community lunch for seniors',
                rationale: `Severe loneliness here is ${sev.toFixed(1)}% — well above the city average. A recurring shared meal lowers the threshold to first contact.`,
                audience: 'Residents 65+ living alone',
                recurrence: 'Weekly · Saturdays 12:00',
                venuePlaceKey: AIService._pickVenue(places, ['communityCenter', 'seniorCenter', 'religiousVenue']),
                expectedImpact: { metric: 'severelyLonely', delta: -3.2 },
                priority: sev >= 18 ? 'high' : 'medium'
            });
        }

        if (soc >= 32) {
            out.push({
                kind: 'event',
                title: 'Neighborhood game night',
                rationale: `Social loneliness sits at ${soc.toFixed(1)}%. Low-stakes group activities create new weak ties without requiring a long commitment.`,
                audience: 'All adults, families welcome',
                recurrence: 'Monthly · first Friday',
                venuePlaceKey: AIService._pickVenue(places, ['communityCenter', 'library', 'cafe']),
                expectedImpact: { metric: 'sociallyLonely', delta: -2.8 },
                priority: soc >= 40 ? 'high' : 'medium'
            });
        }

        if (emo >= 28 && vol < 28) {
            out.push({
                kind: 'event',
                title: 'Peer support circle',
                rationale: `Emotional loneliness (${emo.toFixed(1)}%) is paired with below-average volunteering. Facilitated small groups give residents a place to talk about close-relationship needs.`,
                audience: 'Adults experiencing isolation',
                recurrence: 'Bi-weekly · evenings',
                venuePlaceKey: AIService._pickVenue(places, ['communityCenter', 'library', 'religiousVenue']),
                expectedImpact: { metric: 'emotionallyLonely', delta: -2.1 },
                priority: emo >= 35 ? 'high' : 'medium'
            });
        }

        if (move >= 8 || (health < 72 && exer < 58)) {
            out.push({
                kind: 'event',
                title: 'Walking & coffee group',
                rationale: `Movement impairment (${move.toFixed(1)}%) and below-average weekly exercise (${exer.toFixed(1)}%) suggest a low-barrier outdoor activity would resonate.`,
                audience: 'Mixed ages, walking-paced',
                recurrence: 'Weekly · Wednesday mornings',
                venuePlaceKey: AIService._pickVenue(places, ['park', 'communityCenter']),
                expectedImpact: { metric: 'weeklyExercising', delta: +2.6 },
                priority: 'medium'
            });
        }

        return out;
    }

    /** @private */
    static _placeCandidates(metrics, places) {
        /** @type {import('../models/RecommendationData.js').PlaceRecommendation[]} */
        const out = [];
        const lonely = metrics.lonely           ?? 0;
        const sev    = metrics.severelyLonely   ?? 0;
        const soc    = metrics.sociallyLonely   ?? 0;
        const community = places.get('communityCenter') ?? 0;
        const senior    = places.get('seniorCenter')    ?? 0;
        const library   = places.get('library')         ?? 0;
        const park      = places.get('park')            ?? 0;

        if (community === 0 && (lonely >= 38 || soc >= 32)) {
            out.push({
                kind: 'place',
                title: 'Build a community center',
                rationale: 'The buurt currently has no community center — the single facility type most consistently associated with reduced loneliness in the literature.',
                action: 'build',
                placeKey: 'communityCenter',
                quantity: 1,
                expectedImpact: { metric: 'sociallyLonely', delta: -4.1 },
                priority: 'high'
            });
        }

        if (senior === 0 && sev >= 14) {
            out.push({
                kind: 'place',
                title: 'Open a senior drop-in center',
                rationale: `Severe loneliness (${sev.toFixed(1)}%) skews to the 65+ cohort; a small senior-focused space addresses it directly.`,
                action: 'build',
                placeKey: 'seniorCenter',
                quantity: 1,
                expectedImpact: { metric: 'severelyLonely', delta: -3.6 },
                priority: 'high'
            });
        }

        if (park === 0 && lonely >= 40) {
            out.push({
                kind: 'place',
                title: 'Create a pocket park',
                rationale: 'No green space in the buurt — small parks raise the baseline rate of incidental encounters between residents.',
                action: 'build',
                placeKey: 'park',
                quantity: 1,
                expectedImpact: { qualitative: 'Improves incidental social contact' },
                priority: 'medium'
            });
        }

        if (library === 0 && (lonely >= 35 || soc >= 30)) {
            out.push({
                kind: 'place',
                title: 'Add a branch library',
                rationale: 'Libraries serve as one of the few non-commercial indoor "third places". A nearby branch lowers the barrier for solo residents to leave the house.',
                action: 'build',
                placeKey: 'library',
                quantity: 1,
                expectedImpact: { metric: 'lonely', delta: -1.8 },
                priority: 'medium'
            });
        }

        if (community >= 1 && lonely >= 45) {
            out.push({
                kind: 'place',
                title: 'Expand the existing community center',
                rationale: `Even with a community center in place, overall loneliness (${lonely.toFixed(1)}%) is high — current capacity may be the bottleneck.`,
                action: 'expand',
                placeKey: 'communityCenter',
                quantity: 1,
                expectedImpact: { metric: 'lonely', delta: -1.4 },
                priority: 'medium'
            });
        }

        return out;
    }

    /** @private */
    static _reductionCandidates(metrics, places) {
        /** @type {import('../models/RecommendationData.js').ReductionRecommendation[]} */
        const out = [];
        const lonely    = metrics.lonely          ?? 0;
        const community = places.get('communityCenter') ?? 0;
        const cafe      = places.get('cafe')            ?? 0;
        const transit   = places.get('transitStop')     ?? 0;

        if (cafe >= 8 && community === 0) {
            out.push({
                kind: 'reduction',
                title: 'Convert one café unit to community use',
                rationale: `${cafe} cafés serve mostly transient customers and don't replace a community center. Repurposing one underused unit creates room for organized activities.`,
                targetLabel: 'Saturated commercial hospitality',
                expectedImpact: { metric: 'sociallyLonely', delta: -1.6 },
                priority: 'medium'
            });
        }

        if (lonely >= 40) {
            out.push({
                kind: 'reduction',
                title: 'Reduce through-traffic on main residential street',
                rationale: 'Heavy car traffic suppresses sidewalk life and informal neighbor contact. Even a partial filter (school hours, weekends) improves perceived safety.',
                targetLabel: 'Through-traffic / car dominance',
                expectedImpact: { qualitative: 'Improves perceived street safety & contact' },
                priority: lonely >= 50 ? 'high' : 'medium'
            });
        }

        if (transit >= 6 && community === 0 && lonely >= 35) {
            out.push({
                kind: 'reduction',
                title: 'Remove one redundant transit stop, fund a meeting room',
                rationale: 'Stop density is high while social infrastructure is absent. Redirecting maintenance budget toward a small meeting room has a stronger loneliness payoff per euro.',
                targetLabel: 'Over-dense transit infrastructure',
                expectedImpact: { qualitative: 'Reallocates capex toward social infra' },
                priority: 'low'
            });
        }

        return out;
    }

    /** @private */
    static _policyCandidates(metrics, places) {
        /** @type {import('../models/RecommendationData.js').PolicyRecommendation[]} */
        const out = [];
        const sev     = metrics.severelyLonely      ?? 0;
        const lonely  = metrics.lonely              ?? 0;
        const vol     = metrics.volunteerWork       ?? 0;
        const support = metrics.receivesSupportFromOthers ?? 0;
        const struggling = metrics.strugglingMakeEnds ?? 0;
        const anxiety = metrics.highRiskAnxietyOrDepression ?? 0;
        const transit = places.get('transitStop')   ?? 0;

        if (sev >= 12 && transit < 8) {
            out.push({
                kind: 'policy',
                title: 'Mobility vouchers for residents 65+',
                rationale: `Severe loneliness (${sev.toFixed(1)}%) co-occurs with limited transit. Free off-peak rides remove one of the main practical barriers to leaving home.`,
                department: 'Mobility & Transport',
                expectedImpact: { metric: 'severelyLonely', delta: -1.9 },
                priority: 'high'
            });
        }

        if (vol >= 26 && lonely >= 42) {
            out.push({
                kind: 'policy',
                title: 'Fund a local "buddy" matching program',
                rationale: `Volunteering rate (${vol.toFixed(1)}%) is healthy; a small grant to an existing NGO can pair willing volunteers with isolated residents at low marginal cost.`,
                department: 'Social Affairs',
                expectedImpact: { metric: 'lonely', delta: -2.4 },
                priority: 'medium'
            });
        }

        if (anxiety >= 16) {
            out.push({
                kind: 'policy',
                title: 'Train front-desk staff at GP clinics in loneliness screening',
                rationale: `Anxiety/depression risk (${anxiety.toFixed(1)}%) often presents first at primary care. A 2-question screen at intake routes residents to social prescribing.`,
                department: 'Public Health',
                expectedImpact: { metric: 'highRiskAnxietyOrDepression', delta: -1.1 },
                priority: 'medium'
            });
        }

        if (struggling >= 22 && support < 14) {
            out.push({
                kind: 'policy',
                title: 'Co-locate financial advice in community spaces',
                rationale: `Financial strain (${struggling.toFixed(1)}%) is high while informal support (${support.toFixed(1)}%) is low. Drop-in money clinics in social venues reach residents who avoid formal services.`,
                department: 'Social Affairs',
                expectedImpact: { qualitative: 'Reduces strain-driven withdrawal' },
                priority: 'medium'
            });
        }

        return out;
    }

    // ----------------------------------------------------------------
    //  Helpers
    // ----------------------------------------------------------------

    /**
     * Pick the first available venue key from the preference list,
     * falling back to the first preference even if missing (the UI will
     * present it as "build/use a ...").
     * @private
     */
    static _pickVenue(placesByKey, preferences) {
        for (const key of preferences) {
            if ((placesByKey.get(key) ?? 0) > 0) return key;
        }
        return preferences[0];
    }

    /**
     * Cheap, deterministic 32-bit string hash (xfnv1a-style). Same input
     * always produces the same seed.
     * @private
     */
    static _hashSeed(str) {
        let h = 2166136261 >>> 0;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return h >>> 0;
    }

    /**
     * Mulberry32 — small deterministic PRNG. Output in [0, 1).
     * @private
     */
    static _seededRng(seed) {
        let t = seed >>> 0;
        return function next() {
            t = (t + 0x6D2B79F5) >>> 0;
            let r = t;
            r = Math.imul(r ^ (r >>> 15), r | 1);
            r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
            return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
        };
    }
}

// Re-export so callers can find catalogues in one place if needed.
export { METRIC_CATALOGUE, PUBLIC_PLACE_CATALOGUE, LONELINESS_KEYS };
