/**
 * TimelineController
 * ------------------
 * Floating "year scrubber" pinned to the bottom of the map. Owns:
 *   - a range slider snapped to the discrete list of available years
 *   - a play / pause toggle that auto-advances the year every `tickMs`
 *   - a numeric display of the active year
 *
 * The control mounts itself as a sibling overlay inside the map's DOM
 * container (NOT registered with `map.addControl`) so it floats above
 * MapLibre tiles without competing with the legend's stack.
 *
 * Consumers subscribe with `onYearChange(cb)`; the callback receives
 * `(year, source)` where `source` is `'scrub'` (slider drag) or `'play'`
 * (autoplay tick). Source is provided in case the consumer wants to
 * react differently — today it's informational only.
 */
export class TimelineController {
    /**
     * @param {string} containerId  - DOM id of the map container.
     * @param {Object} options
     * @param {number[]} options.years
     * @param {number}   [options.initialYear]
     * @param {number}   [options.tickMs]  - autoplay step duration (ms)
     */
    constructor(containerId, options) {
        const container = document.getElementById(containerId);
        if (!container) {
            throw new Error(`Timeline container #${containerId} not found in DOM`);
        }
        const years = (options?.years ?? []).slice().sort((a, b) => a - b);
        if (years.length === 0) {
            throw new Error('TimelineController requires at least one year');
        }

        this._container  = container;
        this._years      = years;
        this._minYear    = years[0];
        this._maxYear    = years[years.length - 1];
        this._tickMs     = options?.tickMs ?? 900;
        this._year       = TimelineController._clampToYears(options?.initialYear ?? this._maxYear, years);
        /** @type {((year: number, source: 'scrub'|'play') => void) | null} */
        this._onYearChange = null;
        this._playing    = false;
        /** @type {number|null} */
        this._playTimer  = null;

        this._root        = null;
        this._sliderEl    = null;
        this._yearLabelEl = null;
        this._playBtnEl   = null;
    }

    /** Build the DOM. Idempotent. */
    init() {
        if (this._root) return;

        const root = document.createElement('div');
        root.className = 'timeline';
        root.setAttribute('role', 'group');
        root.setAttribute('aria-label', 'Year timeline');
        root.innerHTML = `
            <button type="button" class="timeline__play"
                    data-role="play" aria-label="Play timeline"
                    aria-pressed="false">
                <span class="timeline__play-icon" data-role="play-icon" aria-hidden="true">▶</span>
            </button>
            <div class="timeline__year-display">
                <span class="timeline__eyebrow">Year</span>
                <span class="timeline__year" data-role="year">${this._year}</span>
            </div>
            <div class="timeline__slider-wrap">
                <input type="range" class="timeline__slider"
                       data-role="slider"
                       min="${this._minYear}" max="${this._maxYear}"
                       step="1" value="${this._year}"
                       aria-valuemin="${this._minYear}"
                       aria-valuemax="${this._maxYear}"
                       aria-valuenow="${this._year}"
                       aria-label="Year" />
                <ul class="timeline__ticks">
                    ${this._years.map(y => `<li>${y}</li>`).join('')}
                </ul>
            </div>
        `;

        this._container.appendChild(root);

        this._root        = root;
        this._sliderEl    = root.querySelector('[data-role="slider"]');
        this._yearLabelEl = root.querySelector('[data-role="year"]');
        this._playBtnEl   = root.querySelector('[data-role="play"]');
        this._playIconEl  = root.querySelector('[data-role="play-icon"]');

        this._sliderEl.addEventListener('input', (e) => {
            // User interaction implicitly pauses autoplay.
            if (this._playing) this._stopAutoplay();
            const next = Number(e.target.value);
            this._applyYear(next, 'scrub');
        });
        this._sliderEl.addEventListener('pointerdown', () => {
            if (this._playing) this._stopAutoplay();
        });

        this._playBtnEl.addEventListener('click', () => this._togglePlay());
        this._syncSliderFill();
    }

