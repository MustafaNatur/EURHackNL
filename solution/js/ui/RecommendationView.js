import {
    METRIC_CATALOGUE,
    PUBLIC_PLACE_CATALOGUE,
    OUTREACH_CHANNEL_CATALOGUE
} from '../models/DistrictData.js';
import {
    RECOMMENDATION_KINDS,
    RECOMMENDATION_SECTIONS,
    AI_STAGES
} from '../models/RecommendationData.js';

/**
 * RecommendationView
 * ------------------
 * Pure rendering helpers for the AI recommendations drill-in screen.
 * Mirrors the static `_renderXxx` style already used inside
 * SidebarController, so the controller can stay focused on state and
 * DOM lifecycle.
 *
 * Three things to render:
 *
 *   1. A staged "AI is thinking" loader (Analyzing -> Thinking -> Generating)
 *   2. The final list of structured recommendation cards
 *   3. An error state when generation fails
 *
 * No DOM events are wired here — the host (SidebarController) is the
 * single owner of click handlers (e.g. back navigation).
 */
export class RecommendationView {
    /**
     * @param {string} activeStageId - one of AI_STAGES[].id
     */
    static renderLoader(activeStageId) {
        const activeIndex = Math.max(
            0,
            AI_STAGES.findIndex(s => s.id === activeStageId)
        );
        const activeStage = AI_STAGES[activeIndex];

        const items = AI_STAGES.map((stage, i) => {
            let modClass = 'ai-loader__step--pending';
            let glyph    = '';
            if (i < activeIndex) {
                modClass = 'ai-loader__step--done';
                glyph    = '✓';
            } else if (i === activeIndex) {
                modClass = 'ai-loader__step--active';
            }
            return `
                <li class="ai-loader__step ${modClass}">
                    <span class="ai-loader__bullet" aria-hidden="true">${glyph}</span>
                    <div class="ai-loader__text">
                        <span class="ai-loader__label">${stage.label}</span>
                        <span class="ai-loader__detail">${stage.detail}</span>
                    </div>
                </li>
            `;
        }).join('');

        return `
            <section class="ai-loader" role="status" aria-live="polite">
                <header class="ai-loader__header">
                    <span class="ai-loader__sparkle" aria-hidden="true">✦</span>
                    <div>
                        <h3 class="ai-loader__title">AI is reasoning…</h3>
                        <p class="ai-loader__subtitle">${activeStage.detail}</p>
                    </div>
                </header>
                <ol class="ai-loader__steps">${items}</ol>
            </section>
        `;
    }

    /**
     * @param {string} message
     */
    static renderError(message) {
        return `
            <section class="ai-error">
                <h3 class="ai-error__title">Couldn't generate recommendations</h3>
                <p class="ai-error__body">${message}</p>
            </section>
        `;
    }

