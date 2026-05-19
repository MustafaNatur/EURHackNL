import { SYSTEM_SEGMENTS, REACH_METHODS_BY_COHORT } from '../models/PopulationSegment.js';
import { MARKETING_CHANNEL_LOOKUP } from '../models/EventRecord.js';
import { LONELINESS_KEYS, PUBLIC_PLACE_CATALOGUE } from '../models/DistrictData.js';
import { RECOMMENDATION_KINDS } from '../models/RecommendationData.js';

/**
 * AudiencesTabView
 * ----------------
 * Audience-first surface rendered in the Analytics > Audiences tab.
 *
 *   ┌────────────────────────────┬──────────────────────────────────┐
 *   │  Segment list (left)       │  Segment detail (right)          │
 *   │                            │                                  │
 *   │  Young adults 18-24        │  Proposed events                 │
 *   │  Young women 18-24         │  Reach method recommendations    │
 *   │  Middle-aged 35-54         │  Highest-risk buurten            │
 *   │  Older adults 55-64        │                                  │
 *   │  Older women 55-64         │                                  │
 *   └────────────────────────────┴──────────────────────────────────┘
 *
 * All segments come from `SYSTEM_SEGMENTS` (the trimmed scope skips
 * user-defined segments). The right column lazy-loads its three
 * sections — events come from `AIService.generateForSegment`, reach
 * methods from `REACH_METHODS_BY_COHORT[segment.reachKind]`, and the
 * risk list from `DemographicService.getNeighborhoodsRanked`.
 *
 * Selection state is held locally; switching segments triggers a full
 * right-column re-render but the left rail is rebuilt only on mount.
 */
const TOP_BUURT_LIMIT = 5;

export class AudiencesTabView {
    /**
     * @param {{ demographicService: any, aiService: any, eventStore: any }} services
     */
    constructor(services) {
        this._services = services;
        this._root = null;
        this._selectedId = SYSTEM_SEGMENTS[0]?.id ?? null;
        /** @type {Map<string, any>} per-segment cached recs */
        this._recsCache = new Map();
        /** Per-segment cached "computed summary" (population share + composite score + top buurten). */
        this._summaryCache = new Map();
        this._generating = false;
    }

    async mount(container) {
        const root = document.createElement('div');
        root.className = 'audiences-tab';
        root.innerHTML = `
            <aside class="audiences-tab__list" data-slot="list"></aside>
            <section class="audiences-tab__detail" data-slot="detail"></section>
        `;
        container.appendChild(root);
        this._root = root;

        this._renderList();
        await this._renderDetail();
    }

    async unmount() {
        this._root?.remove();
        this._root = null;
        this._recsCache.clear();
        this._summaryCache.clear();
    }

    // ---------------- rendering ----------------

    /** @private */
    _renderList() {
        const slot = this._root.querySelector('[data-slot="list"]');
        const itemsHtml = SYSTEM_SEGMENTS.map(seg => {
            const summary = this._summaryFor(seg);
            const selected = seg.id === this._selectedId;
            const topNamesHtml = summary.topBuurten.slice(0, 3).map(b =>
                `<li>${escapeText(b.districtName)} · <strong>${b.value.toFixed(1)}%</strong></li>`
            ).join('');
            return `
                <li class="audiences-card${selected ? ' audiences-card--selected' : ''}"
                    role="button" tabindex="0"
                    data-role="segment" data-segment-id="${escapeAttr(seg.id)}">
                    <header class="audiences-card__head">
                        <h4 class="audiences-card__title">${escapeText(seg.name)}</h4>
                        <span class="audiences-card__share">${(summary.populationShare * 100).toFixed(1)}<small>%</small></span>
                    </header>
                    <p class="audiences-card__summary">${escapeText(seg.summary)}</p>
                    <dl class="audiences-card__stats">
                        <div>
                            <dt>Composite loneliness</dt>
                            <dd class="audiences-card__composite audiences-card__composite--${AudiencesTabView._tierFor(summary.compositeScore)}">
                                ${summary.compositeScore.toFixed(1)}<small>%</small>
                            </dd>
                        </div>
                    </dl>
                    <div class="audiences-card__topbuurten">
                        <span class="audiences-card__topbuurten-lbl">Highest-risk buurten</span>
                        <ol class="audiences-card__topbuurten-list">${topNamesHtml}</ol>
                    </div>
                </li>
            `;
        }).join('');
        slot.innerHTML = `
            <header class="audiences-tab__list-head">
                <h3 class="audiences-tab__list-title">Target audiences</h3>
                <p class="audiences-tab__list-hint">
                    Five demographic segments derived from the survey. Selecting a segment
                    surfaces matched events and reach-method recommendations on the right.
                </p>
            </header>
            <ul class="audiences-tab__cards">${itemsHtml}</ul>
        `;
        for (const card of slot.querySelectorAll('[data-role="segment"]')) {
            card.addEventListener('click', () => {
                const id = card.getAttribute('data-segment-id');
                if (!id || id === this._selectedId) return;
                this._selectedId = id;
                this._renderList();
                this._renderDetail();
            });
        }
    }

