import {
    EVENT_STATUSES,
    EVENT_STATUS_LOOKUP,
    MARKETING_CHANNEL_LOOKUP
} from '../models/EventRecord.js';
import { PUBLIC_PLACE_CATALOGUE } from '../models/DistrictData.js';

/**
 * EventsTabView
 * -------------
 * Three-column events panel rendered in the Analytics > Events tab.
 *
 *   ┌────────────────┬──────────────────────────┬───────────────────┐
 *   │  Event list    │  Event detail            │  AI feedback      │
 *   │  (left rail)   │  (centre)                │  (right rail)     │
 *   └────────────────┴──────────────────────────┴───────────────────┘
 *
 * Behaviour:
 *   - List supports text search + status filter tabs. The first row is
 *     selected on mount so the centre/right columns are never empty.
 *   - Detail column is read-only (per the trimmed scope — full
 *     CRUD/edit form would land here in Phase 3 polish, but for the
 *     demo a clean read view + the existing recommendation-card "Save
 *     to registry" affordance covers the policy story).
 *   - AI feedback column runs `AIService.evaluateEvent()` against the
 *     selected event + the corresponding buurt's CURRENT-year metrics.
 *     A "Regenerate" affordance lets the user re-run the rule-based
 *     evaluation (deterministic, so output is identical without other
 *     input changes — that's intentional).
 *
 * Owned DOM lifecycle: built in `mount()`, fully torn down in
 * `unmount()` so re-mounting on tab switch starts from a clean slate.
 */
export class EventsTabView {
    /**
     * @param {{
     *   eventStore:  any,
     *   dataService: any,
     *   aiService:   any
     * }} services
     */
    constructor(services) {
        this._services = services;
        this._root = null;

        /** @type {string|null} */
        this._activeStatus = null;   // null = "All"
        /** @type {string} */
        this._query = '';
        /** @type {string|null} */
        this._selectedId = null;
        /** @type {Map<string, any>} cached AI feedback per event id */
        this._feedbackCache = new Map();
        /** @type {boolean} guards against concurrent feedback re-renders */
        this._evaluating = false;
    }

    async mount(container) {
        const root = document.createElement('div');
        root.className = 'events-tab';
        root.innerHTML = `
            <aside class="events-tab__list" data-slot="list"></aside>
            <section class="events-tab__detail" data-slot="detail"></section>
            <aside class="events-tab__feedback" data-slot="feedback"></aside>
        `;
        container.appendChild(root);
        this._root = root;

        // Initial selection: first record in the store. The list itself
        // renders on every render-pass so we don't need to special-case
        // the initial state.
        const all = this._services.eventStore.load();
        this._selectedId = all[0]?.id ?? null;

        await this._renderAll();
    }

    async unmount() {
        this._root?.remove();
        this._root = null;
        this._feedbackCache.clear();
    }

    // ---------------- rendering ----------------

    /**
     * Full re-render of the three columns. Cheap (innerHTML swap + a
     * single async fetch for AI feedback) so worth doing on every
     * interaction.
     * @private
     */
    async _renderAll() {
        if (!this._root) return;
        const records = this._filterRecords();
        const selected = this._resolveSelected(records);

        this._renderList(records, selected);
        await this._renderDetailAndFeedback(selected);
    }

    /** @private */
    _filterRecords() {
        const store = this._services.eventStore;
        const list = this._query
            ? store.search(this._query)
            : store.load();
        if (!this._activeStatus) return list;
        return list.filter(r => r.status === this._activeStatus);
    }

    /** @private */
    _resolveSelected(records) {
        if (this._selectedId) {
            const hit = records.find(r => r.id === this._selectedId);
            if (hit) return hit;
        }
        const fallback = records[0];
        this._selectedId = fallback?.id ?? null;
        return fallback ?? null;
    }