    /**
     * @param {import('../models/RecommendationData.js').Recommendation[]} recs
     * @param {{ outreachChannels?: {key:string,count:number}[], population?: number }} [ctx]
     */
    static renderRecommendations(recs, ctx = {}) {
        const channels  = Array.isArray(ctx.outreachChannels) ? ctx.outreachChannels : [];
        const population = Number(ctx.population) || 0;
        const safeRecs = Array.isArray(recs) ? recs : [];

        // Decorate each recommendation with its index in the original
        // list so the host (SidebarController) can find it back from
        // a button click via data attribute, even after we group.
        const indexed = safeRecs.map((rec, i) => ({ rec, index: i }));
        const bySection = RecommendationView._groupBySection(indexed);

        const summary = RecommendationView._renderSummary(safeRecs, channels);

        // Determine which channels the outreach cards actually reference
        // so the inventory tiles can highlight them as "Suggested".
        const suggestedChannelSet = new Set();
        for (const { rec } of indexed) {
            if (rec.kind === 'outreach' && Array.isArray(rec.channels)) {
                for (const k of rec.channels) suggestedChannelSet.add(k);
            }
        }

        const sectionOrder = Object.entries(RECOMMENDATION_SECTIONS)
            .sort((a, b) => a[1].order - b[1].order)
            .map(([key]) => key);

        const sections = sectionOrder.map(sectionKey => {
            const sectionMeta = RECOMMENDATION_SECTIONS[sectionKey];
            const sectionItems = bySection.get(sectionKey) ?? [];

            const sectionHeader = `
                <header class="rec-section__head">
                    <h3 class="rec-section__title">${sectionMeta.title}</h3>
                    <p class="rec-section__subtitle">${sectionMeta.subtitle}</p>
                </header>
            `;

            let body;
            if (sectionKey === 'reach') {
                const inventory = RecommendationView._renderOutreachInventory(channels, suggestedChannelSet, population);
                const cards = RecommendationView._renderKindGroups(sectionItems);
                const emptyNote = sectionItems.length === 0
                    ? `<p class="rec-section__empty">No specific campaigns triggered — start with one of the channels above as a broad-base push.</p>`
                    : '';
                body = `${inventory}${cards}${emptyNote}`;
            } else {
                const cards = RecommendationView._renderKindGroups(sectionItems);
                const emptyNote = sectionItems.length === 0
                    ? `<p class="rec-section__empty">This buurt's connect indicators are within healthy ranges — no programme changes proposed.</p>`
                    : '';
                body = `${cards}${emptyNote}`;
            }

            return `
                <section class="rec-section rec-section--${sectionKey}">
                    ${sectionHeader}
                    ${body}
                </section>
            `;
        }).join('');

        return `${summary}${sections}`;
    }

    /**
     * Renders all "by-kind" sub-groups of recommendations that belong to
     * one parent section (reach or connect).
     * @private
     * @param {{rec: import('../models/RecommendationData.js').Recommendation, index: number}[]} sectionItems
     */
    static _renderKindGroups(sectionItems) {
        if (!sectionItems || sectionItems.length === 0) return '';
        const groups = RecommendationView._groupByKind(sectionItems);
        return groups.map(({ kind, items }) => {
            const meta = RECOMMENDATION_KINDS[kind];
            return `
                <section class="rec-group">
                    <h4 class="rec-group__title">
                        <span class="rec-group__icon" aria-hidden="true">${meta.icon}</span>
                        ${meta.label}
                        <span class="rec-group__count">${items.length}</span>
                    </h4>
                    <ul class="rec-list">
                        ${items.map(({ rec, index }) =>
                            RecommendationView.renderEntityCard(rec, index)
                        ).join('')}
                    </ul>
                </section>
            `;
        }).join('');
    }

    // ----------------------------------------------------------------
    //  Outreach inventory grid
    // ----------------------------------------------------------------

    /**
     * Renders the full outreach-channel inventory as a responsive grid
     * of tiles. Tiles that match a channel referenced by any outreach
     * card carry a small "Suggested" badge.
     *
     * @private
     * @param {{key:string,count:number}[]} channels
     * @param {Set<string>} suggestedKeys
     * @param {number} population
     */
    static _renderOutreachInventory(channels, suggestedKeys, population) {
        if (!Array.isArray(channels) || channels.length === 0) return '';

        const countsByKey = new Map(channels.map(c => [c.key, Number(c.count) || 0]));

        const tiles = OUTREACH_CHANNEL_CATALOGUE.map(def => {
            const count = countsByKey.get(def.key) ?? 0;
            const suggested = suggestedKeys.has(def.key);
            const formattedCount = RecommendationView._formatCompactCount(count);
            const suggestedBadge = suggested
                ? `<span class="outreach-tile__suggested" title="Featured in an outreach campaign below">Suggested</span>`
                : '';
            return `
                <li class="outreach-tile outreach-tile--${def.reachKind}${suggested ? ' outreach-tile--suggested' : ''}">
                    <div class="outreach-tile__head">
                        <span class="outreach-tile__icon" aria-hidden="true">${def.icon}</span>
                        ${suggestedBadge}
                        <span class="outreach-tile__count">${formattedCount}</span>
                    </div>
                    <div class="outreach-tile__body">
                        <span class="outreach-tile__label">${def.label}</span>
                        <span class="outreach-tile__descr">${def.descr}</span>
                    </div>
                </li>
            `;
        }).join('');

        const populationHint = population > 0
            ? `<span class="outreach-inventory__meta">Reach scaled to ~${RecommendationView._formatCompactCount(population)} residents</span>`
            : '';

        return `
            <section class="outreach-inventory-wrap">
                <header class="outreach-inventory__head">
                    <h4 class="outreach-inventory__title">Channels available in this buurt</h4>
                    ${populationHint}
                </header>
                <ul class="outreach-inventory">
                    ${tiles}
                </ul>
            </section>
        `;
    }