    /** @private */
    async _renderDetail() {
        const slot = this._root.querySelector('[data-slot="detail"]');
        const segment = SYSTEM_SEGMENTS.find(s => s.id === this._selectedId) ?? SYSTEM_SEGMENTS[0];
        if (!segment) {
            slot.innerHTML = `<div class="events-tab__placeholder"><p>No segments defined.</p></div>`;
            return;
        }
        const summary = this._summaryFor(segment);

        // Skeleton with loading state for the recs section while we
        // run the AI evaluator. Other sections render synchronously.
        slot.innerHTML = `
            <header class="audiences-detail__head">
                <h3 class="audiences-detail__title">${escapeText(segment.name)}</h3>
                <p class="audiences-detail__summary">${escapeText(segment.summary)}</p>
                <ul class="audiences-detail__badges">
                    <li><strong>${(summary.populationShare * 100).toFixed(1)}%</strong> of surveyed population</li>
                    <li>Composite loneliness: <strong>${summary.compositeScore.toFixed(1)}%</strong></li>
                    <li>${summary.affectedCount} buurten affected</li>
                </ul>
            </header>

            <section class="audiences-detail__section" data-section="events">
                <h4 class="audiences-detail__section-title">Proposed events for this audience</h4>
                <div class="audiences-detail__loading" data-role="events-loading">
                    <div class="loading__spinner" role="status" aria-label="Loading"></div>
                    <p>Generating tailored event proposals…</p>
                </div>
                <div class="audiences-detail__events" data-role="events" hidden></div>
            </section>

            <section class="audiences-detail__section">
                <h4 class="audiences-detail__section-title">Reach methods to consider</h4>
                ${AudiencesTabView._renderReachMethods(segment)}
            </section>

            <section class="audiences-detail__section">
                <h4 class="audiences-detail__section-title">Highest-risk buurten</h4>
                ${AudiencesTabView._renderRiskList(summary.topBuurten)}
            </section>

            <section class="audiences-detail__section">
                <h4 class="audiences-detail__section-title">Recent events targeting this audience</h4>
                ${this._renderRecentEvents(segment)}
            </section>
        `;

        try {
            const recs = await this._getRecsForSegment(segment, summary);
            const eventsContainer  = slot.querySelector('[data-role="events"]');
            const loadingContainer = slot.querySelector('[data-role="events-loading"]');
            if (loadingContainer) loadingContainer.hidden = true;
            if (eventsContainer) {
                eventsContainer.hidden = false;
                eventsContainer.innerHTML = AudiencesTabView._renderProposedEvents(recs);
            }
        } catch (err) {
            console.error('AudiencesTabView: rec generation failed', err);
            const loadingContainer = slot.querySelector('[data-role="events-loading"]');
            if (loadingContainer) {
                loadingContainer.innerHTML = `<p>Couldn't generate recommendations: ${escapeText(err.message ?? String(err))}</p>`;
            }
        }
    }