    /** @private */
    _renderList(records, selected) {
        const slot = this._root.querySelector('[data-slot="list"]');
        const tabs = [
            { key: null, label: 'All' },
            ...EVENT_STATUSES
        ];
        const tabsHtml = tabs.map(tab => {
            const active = tab.key === this._activeStatus;
            const label = tab.label ?? 'All';
            return `
                <button type="button" class="events-tab__status-tab${active ? ' events-tab__status-tab--active' : ''}"
                        data-role="status-tab" data-status="${tab.key ?? ''}">
                    ${escapeText(label)}
                </button>
            `;
        }).join('');

        const rowsHtml = records.length === 0
            ? `<li class="events-tab__empty">No events match the current filters.</li>`
            : records.map(r => EventsTabView._renderListRow(r, r.id === selected?.id)).join('');

        slot.innerHTML = `
            <header class="events-tab__list-head">
                <input type="search" class="events-tab__search"
                       placeholder="Search title, description, buurt…"
                       value="${escapeAttr(this._query)}"
                       data-role="search" autocomplete="off" />
                <div class="events-tab__status-tabs" role="tablist" aria-label="Status filter">
                    ${tabsHtml}
                </div>
            </header>
            <ul class="events-tab__rows">${rowsHtml}</ul>
            <footer class="events-tab__list-foot">
                <span>${records.length} event${records.length === 1 ? '' : 's'} shown</span>
            </footer>
        `;

        slot.querySelector('[data-role="search"]').addEventListener('input', (e) => {
            this._query = String(e.target.value ?? '');
            // Debounce minimally — local data, list re-render is cheap.
            this._renderAll();
        });
        for (const tab of slot.querySelectorAll('[data-role="status-tab"]')) {
            tab.addEventListener('click', () => {
                const next = tab.getAttribute('data-status') || null;
                this._activeStatus = next;
                this._renderAll();
            });
        }
        for (const row of slot.querySelectorAll('[data-role="event-row"]')) {
            row.addEventListener('click', () => {
                const id = row.getAttribute('data-event-id');
                if (!id || id === this._selectedId) return;
                this._selectedId = id;
                this._renderAll();
            });
        }
    }

    /** @private */
    static _renderListRow(record, isSelected) {
        const statusMeta = EVENT_STATUS_LOOKUP[record.status] ?? { label: record.status, tone: 'neutral' };
        const dt = new Date(record.createdAt ?? Date.now());
        const dateLabel = Number.isFinite(dt.getTime())
            ? dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
            : '—';
        return `
            <li class="events-tab__row${isSelected ? ' events-tab__row--selected' : ''}"
                role="button" tabindex="0"
                data-role="event-row" data-event-id="${escapeAttr(record.id)}">
                <div class="events-tab__row-head">
                    <span class="events-tab__row-title">${escapeText(record.title)}</span>
                    <span class="events-tab__status-pill events-tab__status-pill--${statusMeta.tone}">
                        ${escapeText(statusMeta.label)}
                    </span>
                </div>
                <div class="events-tab__row-meta">
                    <span>${escapeText(record.districtName ?? '')}</span>
                    <span class="events-tab__row-sep" aria-hidden="true">·</span>
                    <span>${escapeText(dateLabel)}</span>
                </div>
            </li>
        `;
    }

    /** @private */
    async _renderDetailAndFeedback(record) {
        const detailSlot = this._root.querySelector('[data-slot="detail"]');
        const feedbackSlot = this._root.querySelector('[data-slot="feedback"]');
        if (!record) {
            detailSlot.innerHTML = `
                <div class="events-tab__placeholder">
                    <p>Select an event from the list to inspect it.</p>
                </div>
            `;
            feedbackSlot.innerHTML = '';
            return;
        }

        detailSlot.innerHTML = EventsTabView._renderDetail(record);

        // Capture a deterministic loading message while we resolve the
        // buurt's metrics and run the rule-based evaluator. Render twice:
        // a loading state first, then the real feedback.
        feedbackSlot.innerHTML = EventsTabView._renderFeedbackLoading(record);

        try {
            await this._renderFeedbackPanel(record, feedbackSlot);
        } catch (err) {
            console.error('EventsTabView: feedback render failed', err);
            feedbackSlot.innerHTML = `
                <div class="events-feedback events-feedback--error">
                    <h3 class="events-feedback__title">AI feedback</h3>
                    <p>${escapeText(err.message ?? String(err))}</p>
                </div>
            `;
        }

        // "Regenerate" button on the feedback panel — clears the cache
        // entry and re-runs the evaluator with the staged loader.
        const regen = feedbackSlot.querySelector('[data-role="regen"]');
        if (regen) {
            regen.addEventListener('click', async () => {
                this._feedbackCache.delete(record.id);
                feedbackSlot.innerHTML = EventsTabView._renderFeedbackLoading(record);
                try {
                    await this._renderFeedbackPanel(record, feedbackSlot, { regenerate: true });
                } catch (err) {
                    console.error('EventsTabView: regenerate failed', err);
                }
            });
        }
    }