    /**
     * @param {import('../models/RecommendationData.js').Recommendation} rec
     * @param {number} [index] - position in the original list; emitted as
     *                           `data-rec-index` so a host can re-resolve
     *                           the full object on click.
     */
    static renderEntityCard(rec, index) {
        const meta = RECOMMENDATION_KINDS[rec.kind];
        const impact = RecommendationView._renderImpact(rec.expectedImpact);
        const priority = RecommendationView._renderPriority(rec.priority);
        const facts = RecommendationView._renderFacts(rec);
        const actions = RecommendationView._renderActions(rec, index);
        const indexAttr = Number.isFinite(index) ? ` data-rec-index="${index}"` : '';

        return `
            <li class="rec-card rec-card--${meta.tone}" data-kind="${rec.kind}"${indexAttr}>
                <header class="rec-card__head">
                    <span class="rec-card__eyebrow">
                        <span class="rec-card__icon" aria-hidden="true">${meta.icon}</span>
                        ${meta.label}
                    </span>
                    ${priority}
                </header>
                <h4 class="rec-card__title">${rec.title}</h4>
                <p class="rec-card__rationale">${rec.rationale}</p>
                ${facts}
                <div class="rec-card__footer">
                    ${impact}
                    ${actions}
                </div>
            </li>
        `;
    }

    /**
     * Kind-specific call-to-action affordances rendered in the card
     * footer. Event cards get two CTAs:
     *   1. "Save to registry" — primary action, persists the event into
     *      the EventStore so it shows up in the Analytics > Events tab.
     *   2. "Host with Luma"   — secondary demo gimmick (existing).
     * @private
     */
    static _renderActions(rec, index) {
        if (rec.kind !== 'event') return '';
        const indexAttr = Number.isFinite(index) ? ` data-rec-index="${index}"` : '';
        return `
            <div class="rec-card__actions">
                <button type="button" class="save-event-btn"
                        data-role="save-event"${indexAttr}
                        aria-label="Save this event to the registry">
                    <span class="save-event-btn__icon" aria-hidden="true">＋</span>
                    <span class="save-event-btn__label">Save to registry</span>
                </button>
                <button type="button" class="luma-host-btn luma-host-btn--secondary"
                        data-role="host-luma"${indexAttr}
                        aria-label="Host this event on Luma">
                    <span class="luma-host-btn__mark" aria-hidden="true">lu·ma</span>
                    <span class="luma-host-btn__label">Host with Luma</span>
                </button>
            </div>
        `;
    }

    // ----------------------------------------------------------------
    //  Internals
    // ----------------------------------------------------------------

    /**
     * Groups recommendation/index pairs by their `kind`, preserving the
     * order declared in RECOMMENDATION_KINDS.
     * @private
     * @param {{rec: import('../models/RecommendationData.js').Recommendation, index: number}[]} indexed
     */
    static _groupByKind(indexed) {
        const byKind = new Map();
        for (const pair of indexed) {
            const kind = pair.rec.kind;
            if (!byKind.has(kind)) byKind.set(kind, []);
            byKind.get(kind).push(pair);
        }
        return Array.from(byKind.entries())
            .map(([kind, items]) => ({ kind, items }))
            .sort((a, b) =>
                (RECOMMENDATION_KINDS[a.kind]?.order ?? 99)
              - (RECOMMENDATION_KINDS[b.kind]?.order ?? 99)
            );
    }

