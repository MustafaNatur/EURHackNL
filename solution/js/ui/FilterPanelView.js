import { AGE_GROUPS, GENDERS } from '../models/DemographicData.js';

/**
 * FilterPanelView
 * ---------------
 * Renders the left rail of the Analytics dashboard: demographic
 * filters + the active buurt selector. Owns its own DOM and emits a
 * single `filterchange` custom event on its root whenever the user
 * touches any control.
 *
 * Filters exposed:
 *   - Buurt selector       — searchable dropdown over all CSV-backed buurten
 *   - Year                 — single-year selector (radar snapshot year)
 *   - Year range           — paired min/max selectors for the trend chart
 *   - Age groups           — multi-select chips
 *   - Gender               — All / Male / Female toggle
 *   - Ethnic group         — disabled placeholder ("data not available")
 *   - Personality          — disabled placeholder
 *
 * Filter shape passed in the event detail:
 *   {
 *     districtId:    string,
 *     snapshotYear:  number,
 *     yearsRange:    [number, number],
 *     filter:        { years, ages, genders }  // DemographicFilter
 *   }
 */
export class FilterPanelView extends EventTarget {
    /**
     * @param {{
     *   districts: { districtId: string, districtName: string }[],
     *   years: number[],
     *   ages?: string[],
     *   genders?: string[],
     *   initialDistrictId?: string|null,
     *   initialYear?: number
     * }} options
     */
    constructor(options) {
        super();
        this._districts = options.districts ?? [];
        this._years     = (options.years ?? []).slice().sort((a, b) => a - b);
        this._ageGroups = options.ages ?? AGE_GROUPS.slice();
        this._genders   = options.genders ?? GENDERS.slice();

        this._state = {
            districtId:   options.initialDistrictId ?? this._districts[0]?.districtId ?? null,
            snapshotYear: this._coerceYear(options.initialYear ?? this._years.at(-1)),
            yearMin:      this._years[0] ?? 2018,
            yearMax:      this._years.at(-1) ?? 2026,
            ages:         this._ageGroups.slice(),
            genders:      this._genders.slice()
        };

        /** @type {HTMLElement|null} */
        this._root = null;
    }

    /** Build the DOM and attach it under `container`. */
    mount(container) {
        const root = document.createElement('section');
        root.className = 'filter-panel';
        root.setAttribute('aria-labelledby', 'filter-panel-title');
        root.innerHTML = this._renderShell();
        container.appendChild(root);

        this._root = root;
        this._bindEvents();
        this._syncControls();
    }

    unmount() {
        this._root?.remove();
        this._root = null;
    }

    /** Programmatically point the selector at a buurt (used after a map click). */
    setDistrict(districtId) {
        if (!districtId) return;
        if (this._state.districtId === districtId) return;
        if (!this._districts.find(d => d.districtId === districtId)) return;
        this._state.districtId = districtId;
        this._syncControls();
        this._emitChange();
    }

    /** Current snapshot of the filter state — same shape as the event detail. */
    getState() {
        return {
            districtId:   this._state.districtId,
            snapshotYear: this._state.snapshotYear,
            yearsRange:   [this._state.yearMin, this._state.yearMax],
            filter: {
                years:   this._yearsInRange(),
                ages:    this._state.ages.slice(),
                genders: this._state.genders.slice()
            }
        };
    }

    // ---------------- internals ----------------

    /** @private */
    _renderShell() {
        const districtOptions = this._districts
            .map(d => `<option value="${escapeAttr(d.districtId)}">${escapeText(d.districtName)}</option>`)
            .join('');
        const yearOptions = this._years
            .map(y => `<option value="${y}">${y}</option>`)
            .join('');
        const ageChips = this._ageGroups.map(age => `
            <label class="chip">
                <input type="checkbox" data-role="age" value="${escapeAttr(age)}" />
                <span>${escapeText(age)}</span>
            </label>
        `).join('');
        const genderOptions = ['All', ...this._genders].map(g => `
            <label class="seg-btn">
                <input type="radio" name="gender" data-role="gender" value="${escapeAttr(g)}" />
                <span>${escapeText(g)}</span>
            </label>
        `).join('');

        return `
            <header class="filter-panel__head">
                <h2 id="filter-panel-title" class="filter-panel__title">Filters</h2>
                <p class="filter-panel__hint">Filter the Insights view by demographics &amp; year range.</p>
            </header>

            <div class="filter-group">
                <label class="filter-group__label" for="filter-district">Neighborhood</label>
                <input type="search" id="filter-district-search" class="filter-input"
                       placeholder="Type to filter buurten…" data-role="district-search"
                       autocomplete="off" />
                <select id="filter-district" class="filter-input" data-role="district" size="6">
                    ${districtOptions}
                </select>
            </div>

            <div class="filter-group">
                <label class="filter-group__label" for="filter-year">Snapshot year</label>
                <select id="filter-year" class="filter-input" data-role="snapshot-year">
                    ${yearOptions}
                </select>
                <span class="filter-group__hint">Radar chart compares this year vs. benchmark.</span>
            </div>

            <div class="filter-group">
                <span class="filter-group__label">Trend chart range</span>
                <div class="filter-range">
                    <select class="filter-input" data-role="year-min" aria-label="From year">
                        ${yearOptions}
                    </select>
                    <span aria-hidden="true">→</span>
                    <select class="filter-input" data-role="year-max" aria-label="To year">
                        ${yearOptions}
                    </select>
                </div>
            </div>

            <div class="filter-group">
                <span class="filter-group__label">Age group</span>
                <div class="chip-row" data-role="age-row">${ageChips}</div>
            </div>

            <div class="filter-group">
                <span class="filter-group__label">Gender</span>
                <div class="seg-row" role="radiogroup" aria-label="Gender filter">${genderOptions}</div>
            </div>

            <div class="filter-group filter-group--disabled">
                <span class="filter-group__label">Ethnic group</span>
                <button type="button" class="filter-disabled" disabled
                        title="The CBS survey used here does not break down by ethnicity. A future integration with the CBS wijkdata by ethnicity table would enable this filter.">
                    Data not available
                </button>
            </div>

            <div class="filter-group filter-group--disabled">
                <span class="filter-group__label">Personality</span>
                <button type="button" class="filter-disabled" disabled
                        title="Personality data (e.g. Big Five traits) is not in the survey. Marked as out-of-scope for the demo.">
                    Data not available
                </button>
            </div>
        `;
    }

