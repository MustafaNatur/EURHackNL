import { AppConfig } from '../config.js';
import {
    METRIC_CATALOGUE,
    PUBLIC_PLACE_CATALOGUE,
    LONELINESS_KEYS
} from '../models/DistrictData.js';
import { AI_STAGES } from '../models/RecommendationData.js';

/**
 * Per-channel "reach factor" used to translate a channel's count into
 * an estimate of unique residents reached by a campaign that uses it.
 *
 * Values are deliberately conservative single-week reach figures so the
 * aggregate stays plausible for a small buurt (~1k residents) without
 * overflowing into "everyone in the city" for the larger ones.
 */
const CHANNEL_REACH_FACTOR = Object.freeze({
    adBanner:               1200,   // single panel · weekly impressions
    busShelterPoster:        650,
    mailboxFlyer:              1,   // count is already a household count
    localPressInsert:          1,   // count is already a reach count
    gpClinicPoster:          240,
    pharmacyPoster:          220,
    libraryNoticeBoard:      180,
    supermarketBoard:        260,
    schoolNewsletter:        420,
    religiousVenueBulletin:  380,
    communityScreen:         310,
    neighborhoodWhatsApp:     90,   // members per group · 1 push
    doorToDoor:               75    // households visited per outreach worker / week
});

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
     * Recommendation[] derived from its actual metrics, places, and
     * outreach-channel inventory.
     * @private
     */
    static _compose(districtData) {
        const metrics = districtData?.metrics ?? {};
        const placesByKey = new Map(
            (districtData?.publicPlaces ?? []).map(p => [p.key, p.count])
        );
        const channelsByKey = new Map(
            (districtData?.outreachChannels ?? []).map(c => [c.key, c.count])
        );
        const population = Number(districtData?.meta?.population) || 0;
        const seed = AIService._hashSeed(districtData?.districtId ?? 'unknown');
        const rng  = AIService._seededRng(seed);

        const candidates = [
            ...AIService._outreachCandidates(metrics, channelsByKey, population),
            ...AIService._eventCandidates(metrics, placesByKey),
            ...AIService._placeCandidates(metrics, placesByKey),
            ...AIService._reductionCandidates(metrics, placesByKey),
            ...AIService._policyCandidates(metrics, placesByKey)
        ].filter(Boolean);

        return AIService._selectFinal(candidates, rng);
    }

    /**
     * Score-rank, ensure kind diversity, then deepen the most-represented
     * kinds, then fill any remaining slots up to the cap. Deterministic
     * given `rng`.
     *
     * The cap (8) leaves room for ~2 outreach campaigns + a fuller
     * connect mix (events / place / reduction / policy). Per-kind caps
     * keep one kind (typically events, since the catalogue has the most
     * triggers) from crowding out the rest.
     * @private
     */
    static _selectFinal(candidates, rng) {
        const TOTAL_CAP = 8;
        // Per-kind caps so a single kind can't monopolize the list.
        const PER_KIND_MAX = { outreach: 2, event: 3, place: 2, reduction: 2, policy: 2 };
        const priorityWeight = { high: 3, medium: 2, low: 1 };

        const withJitter = candidates.map(rec => ({
            rec,
            // Tiny deterministic jitter so equal-priority items don't
            // always sort in declaration order.
            score: (priorityWeight[rec.priority] ?? 1) * 100 + rng() * 10
        }));
        withJitter.sort((a, b) => b.score - a.score);

        /** @type {Map<string, number>} */
        const usedByKind = new Map();
        const final = [];

        const tryAdd = (rec) => {
            if (final.length >= TOTAL_CAP) return false;
            const used = usedByKind.get(rec.kind) ?? 0;
            if (used >= (PER_KIND_MAX[rec.kind] ?? 2)) return false;
            if (final.includes(rec)) return false;
            final.push(rec);
            usedByKind.set(rec.kind, used + 1);
            return true;
        };

        // Pass 1: kind diversification — at most one of each kind so the
        // user always sees the full taxonomy if candidates exist.
        const seenKinds = new Set();
        for (const { rec } of withJitter) {
            if (seenKinds.has(rec.kind)) continue;
            if (tryAdd(rec)) seenKinds.add(rec.kind);
            if (final.length >= TOTAL_CAP) break;
        }
        // Pass 2: depth — pick the next best regardless of kind, honoring
        // PER_KIND_MAX so events don't crowd out everything else.
        for (const { rec } of withJitter) {
            if (final.length >= TOTAL_CAP) break;
            tryAdd(rec);
        }

        return final;
    }

    // ----------------------------------------------------------------
    //  Candidate generators
    // ----------------------------------------------------------------

    /**
     * Big, deliberately varied event catalogue. Each template carries a
     * specific trigger (a metric/place combination) so it only fires when
     * it's a plausible fit for the buurt — that way one buurt might see
     * "Repair café" + "Walk-and-talk historical tour" while another gets
     * "Late-night study lounge" + "Yoga in the park", and the result
     * feels tailored rather than templated.
     *
     * Clusters represented:
     *   senior · youth · family · skill · wellbeing · cultural / civic
     * @private
     */
    static _eventCandidates(metrics, places) {
        /** @type {import('../models/RecommendationData.js').EventRecommendation[]} */
        const out = [];

        const lonely   = metrics.lonely               ?? 0;
        const sev      = metrics.severelyLonely       ?? 0;
        const soc      = metrics.sociallyLonely       ?? 0;
        const emo      = metrics.emotionallyLonely    ?? 0;
        const move     = metrics.movementImpairment   ?? 0;
        const health   = metrics.goodExperiencedHealth ?? 100;
        const exer     = metrics.weeklyExercising     ?? 0;
        const vol      = metrics.volunteerWork        ?? 0;
        const anxiety  = metrics.highRiskAnxietyOrDepression ?? 0;
        const stress   = metrics.veryMuchStressLast4Weeks    ?? 0;
        const support  = metrics.receivesSupportFromOthers   ?? 0;
        const struggle = metrics.strugglingMakeEnds   ?? 0;
        const community = places.get('communityCenter') ?? 0;
        const senior    = places.get('seniorCenter')    ?? 0;
        const religious = places.get('religiousVenue')  ?? 0;
        const library   = places.get('library')         ?? 0;
        const park      = places.get('park')            ?? 0;
        const cafe      = places.get('cafe')            ?? 0;
        const sports    = places.get('sportsFacility')  ?? 0;
        const playground = places.get('playground')    ?? 0;

        // ------------------------------------------------------------
        // SENIOR cluster
        // ------------------------------------------------------------
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
        if ((sev >= 10 || vol >= 28) && (community >= 1 || library >= 1)) {
            out.push({
                kind: 'event',
                title: 'Repair café — bring something broken',
                rationale: `Volunteer rate is ${vol.toFixed(1)}% and severe loneliness ${sev.toFixed(1)}%. A repair café gives skilled retirees a meaningful role and pairs them with younger residents needing help.`,
                audience: 'All ages · intergenerational',
                recurrence: 'Monthly · second Saturday',
                venuePlaceKey: AIService._pickVenue(places, ['communityCenter', 'library']),
                expectedImpact: { metric: 'severelyLonely', delta: -1.8 },
                priority: 'medium'
            });
        }
        if (sev >= 12 && emo >= 28) {
            out.push({
                kind: 'event',
                title: 'Memory & life-story circle',
                rationale: `Emotional loneliness (${emo.toFixed(1)}%) co-occurs with severe loneliness. Facilitated story-sharing builds depth-of-tie without demanding new skills or stamina.`,
                audience: 'Residents 70+',
                recurrence: 'Bi-weekly · Thursday afternoons',
                venuePlaceKey: AIService._pickVenue(places, ['seniorCenter', 'library', 'communityCenter']),
                expectedImpact: { metric: 'emotionallyLonely', delta: -2.4 },
                priority: sev >= 16 ? 'high' : 'medium'
            });
        }
        if (sev >= 8 && (religious >= 1 || community >= 1)) {
            out.push({
                kind: 'event',
                title: 'Buurtmaaltijd — neighborhood cooking night',
                rationale: `A potluck-style cooking night converts a passive meal into shared work. Effective in mixed-age buurten with multiple cultural backgrounds.`,
                audience: 'All adults, families welcome',
                recurrence: 'Monthly · last Friday',
                venuePlaceKey: AIService._pickVenue(places, ['religiousVenue', 'communityCenter']),
                expectedImpact: { metric: 'sociallyLonely', delta: -1.9 },
                priority: 'medium'
            });
        }

        // ------------------------------------------------------------
        // YOUTH cluster
        // ------------------------------------------------------------
        if (anxiety >= 14 && library >= 1) {
            out.push({
                kind: 'event',
                title: 'Late-night study lounge with snacks',
                rationale: `Anxiety/depression risk is ${anxiety.toFixed(1)}%. Co-location of studying and casual contact reduces the "going out alone" barrier that younger residents report.`,
                audience: 'Students & young adults',
                recurrence: 'Weekly · Tuesdays & Thursdays, 19:00–22:00',
                venuePlaceKey: AIService._pickVenue(places, ['library', 'communityCenter']),
                expectedImpact: { metric: 'highRiskAnxietyOrDepression', delta: -1.4 },
                priority: anxiety >= 18 ? 'high' : 'medium'
            });
        }
        if (emo >= 25 && cafe >= 3) {
            out.push({
                kind: 'event',
                title: 'Open-mic poetry & storytelling night',
                rationale: `Emotional loneliness (${emo.toFixed(1)}%) responds well to expressive formats. With ${cafe} cafés in the buurt, a partnership night uses existing footfall.`,
                audience: 'Adults 18–35',
                recurrence: 'Monthly · last Thursday',
                venuePlaceKey: AIService._pickVenue(places, ['cafe', 'library', 'communityCenter']),
                expectedImpact: { metric: 'emotionallyLonely', delta: -1.7 },
                priority: 'medium'
            });
        }
        if (exer < 55 && sports >= 1) {
            out.push({
                kind: 'event',
                title: 'Sunday pickup football league',
                rationale: `Only ${exer.toFixed(1)}% exercise weekly. Drop-in sport (no commitment, no team to join) is the lowest-friction entry point for young men, the cohort most under-served by current programmes.`,
                audience: 'Adults 16–45',
                recurrence: 'Weekly · Sunday mornings',
                venuePlaceKey: 'sportsFacility',
                expectedImpact: { metric: 'weeklyExercising', delta: +3.1 },
                priority: 'medium'
            });
        }

        // ------------------------------------------------------------
        // FAMILY / INTERGENERATIONAL cluster
        // ------------------------------------------------------------
        if (playground >= 2 && lonely >= 35) {
            out.push({
                kind: 'event',
                title: 'Playground takeover Saturdays',
                rationale: `${playground} playgrounds and overall loneliness ${lonely.toFixed(1)}%. A monthly facilitated meet-up turns latent infrastructure into a parent-meets-parent venue.`,
                audience: 'Parents of children 2–10',
                recurrence: 'Monthly · first Saturday',
                venuePlaceKey: 'playground',
                expectedImpact: { metric: 'sociallyLonely', delta: -1.8 },
                priority: 'medium'
            });
        }
        if (struggle >= 18 && (religious >= 1 || community >= 1)) {
            out.push({
                kind: 'event',
                title: 'Cook-your-home-country class',
                rationale: `Financial strain (${struggle.toFixed(1)}%) and likely first-generation residents — a free cooking class is socially valuable and removes one week's grocery cost.`,
                audience: 'All adults, families welcome',
                recurrence: 'Bi-weekly · Wednesday evenings',
                venuePlaceKey: AIService._pickVenue(places, ['communityCenter', 'religiousVenue']),
                expectedImpact: { metric: 'sociallyLonely', delta: -2.0 },
                priority: struggle >= 24 ? 'high' : 'medium'
            });
        }

        // ------------------------------------------------------------
        // SKILL / HOBBY cluster
        // ------------------------------------------------------------
        if (sev >= 8 && (community >= 1 || senior >= 1)) {
            out.push({
                kind: 'event',
                title: 'Knitting & natter club',
                rationale: `Severe loneliness (${sev.toFixed(1)}%) responds to repetitive low-effort activity paired with light conversation — a format with strong evidence among older women in Dutch buurthuizen.`,
                audience: 'Adults 55+',
                recurrence: 'Weekly · Tuesday afternoons',
                venuePlaceKey: AIService._pickVenue(places, ['communityCenter', 'seniorCenter']),
                expectedImpact: { metric: 'severelyLonely', delta: -1.5 },
                priority: 'medium'
            });
        }
        if (lonely >= 35 && (library >= 1 || community >= 1)) {
            out.push({
                kind: 'event',
                title: 'Language exchange tafel',
                rationale: `Loneliness ${lonely.toFixed(1)}%. Pairing Dutch learners with native speakers creates structured 1-on-1 contact that converts into friendships at a higher rate than open meet-ups.`,
                audience: 'All adults, all backgrounds',
                recurrence: 'Weekly · Wednesday evenings',
                venuePlaceKey: AIService._pickVenue(places, ['library', 'communityCenter']),
                expectedImpact: { metric: 'sociallyLonely', delta: -1.6 },
                priority: 'medium'
            });
        }
        if (lonely >= 35 && library >= 1) {
            out.push({
                kind: 'event',
                title: 'Book club & afternoon tea',
                rationale: `With a library on-site, a moderated book club hosts contact for residents who prefer indoor, structured social settings.`,
                audience: 'Adults · readers of all ages',
                recurrence: 'Monthly · second Wednesday',
                venuePlaceKey: 'library',
                expectedImpact: { metric: 'lonely', delta: -1.2 },
                priority: 'low'
            });
        }

        // ------------------------------------------------------------
        // WELLBEING cluster
        // ------------------------------------------------------------
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
        if (exer < 55 && park >= 1) {
            out.push({
                kind: 'event',
                title: 'Yoga in the park',
                rationale: `${exer.toFixed(1)}% exercise weekly and there's a park on-site. A free outdoor class normalizes physical activity without requiring gym membership.`,
                audience: 'All ages',
                recurrence: 'Weekly · Saturday mornings',
                venuePlaceKey: 'park',
                expectedImpact: { metric: 'weeklyExercising', delta: +2.3 },
                priority: 'low'
            });
        }
        if (anxiety >= 14 && (community >= 1 || library >= 1)) {
            out.push({
                kind: 'event',
                title: 'Mindfulness drop-in',
                rationale: `Anxiety/depression risk (${anxiety.toFixed(1)}%) and stress (${stress.toFixed(1)}%) are elevated. A free weekly mindfulness session normalizes self-care and is a soft entry to mental-health support.`,
                audience: 'Adults · all backgrounds',
                recurrence: 'Weekly · Monday evenings',
                venuePlaceKey: AIService._pickVenue(places, ['communityCenter', 'library']),
                expectedImpact: { metric: 'veryMuchStressLast4Weeks', delta: -1.6 },
                priority: 'medium'
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

        // ------------------------------------------------------------
        // CULTURAL / CIVIC cluster
        // ------------------------------------------------------------
        if (lonely >= 38) {
            out.push({
                kind: 'event',
                title: 'Neighborhood street festival',
                rationale: `Overall loneliness ${lonely.toFixed(1)}%. An annual closed-street festival is the highest-reach single intervention — a single day creates the weak ties that the recurring programmes can convert.`,
                audience: 'Entire buurt · all ages',
                recurrence: 'Annual · early September',
                venuePlaceKey: AIService._pickVenue(places, ['park', 'communityCenter']),
                expectedImpact: { metric: 'sociallyLonely', delta: -3.0 },
                priority: lonely >= 50 ? 'high' : 'medium'
            });
        }
        if (lonely >= 32 && support < 16) {
            out.push({
                kind: 'event',
                title: 'Walk-and-talk historical tour',
                rationale: `Informal support is only ${support.toFixed(1)}%. A guided neighborhood walk pairs strangers as walking partners — a format with the lowest social-cost and the highest "this isn't a meeting" feel.`,
                audience: 'All adults',
                recurrence: 'Monthly · third Saturday',
                venuePlaceKey: AIService._pickVenue(places, ['park', 'communityCenter']),
                expectedImpact: { metric: 'sociallyLonely', delta: -1.4 },
                priority: 'low'
            });
        }
        if (vol >= 28) {
            out.push({
                kind: 'event',
                title: 'Volunteer-driven neighborhood game night',
                rationale: `Volunteer rate ${vol.toFixed(1)}% is healthy. A volunteer-run monthly game night is virtually free to run and creates the "regular faces" effect that converts weak ties into supports.`,
                audience: 'All adults, families welcome',
                recurrence: 'Monthly · first Friday',
                venuePlaceKey: AIService._pickVenue(places, ['communityCenter', 'library', 'cafe']),
                expectedImpact: { metric: 'sociallyLonely', delta: -1.8 },
                priority: 'medium'
            });
        }

        return out;
    }

    // ----------------------------------------------------------------
    //  Outreach candidates (the "How to reach" cards)
    // ----------------------------------------------------------------

    /**
     * Propose 0–5 outreach campaign cards based on which loneliness
     * pattern dominates and which channels actually exist in this buurt.
     * Each card cites the concrete channel keys it would mix, the
     * intended audience, and a deterministic estimate of how many
     * residents would be reached per week.
     * @private
     */
    static _outreachCandidates(metrics, channels, population) {
        /** @type {import('../models/RecommendationData.js').OutreachRecommendation[]} */
        const out = [];

        const sev      = metrics.severelyLonely   ?? 0;
        const soc      = metrics.sociallyLonely   ?? 0;
        const lonely   = metrics.lonely           ?? 0;
        const struggle = metrics.strugglingMakeEnds        ?? 0;
        const support  = metrics.receivesSupportFromOthers ?? 0;
        const anxiety  = metrics.highRiskAnxietyOrDepression ?? 0;
        const vol      = metrics.volunteerWork    ?? 0;

        // -- Healthcare touchpoints — best for housebound seniors -----
        const healthcareChannels = ['gpClinicPoster', 'pharmacyPoster', 'doorToDoor']
            .filter(k => (channels.get(k) ?? 0) > 0);
        if (sev >= 12 && healthcareChannels.length >= 2) {
            out.push({
                kind: 'outreach',
                title: 'Healthcare-touchpoint campaign',
                rationale: `Severe loneliness ${sev.toFixed(1)}% skews to housebound seniors who rarely see a poster on the street but routinely pass through GPs and pharmacies. A 6-week run of A3 posters plus welzijn door-knocks routes them into existing programmes.`,
                audience: 'Housebound residents 65+',
                channels: healthcareChannels,
                expectedReach: AIService._estimateReach(channels, healthcareChannels, population),
                expectedImpact: { metric: 'severelyLonely', delta: -1.8 },
                priority: sev >= 16 ? 'high' : 'medium'
            });
        }

        // -- Trusted-face mailbox + welzijn doorstep ------------------
        const trustedChannels = ['mailboxFlyer', 'doorToDoor', 'religiousVenueBulletin']
            .filter(k => (channels.get(k) ?? 0) > 0);
        if (struggle >= 22 && support < 14 && trustedChannels.length >= 2) {
            out.push({
                kind: 'outreach',
                title: 'Trusted-face mailbox + welzijn doorstep',
                rationale: `Financial strain ${struggle.toFixed(1)}% with low informal support (${support.toFixed(1)}%). Residents who distrust formal channels respond to door-to-door welzijn workers and bulletins handed out at their place of worship — preceded by a single physical flyer to set expectations.`,
                audience: 'Adults under financial strain',
                channels: trustedChannels,
                expectedReach: AIService._estimateReach(channels, trustedChannels, population),
                expectedImpact: { metric: 'strugglingMakeEnds', delta: -1.4 },
                priority: struggle >= 28 ? 'high' : 'medium'
            });
        }

        // -- Mass-reach outdoor & supermarket (broad-base) ------------
        const massChannels = ['busShelterPoster', 'adBanner', 'supermarketBoard']
            .filter(k => (channels.get(k) ?? 0) > 0);
        if (soc >= 30 && massChannels.length >= 2) {
            out.push({
                kind: 'outreach',
                title: 'Mass-reach outdoor & supermarket',
                rationale: `Social loneliness ${soc.toFixed(1)}% spans all cohorts. Outdoor poster panels combined with the community boards at AH/Lidl/Jumbo deliver one impression per resident per week at low marginal cost.`,
                audience: 'All adults · broad-base reach',
                channels: massChannels,
                expectedReach: AIService._estimateReach(channels, massChannels, population),
                expectedImpact: { metric: 'sociallyLonely', delta: -1.6 },
                priority: soc >= 36 ? 'high' : 'medium'
            });
        }

        // -- Kids-to-parents reach ------------------------------------
        const kidsChannels = ['schoolNewsletter', 'communityScreen', 'libraryNoticeBoard']
            .filter(k => (channels.get(k) ?? 0) > 0);
        if ((channels.get('schoolNewsletter') ?? 0) >= 2 && lonely >= 35 && kidsChannels.length >= 2) {
            out.push({
                kind: 'outreach',
                title: 'Kids-to-parents reach',
                rationale: `Loneliness ${lonely.toFixed(1)}% in a buurt with active schools — newsletters that kids physically carry home into the kitchen consistently out-perform direct-to-parent mailings.`,
                audience: 'Parents of school-age children',
                channels: kidsChannels,
                expectedReach: AIService._estimateReach(channels, kidsChannels, population),
                expectedImpact: { metric: 'sociallyLonely', delta: -1.1 },
                priority: 'medium'
            });
        }

        // -- Volunteer-amplified neighborhood broadcast --------------
        const volChannels = ['neighborhoodWhatsApp', 'libraryNoticeBoard', 'communityScreen']
            .filter(k => (channels.get(k) ?? 0) > 0);
        if (vol >= 26 && volChannels.length >= 2) {
            out.push({
                kind: 'outreach',
                title: 'Volunteer-amplified neighborhood broadcast',
                rationale: `Volunteer rate ${vol.toFixed(1)}%. A short-form message seeded in the buurtapp groups by existing volunteers is forwarded organically — paid posters reach maybe 10× their printed copy count.`,
                audience: 'All residents · digital-first',
                channels: volChannels,
                expectedReach: AIService._estimateReach(channels, volChannels, population),
                expectedImpact: { metric: 'lonely', delta: -0.9 },
                priority: 'low'
            });
        }

        // -- Anxiety / quiet-cohort outreach -------------------------
        const quietChannels = ['libraryNoticeBoard', 'pharmacyPoster', 'communityScreen']
            .filter(k => (channels.get(k) ?? 0) > 0);
        if (anxiety >= 16 && quietChannels.length >= 2) {
            out.push({
                kind: 'outreach',
                title: 'Quiet-cohort touchpoint posters',
                rationale: `Anxiety/depression risk ${anxiety.toFixed(1)}%. Residents who avoid loud social channels still routinely visit the pharmacy and the library — posters in those low-pressure spaces let them self-select into help.`,
                audience: 'Adults who avoid noisy channels',
                channels: quietChannels,
                expectedReach: AIService._estimateReach(channels, quietChannels, population),
                expectedImpact: { metric: 'highRiskAnxietyOrDepression', delta: -0.8 },
                priority: 'medium'
            });
        }

        return out;
    }

    /**
     * Deterministic estimate of weekly reach: for each chosen channel,
     * multiply its inventory count by the per-channel reach factor, then
     * cap to the buurt population so the figure stays plausible.
     * @private
     */
    static _estimateReach(channels, chosenKeys, population) {
        let total = 0;
        for (const key of chosenKeys) {
            const count = channels.get(key) ?? 0;
            const factor = CHANNEL_REACH_FACTOR[key] ?? 0;
            total += count * factor;
        }
        // Cap at 95% of population — no single campaign reaches everyone.
        const cap = Math.max(0, Math.round(population * 0.95));
        return cap > 0 ? Math.min(total, cap) : total;
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