    /** @private */
    async _renderFeedbackPanel(record, slot, opts = {}) {
        if (this._evaluating) return;
        this._evaluating = true;
        try {
            let feedback = this._feedbackCache.get(record.id);
            if (!feedback) {
                const districtData = await this._fetchDistrictData(record);
                feedback = await this._services.aiService.evaluateEvent(record, districtData, {
                    skipDelay: !opts.regenerate
                });
                this._feedbackCache.set(record.id, feedback);
            }
            // Guard against late renders: if the user has navigated away
            // by now (different selection), drop the result silently.
            if (this._selectedId !== record.id) return;
            slot.innerHTML = EventsTabView._renderFeedback(feedback, record);
            const regen = slot.querySelector('[data-role="regen"]');
            if (regen) {
                regen.addEventListener('click', async () => {
                    this._feedbackCache.delete(record.id);
                    slot.innerHTML = EventsTabView._renderFeedbackLoading(record);
                    await this._renderFeedbackPanel(record, slot, { regenerate: true });
                });
            }
        } finally {
            this._evaluating = false;
        }
    }

    /**
     * Load the buurt's current-year metrics via DataService — keeps the
     * AI feedback honest, since the buurt's situation drives the gaps
     * and suggestions text.
     *
     * @private
     */
    async _fetchDistrictData(record) {
        const ds = this._services.dataService;
        await ds.load();
        const data = ds.getDistrictDataSync(record.districtId, ds.getDefaultYear(), {
            districtName: record.districtName
        });
        return data;
    }

    /** @private */
    static _renderDetail(record) {
        const statusMeta = EVENT_STATUS_LOOKUP[record.status] ?? { label: record.status, tone: 'neutral' };
        const venueLabel = EventsTabView._venueLabel(record.venuePlaceKey);
        const channelChips = (record.marketingMethods ?? [])
            .map(m => MARKETING_CHANNEL_LOOKUP[m.channel])
            .filter(Boolean)
            .map(def => `<span class="rec-chip">${def.icon} ${escapeText(def.label)}</span>`)
            .join('');

        const reachRow = record.populationTargeted || record.populationReached
            ? `
                <div class="events-detail__fact-grid">
                    <div class="events-detail__fact">
                        <span class="events-detail__fact-lbl">Population targeted</span>
                        <span class="events-detail__fact-val">${record.populationTargeted ?? '—'}</span>
                    </div>
                    <div class="events-detail__fact">
                        <span class="events-detail__fact-lbl">Population reached</span>
                        <span class="events-detail__fact-val">${record.populationReached ?? '—'}</span>
                    </div>
                </div>
            ` : '';

        return `
            <header class="events-detail__head">
                <div class="events-detail__heading">
                    <span class="events-tab__status-pill events-tab__status-pill--${statusMeta.tone}">
                        ${escapeText(statusMeta.label)}
                    </span>
                    <h3 class="events-detail__title">${escapeText(record.title)}</h3>
                    <p class="events-detail__location">${escapeText(record.districtName ?? '')}</p>
                </div>
            </header>
            <p class="events-detail__description">${escapeText(record.description ?? '')}</p>
            <dl class="events-detail__facts">
                ${record.audience ? `<div class="events-detail__fact-row"><dt>Audience</dt><dd>${escapeText(record.audience)}</dd></div>` : ''}
                ${record.recurrence ? `<div class="events-detail__fact-row"><dt>Cadence</dt><dd>${escapeText(record.recurrence)}</dd></div>` : ''}
                ${venueLabel ? `<div class="events-detail__fact-row"><dt>Venue</dt><dd>${venueLabel}</dd></div>` : ''}
                ${channelChips ? `<div class="events-detail__fact-row"><dt>Channels</dt><dd>${channelChips}</dd></div>` : ''}
            </dl>
            ${reachRow}
            <footer class="events-detail__foot">
                <p class="events-detail__hint">
                    Editing isn't wired up in this view. To add new events from the map view, use the
                    “Save to registry” affordance on the AI recommendation cards.
                </p>
            </footer>
        `;
    }