    /**
     * Groups indexed recommendations by their parent section
     * ("reach" / "connect"), based on the `section` field declared in
     * RECOMMENDATION_KINDS for each kind.
     * @private
     * @param {{rec: import('../models/RecommendationData.js').Recommendation, index: number}[]} indexed
     * @returns {Map<string, {rec: import('../models/RecommendationData.js').Recommendation, index: number}[]>}
     */
    static _groupBySection(indexed) {
        const bySection = new Map();
        for (const pair of indexed) {
            const sectionKey = RECOMMENDATION_KINDS[pair.rec.kind]?.section ?? 'connect';
            if (!bySection.has(sectionKey)) bySection.set(sectionKey, []);
            bySection.get(sectionKey).push(pair);
        }
        return bySection;
    }

    /**
     * Renders the small at-a-glance KPI strip at the top of the
     * recommendations screen. With outreach in the mix we now show four
     * counters: total interventions, high-priority, reach channels used,
     * and total weekly reach across the outreach campaigns.
     * @private
     */
    static _renderSummary(recs, channels) {
        const total = recs.length;
        const highCount = recs.filter(r => r.priority === 'high').length;
        const outreachRecs = recs.filter(r => r.kind === 'outreach');
        const usedChannels = new Set();
        let totalReach = 0;
        for (const r of outreachRecs) {
            if (Array.isArray(r.channels)) {
                for (const k of r.channels) usedChannels.add(k);
            }
            if (Number.isFinite(r.expectedReach)) totalReach += r.expectedReach;
        }
        const inventorySize = Array.isArray(channels) ? channels.length : 0;
        return `
            <section class="rec-summary">
                <div class="rec-summary__row rec-summary__row--four">
                    <div class="rec-summary__stat">
                        <span class="rec-summary__num">${total}</span>
                        <span class="rec-summary__lbl">Proposed interventions</span>
                    </div>
                    <div class="rec-summary__stat">
                        <span class="rec-summary__num">${highCount}</span>
                        <span class="rec-summary__lbl">High priority</span>
                    </div>
                    <div class="rec-summary__stat">
                        <span class="rec-summary__num">${usedChannels.size}<small>/${inventorySize}</small></span>
                        <span class="rec-summary__lbl">Reach channels used</span>
                    </div>
                    <div class="rec-summary__stat">
                        <span class="rec-summary__num">${RecommendationView._formatCompactCount(totalReach)}</span>
                        <span class="rec-summary__lbl">Est. weekly reach</span>
                    </div>
                </div>
                <p class="rec-summary__note">
                    Generated by AI from the buurt's indicators, public-place
                    inventory, and outreach-channel availability. Each card maps
                    to an entity the municipality can plan, fund, or remove.
                </p>
            </section>
        `;
    }

    /** @private */
    static _formatCompactCount(n) {
        const v = Number(n) || 0;
        const abs = Math.abs(v);
        if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
        if (abs >= 10_000)    return `${Math.round(v / 1_000)}k`;
        if (abs >= 1_000)     return `${(v / 1_000).toFixed(1)}k`;
        return Math.round(v).toLocaleString();
    }

    /** @private */
    static _renderImpact(impact) {
        if (!impact) return '';
        if ('metric' in impact) {
            const def = METRIC_CATALOGUE.find(m => m.key === impact.metric);
            const label = def?.label ?? impact.metric;
            const sign = impact.delta > 0 ? '+' : '';
            const tone = RecommendationView._impactTone(def, impact.delta);
            return `
                <div class="rec-impact rec-impact--${tone}">
                    <span class="rec-impact__lbl">Expected impact</span>
                    <span class="rec-impact__val">${sign}${impact.delta.toFixed(1)} pp · ${label}</span>
                </div>
            `;
        }
        if ('qualitative' in impact) {
            return `
                <div class="rec-impact rec-impact--neutral">
                    <span class="rec-impact__lbl">Expected impact</span>
                    <span class="rec-impact__val">${impact.qualitative}</span>
                </div>
            `;
        }
        return '';
    }