    /**
     * Aggregate per-segment data: population share, top-N highest-risk
     * buurten, and a composite loneliness score across those buurten.
     * Cached because each computation touches every buurt and every
     * segment is recomputed on every list re-render.
     *
     * @private
     */
    _summaryFor(segment) {
        const cached = this._summaryCache.get(segment.id);
        if (cached) return cached;
        const dem = this._services.demographicService;

        // Top-K by `lonely` is a fine proxy for "highest risk" composite —
        // it's the headline metric and avoids running four ranking passes.
        const ranked = dem.getNeighborhoodsRanked('lonely', segment.filter, 'desc');
        const topBuurten = ranked.slice(0, TOP_BUURT_LIMIT);

        // Composite "loneliness" score = average of the four loneliness
        // metric averages across the top-K, mirroring the existing
        // SidebarController._lonelinessScore convention.
        let composite = 0;
        if (topBuurten.length > 0) {
            const sums = new Map();
            const counts = new Map();
            for (const b of topBuurten) {
                const agg = dem.getAggregated(b.districtId, segment.filter);
                for (const k of LONELINESS_KEYS) {
                    const v = agg?.[k];
                    if (!Number.isFinite(v)) continue;
                    sums.set(k,   (sums.get(k)   ?? 0) + v);
                    counts.set(k, (counts.get(k) ?? 0) + 1);
                }
            }
            const perKeyAvgs = LONELINESS_KEYS
                .map(k => (sums.get(k) ?? 0) / Math.max(1, counts.get(k) ?? 1));
            composite = perKeyAvgs.reduce((a, b) => a + b, 0) / Math.max(1, perKeyAvgs.length);
        }

        // Affected count: buurten whose `lonely` score for this segment
        // is above the city-wide loneliness median for the segment.
        let affectedCount = 0;
        if (ranked.length > 0) {
            const median = ranked[Math.floor(ranked.length / 2)]?.value ?? 0;
            affectedCount = ranked.filter(r => r.value >= median).length;
        }

        const summary = {
            populationShare: dem.getPopulationShare(segment.filter),
            compositeScore:  Math.round(composite * 10) / 10,
            topBuurten,
            affectedCount
        };
        this._summaryCache.set(segment.id, summary);
        return summary;
    }

    /** @private */
    async _getRecsForSegment(segment, summary) {
        if (this._recsCache.has(segment.id)) return this._recsCache.get(segment.id);
        if (this._generating) return [];
        this._generating = true;
        try {
            // Build the buurt aggregates the AIService expects.
            const dem = this._services.demographicService;
            const buurtenData = summary.topBuurten.map(b => ({
                districtId:   b.districtId,
                districtName: b.districtName,
                metrics:      dem.getAggregated(b.districtId, segment.filter)
            }));
            const recs = await this._services.aiService.generateForSegment(
                segment,
                buurtenData,
                { skipDelay: true }
            );
            this._recsCache.set(segment.id, recs);
            return recs;
        } finally {
            this._generating = false;
        }
    }

    // ---------------- sub-renderers ----------------

    /** @private */
    static _renderProposedEvents(recs) {
        const events = (recs ?? []).filter(r => r.kind === 'event');
        if (events.length === 0) {
            return `<p class="audiences-detail__empty">No event proposals matched this segment's profile.</p>`;
        }
        return `
            <ul class="audiences-detail__rec-list">
                ${events.map(rec => {
                    const meta = RECOMMENDATION_KINDS[rec.kind] ?? { icon: '🎉', label: 'Event' };
                    const venue = PUBLIC_PLACE_CATALOGUE.find(p => p.key === rec.venuePlaceKey);
                    return `
                        <li class="audiences-detail__rec">
                            <div class="audiences-detail__rec-head">
                                <span class="audiences-detail__rec-icon" aria-hidden="true">${meta.icon}</span>
                                <h5 class="audiences-detail__rec-title">${escapeText(rec.title)}</h5>
                                <span class="rec-priority rec-priority--${rec.priority}">
                                    <span class="rec-priority__dot" aria-hidden="true"></span>
                                    ${escapeText(rec.priority?.[0]?.toUpperCase() + rec.priority?.slice(1))} priority
                                </span>
                            </div>
                            <p class="audiences-detail__rec-rationale">${escapeText(rec.rationale)}</p>
                            <dl class="audiences-detail__rec-facts">
                                ${rec.recurrence ? `<div><dt>Cadence</dt><dd>${escapeText(rec.recurrence)}</dd></div>` : ''}
                                ${venue ? `<div><dt>Venue</dt><dd>${venue.icon} ${escapeText(venue.label)}</dd></div>` : ''}
                                ${rec.audience ? `<div><dt>Audience</dt><dd>${escapeText(rec.audience)}</dd></div>` : ''}
                            </dl>
                        </li>
                    `;
                }).join('')}
            </ul>
        `;
    }