    /** @private */
    _bindEvents() {
        const r = this._root;
        if (!r) return;

        r.querySelector('[data-role="district-search"]').addEventListener('input', (e) => {
            this._filterDistrictOptions(String(e.target.value ?? ''));
        });

        r.querySelector('[data-role="district"]').addEventListener('change', (e) => {
            this._state.districtId = e.target.value;
            this._emitChange();
        });

        r.querySelector('[data-role="snapshot-year"]').addEventListener('change', (e) => {
            this._state.snapshotYear = Number(e.target.value);
            this._emitChange();
        });

        r.querySelector('[data-role="year-min"]').addEventListener('change', (e) => {
            const v = Number(e.target.value);
            this._state.yearMin = v;
            if (v > this._state.yearMax) this._state.yearMax = v;
            this._syncRange();
            this._emitChange();
        });

        r.querySelector('[data-role="year-max"]').addEventListener('change', (e) => {
            const v = Number(e.target.value);
            this._state.yearMax = v;
            if (v < this._state.yearMin) this._state.yearMin = v;
            this._syncRange();
            this._emitChange();
        });

        r.querySelector('[data-role="age-row"]').addEventListener('change', () => {
            const checked = Array.from(r.querySelectorAll('input[data-role="age"]:checked'))
                .map(el => el.value);
            // Empty checked == "no filter" so the user sees all ages.
            this._state.ages = checked.length === 0 ? this._ageGroups.slice() : checked;
            this._emitChange();
        });

        for (const el of r.querySelectorAll('input[data-role="gender"]')) {
            el.addEventListener('change', () => {
                const val = r.querySelector('input[data-role="gender"]:checked')?.value ?? 'All';
                this._state.genders = val === 'All' ? this._genders.slice() : [val];
                this._emitChange();
            });
        }
    }

    /** @private */
    _filterDistrictOptions(query) {
        const q = query.trim().toLowerCase();
        const select = this._root?.querySelector('[data-role="district"]');
        if (!select) return;
        // Re-render the option list to keep search responsive.
        select.innerHTML = this._districts
            .filter(d => !q || d.districtName.toLowerCase().includes(q))
            .map(d => {
                const selected = d.districtId === this._state.districtId ? ' selected' : '';
                return `<option value="${escapeAttr(d.districtId)}"${selected}>${escapeText(d.districtName)}</option>`;
            })
            .join('');
    }

    /** @private */
    _syncControls() {
        const r = this._root;
        if (!r) return;

        const districtSel = r.querySelector('[data-role="district"]');
        if (districtSel) districtSel.value = this._state.districtId ?? '';

        r.querySelector('[data-role="snapshot-year"]').value = String(this._state.snapshotYear);
        this._syncRange();

        for (const cb of r.querySelectorAll('input[data-role="age"]')) {
            const all = this._state.ages.length === this._ageGroups.length;
            cb.checked = !all && this._state.ages.includes(cb.value);
        }

        const genderRadios = r.querySelectorAll('input[data-role="gender"]');
        const val = this._state.genders.length === this._genders.length
            ? 'All' : this._state.genders[0];
        for (const radio of genderRadios) {
            radio.checked = radio.value === val;
        }
    }

    /** @private */
    _syncRange() {
        const r = this._root;
        if (!r) return;
        const minSel = r.querySelector('[data-role="year-min"]');
        const maxSel = r.querySelector('[data-role="year-max"]');
        if (minSel) minSel.value = String(this._state.yearMin);
        if (maxSel) maxSel.value = String(this._state.yearMax);
    }

    /** @private */
    _yearsInRange() {
        const lo = Math.min(this._state.yearMin, this._state.yearMax);
        const hi = Math.max(this._state.yearMin, this._state.yearMax);
        return this._years.filter(y => y >= lo && y <= hi);
    }

    /** @private */
    _coerceYear(y) {
        const n = Number(y);
        if (!Number.isFinite(n) || this._years.length === 0) return this._years.at(-1) ?? 2022;
        if (n < this._years[0]) return this._years[0];
        if (n > this._years.at(-1)) return this._years.at(-1);
        return n;
    }

    /** @private */
    _emitChange() {
        this.dispatchEvent(new CustomEvent('filterchange', { detail: this.getState() }));
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