    /** @returns {number} */
    getCurrentYear() {
        return this._year;
    }

    /**
     * Stops autoplay if it's currently running. Safe to call when not
     * playing — it's a no-op. Used by the router so the slider doesn't
     * keep ticking while the user is on another route.
     */
    pause() {
        if (this._playing) this._stopAutoplay();
    }

    /**
     * Set the year programmatically. No-op if already on that year.
     * Does not toggle autoplay state.
     * @param {number} year
     */
    setYear(year) {
        const next = TimelineController._clampToYears(year, this._years);
        if (next === this._year) return;
        this._sliderEl.value = String(next);
        this._applyYear(next, 'scrub');
    }

    /**
     * Subscribe to year changes (scrub + autoplay).
     * @param {(year: number, source: 'scrub'|'play') => void} cb
     */
    onYearChange(cb) {
        this._onYearChange = cb;
    }

    // ----------------------------------------------------------------
    //  Internals
    // ----------------------------------------------------------------

    /** @private */
    _applyYear(year, source) {
        this._year = year;
        this._yearLabelEl.textContent = String(year);
        this._sliderEl.setAttribute('aria-valuenow', String(year));
        this._syncSliderFill();
        if (this._onYearChange) this._onYearChange(year, source);
    }

    /**
     * Paint the slider's "filled" portion via a CSS custom property so
     * the track style (in styles.css) can render a gradient up to the
     * current value. We compute a 0..1 fraction here in JS to avoid
     * dealing with cross-browser ::-webkit-slider-runnable-track quirks.
     * @private
     */
    _syncSliderFill() {
        if (!this._sliderEl) return;
        const span = Math.max(1, this._maxYear - this._minYear);
        const fraction = (this._year - this._minYear) / span;
        this._sliderEl.style.setProperty('--fill', `${(fraction * 100).toFixed(2)}%`);
    }

    /** @private */
    _togglePlay() {
        if (this._playing) {
            this._stopAutoplay();
        } else {
            this._startAutoplay();
        }
    }

    /** @private */
    _startAutoplay() {
        if (this._playing) return;
        this._playing = true;
        this._root.classList.add('timeline--playing');
        this._playBtnEl.setAttribute('aria-pressed', 'true');
        this._playBtnEl.setAttribute('aria-label', 'Pause timeline');
        if (this._playIconEl) this._playIconEl.textContent = '❚❚';

        // If we're at the end, jump back to the start for a clean replay.
        if (this._year >= this._maxYear) {
            this._sliderEl.value = String(this._minYear);
            this._applyYear(this._minYear, 'play');
        }

        this._playTimer = window.setInterval(() => this._tick(), this._tickMs);
    }

    /** @private */
    _stopAutoplay() {
        if (!this._playing) return;
        this._playing = false;
        this._root.classList.remove('timeline--playing');
        this._playBtnEl.setAttribute('aria-pressed', 'false');
        this._playBtnEl.setAttribute('aria-label', 'Play timeline');
        if (this._playIconEl) this._playIconEl.textContent = '▶';
        if (this._playTimer != null) {
            window.clearInterval(this._playTimer);
            this._playTimer = null;
        }
    }

    /** @private */
    _tick() {
        const next = this._year >= this._maxYear ? this._minYear : this._year + 1;
        this._sliderEl.value = String(next);
        this._applyYear(next, 'play');
    }

    /** @private */
    static _clampToYears(year, years) {
        if (!Number.isFinite(year)) return years[years.length - 1];
        if (year <= years[0]) return years[0];
        if (year >= years[years.length - 1]) return years[years.length - 1];
        // Snap to the nearest available year (handles non-contiguous lists too).
        let nearest = years[0];
        let bestDist = Math.abs(year - nearest);
        for (const y of years) {
            const d = Math.abs(year - y);
            if (d < bestDist) { bestDist = d; nearest = y; }
        }
        return nearest;
    }
}