    /** @private */
    static _impactTone(metricDef, delta) {
        if (!metricDef) return 'neutral';
        const improves = metricDef.highIsBad ? delta < 0 : delta > 0;
        return improves ? 'good' : 'bad';
    }

    /** @private */
    static _renderPriority(priority) {
        const label = priority[0].toUpperCase() + priority.slice(1);
        return `
            <span class="rec-priority rec-priority--${priority}">
                <span class="rec-priority__dot" aria-hidden="true"></span>
                ${label} priority
            </span>
        `;
    }

    /**
     * Renders the small key/value strip under the rationale, with
     * kind-specific facts (audience+venue for events, action+place for
     * places, target for reductions, department for policies,
     * channels+reach for outreach).
     * @private
     */
    static _renderFacts(rec) {
        const rows = [];
        if (rec.kind === 'event') {
            if (rec.audience)   rows.push(['Audience',   rec.audience]);
            if (rec.recurrence) rows.push(['Cadence',    rec.recurrence]);
            const venue = RecommendationView._venueLabel(rec.venuePlaceKey);
            if (venue)          rows.push(['Venue',      venue]);
        } else if (rec.kind === 'place') {
            const placeLabel = RecommendationView._venueLabel(rec.placeKey) ?? rec.placeKey;
            rows.push(['Action', `${RecommendationView._actionVerb(rec.action)} · ${placeLabel}`]);
            if (rec.quantity)   rows.push(['Quantity',   `${rec.quantity}`]);
        } else if (rec.kind === 'reduction') {
            if (rec.targetLabel) rows.push(['Target',    rec.targetLabel]);
        } else if (rec.kind === 'policy') {
            if (rec.department)  rows.push(['Department', rec.department]);
        } else if (rec.kind === 'outreach') {
            if (rec.audience)   rows.push(['Audience', rec.audience]);
            const chips = RecommendationView._channelChips(rec.channels);
            if (chips)          rows.push(['Channels', chips]);
            if (Number.isFinite(rec.expectedReach)) {
                rows.push(['Est. weekly reach', RecommendationView._formatCompactCount(rec.expectedReach)]);
            }
        }
        if (rows.length === 0) return '';
        return `
            <dl class="rec-card__facts">
                ${rows.map(([k, v]) => `
                    <div class="rec-card__fact">
                        <dt>${k}</dt>
                        <dd>${v}</dd>
                    </div>
                `).join('')}
            </dl>
        `;
    }

    /** @private */
    static _venueLabel(placeKey) {
        if (!placeKey) return null;
        const def = PUBLIC_PLACE_CATALOGUE.find(p => p.key === placeKey);
        return def ? `${def.icon} ${def.label}` : placeKey;
    }

    /**
     * Render the chosen outreach channels as a row of small chips
     * (icon + label) so a card visibly cites which channels it would mix.
     * @private
     */
    static _channelChips(channelKeys) {
        if (!Array.isArray(channelKeys) || channelKeys.length === 0) return null;
        return channelKeys.map(key => {
            const def = OUTREACH_CHANNEL_CATALOGUE.find(c => c.key === key);
            const icon = def?.icon ?? '·';
            const label = def?.label ?? key;
            return `<span class="rec-chip">${icon} ${label}</span>`;
        }).join('');
    }

    /** @private */
    static _actionVerb(action) {
        switch (action) {
            case 'build':    return 'Build';
            case 'expand':   return 'Expand';
            case 'renovate': return 'Renovate';
            default:         return action ?? 'Act on';
        }
    }
}
