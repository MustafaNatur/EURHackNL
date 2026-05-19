import {
    METRIC_CATALOGUE,
    PUBLIC_PLACE_CATALOGUE
} from '../models/DistrictData.js';
import {
    RECOMMENDATION_KINDS,
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
     */
    static renderRecommendations(recs) {
        if (!recs || recs.length === 0) {
            return `
                <section class="rec-empty">
                    <h3 class="rec-empty__title">No interventions suggested</h3>
                    <p class="rec-empty__body">
                        This buurt's indicators are within healthy ranges.
                    </p>
                </section>
            `;
        }

        const groups = RecommendationView._groupByKind(recs);
        const summary = RecommendationView._renderSummary(recs);

        const sections = groups.map(({ kind, items }) => {
            const meta = RECOMMENDATION_KINDS[kind];
            return `
                <section class="rec-group">
                    <h3 class="rec-group__title">
                        <span class="rec-group__icon" aria-hidden="true">${meta.icon}</span>
                        ${meta.label}
                        <span class="rec-group__count">${items.length}</span>
                    </h3>
                    <ul class="rec-list">
                        ${items.map(RecommendationView.renderEntityCard).join('')}
                    </ul>
                </section>
            `;
        }).join('');

        return `${summary}${sections}`;
    }

    /**
     * @param {import('../models/RecommendationData.js').Recommendation} rec
     */
    static renderEntityCard(rec) {
        const meta = RECOMMENDATION_KINDS[rec.kind];
        const impact = RecommendationView._renderImpact(rec.expectedImpact);
        const priority = RecommendationView._renderPriority(rec.priority);
        const facts = RecommendationView._renderFacts(rec);

        return `
            <li class="rec-card rec-card--${meta.tone}" data-kind="${rec.kind}">
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
                ${impact}
            </li>
        `;
    }

    // ----------------------------------------------------------------
    //  Internals
    // ----------------------------------------------------------------

    /** @private */
    static _groupByKind(recs) {
        const byKind = new Map();
        for (const rec of recs) {
            if (!byKind.has(rec.kind)) byKind.set(rec.kind, []);
            byKind.get(rec.kind).push(rec);
        }
        return Array.from(byKind.entries())
            .map(([kind, items]) => ({ kind, items }))
            .sort((a, b) =>
                (RECOMMENDATION_KINDS[a.kind]?.order ?? 99)
              - (RECOMMENDATION_KINDS[b.kind]?.order ?? 99)
            );
    }

    /** @private */
    static _renderSummary(recs) {
        const total = recs.length;
        const highCount = recs.filter(r => r.priority === 'high').length;
        const kinds = new Set(recs.map(r => r.kind)).size;
        return `
            <section class="rec-summary">
                <div class="rec-summary__row">
                    <div class="rec-summary__stat">
                        <span class="rec-summary__num">${total}</span>
                        <span class="rec-summary__lbl">Proposed interventions</span>
                    </div>
                    <div class="rec-summary__stat">
                        <span class="rec-summary__num">${highCount}</span>
                        <span class="rec-summary__lbl">High priority</span>
                    </div>
                    <div class="rec-summary__stat">
                        <span class="rec-summary__num">${kinds}</span>
                        <span class="rec-summary__lbl">Action types</span>
                    </div>
                </div>
                <p class="rec-summary__note">
                    Generated by AI from the buurt's indicators and public-place
                    inventory. Each card maps to an entity the municipality can
                    plan, fund or remove.
                </p>
            </section>
        `;
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
     * places, target for reductions, department for policies).
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