    /** @private */
    static _renderFeedbackLoading(record) {
        return `
            <section class="events-feedback events-feedback--loading" aria-live="polite">
                <header class="events-feedback__head">
                    <span class="events-feedback__sparkle" aria-hidden="true">✦</span>
                    <h3 class="events-feedback__title">AI feedback</h3>
                </header>
                <p class="events-feedback__loading-msg">Evaluating “${escapeText(record.title)}” against current buurt indicators…</p>
                <div class="loading__spinner" role="status" aria-label="Loading"></div>
            </section>
        `;
    }

    /** @private */
    static _renderFeedback(feedback, record) {
        const tone = feedback.effectivenessScore >= 70 ? 'good'
                   : feedback.effectivenessScore >= 45 ? 'warn'
                   : 'bad';
        const reachTone = feedback.reachAssessment?.tone === 'neutral' ? 'warn' : (feedback.reachAssessment?.tone ?? 'warn');
        const reachLabel = feedback.reachAssessment?.label ?? '—';
        const generated = feedback.generatedAt
            ? new Date(feedback.generatedAt).toLocaleString('en-GB', {
                day: '2-digit', month: 'short', year: 'numeric',
                hour: '2-digit', minute: '2-digit'
            })
            : '—';

        const gapItems = (feedback.gaps ?? [])
            .map(t => `<li>${escapeText(t)}</li>`).join('');
        const suggestionItems = (feedback.suggestions ?? [])
            .map(t => `<li>${escapeText(t)}</li>`).join('');

        return `
            <section class="events-feedback">
                <header class="events-feedback__head">
                    <span class="events-feedback__sparkle" aria-hidden="true">✦</span>
                    <h3 class="events-feedback__title">AI feedback</h3>
                    <button type="button" class="events-feedback__regen" data-role="regen"
                            aria-label="Regenerate AI feedback">↻ Regenerate</button>
                </header>

                <section class="events-feedback__score events-feedback__score--${tone}">
                    <div class="events-feedback__score-ring"
                         style="--pct:${feedback.effectivenessScore}">
                        <span class="events-feedback__score-num">${feedback.effectivenessScore}</span>
                    </div>
                    <div class="events-feedback__score-text">
                        <span class="events-feedback__score-lbl">Effectiveness score</span>
                        <span class="events-feedback__score-rationale">${escapeText(feedback.effectivenessRationale)}</span>
                    </div>
                </section>

                <section class="events-feedback__section">
                    <h4 class="events-feedback__section-title">Reach assessment</h4>
                    <span class="events-feedback__reach events-feedback__reach--${reachTone}">${escapeText(reachLabel)}</span>
                </section>

                <section class="events-feedback__section">
                    <h4 class="events-feedback__section-title">Gap analysis</h4>
                    <ul class="events-feedback__list">${gapItems}</ul>
                </section>

                <section class="events-feedback__section">
                    <h4 class="events-feedback__section-title">Suggested next steps</h4>
                    <ul class="events-feedback__list events-feedback__list--suggestions">${suggestionItems}</ul>
                </section>

                <footer class="events-feedback__foot">
                    Evaluated against ${escapeText(record.districtName ?? 'the selected buurt')}'s
                    most-recent indicators. Generated ${escapeText(generated)}.
                </footer>
            </section>
        `;
    }

    /** @private */
    static _venueLabel(placeKey) {
        if (!placeKey) return null;
        const def = PUBLIC_PLACE_CATALOGUE.find(p => p.key === placeKey);
        return def ? `${def.icon} ${escapeText(def.label)}` : escapeText(placeKey);
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