    /** @private */
    static _renderReachMethods(segment) {
        const methods = REACH_METHODS_BY_COHORT[segment.reachKind] ?? REACH_METHODS_BY_COHORT.broad;
        const rows = methods.map((m, i) => {
            const def = MARKETING_CHANNEL_LOOKUP[m.channel];
            const icon = def?.icon ?? '·';
            const label = def?.label ?? m.channel;
            const confidence = i === 0 ? 'high' : i === 1 ? 'medium' : 'low';
            return `
                <li class="audiences-reach">
                    <div class="audiences-reach__head">
                        <span class="audiences-reach__rank">${i + 1}</span>
                        <span class="audiences-reach__icon" aria-hidden="true">${icon}</span>
                        <span class="audiences-reach__label">${escapeText(label)}</span>
                        <span class="audiences-reach__confidence audiences-reach__confidence--${confidence}">${escapeText(confidence)} confidence</span>
                    </div>
                    <p class="audiences-reach__rationale">${escapeText(m.rationale)}</p>
                </li>
            `;
        }).join('');
        return `<ul class="audiences-detail__reach-list">${rows}</ul>`;
    }

    /** @private */
    static _renderRiskList(topBuurten) {
        if (!Array.isArray(topBuurten) || topBuurten.length === 0) {
            return `<p class="audiences-detail__empty">No buurten with matching demographic data.</p>`;
        }
        const max = topBuurten[0]?.value ?? 1;
        return `
            <ol class="audiences-risk-list">
                ${topBuurten.map(b => {
                    const tier = AudiencesTabView._tierFor(b.value);
                    const width = Math.max(8, Math.min(100, (b.value / max) * 100));
                    return `
                        <li class="audiences-risk-row">
                            <div class="audiences-risk-row__head">
                                <span class="audiences-risk-row__name">${escapeText(b.districtName)}</span>
                                <span class="audiences-risk-row__val audiences-risk-row__val--${tier}">${b.value.toFixed(1)}%</span>
                            </div>
                            <div class="audiences-risk-row__bar">
                                <span class="audiences-risk-row__bar-fill audiences-risk-row__bar-fill--${tier}"
                                      style="width:${width}%"></span>
                            </div>
                        </li>
                    `;
                }).join('')}
            </ol>
        `;
    }

    /** @private */
    _renderRecentEvents(segment) {
        const cohort = segment.reachKind;
        const records = this._services.eventStore.load();
        // Heuristic: an event "targets" this segment if its audience text
        // mentions a keyword aligned with the segment's cohort.
        const keywords = AudiencesTabView._keywordsForCohort(cohort);
        const matching = records.filter(r => {
            const text = `${r.audience ?? ''} ${r.title ?? ''}`.toLowerCase();
            return keywords.some(k => text.includes(k));
        }).slice(0, 5);
        if (matching.length === 0) {
            return `<p class="audiences-detail__empty">No registry events currently target this audience.</p>`;
        }
        return `
            <ul class="audiences-detail__recent">
                ${matching.map(r => `
                    <li class="audiences-detail__recent-row">
                        <span class="audiences-detail__recent-title">${escapeText(r.title)}</span>
                        <span class="audiences-detail__recent-meta">
                            ${escapeText(r.districtName ?? '')} · ${escapeText(r.status ?? '')}
                        </span>
                    </li>
                `).join('')}
            </ul>
        `;
    }

    /** @private */
    static _keywordsForCohort(cohort) {
        switch (cohort) {
            case 'youth':  return ['18', '24', 'student', 'young'];
            case 'senior': return ['55', '65', 'senior', 'elderly', 'housebound'];
            case 'family': return ['parent', 'famil', 'child', 'school'];
            default:       return ['adult'];
        }
    }

    /** @private */
    static _tierFor(score) {
        if (score >= 50) return 'bad';
        if (score >= 38) return 'warn';
        return 'good';
    }
}

function escapeAttr(s) {
    return String(s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
}

function escapeText(s) {
    return escapeAttr(s);
}
