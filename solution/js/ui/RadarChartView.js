import { METRIC_CATALOGUE, LONELINESS_KEYS } from '../models/DistrictData.js';

/**
 * RadarChartView
 * --------------
 * Wraps Chart.js Radar for the analytics view. Displays up to three
 * concentric series:
 *
 *   1. Selected buurt under the current filter (filled, primary brand colour)
 *   2. Benchmark target (dashed border, neutral colour)
 *   3. City average under the same filter (dotted line, light tone)
 *
 * Axis convention — the catch.
 *   Chart.js Radar does NOT support per-axis `reverse: true` (radial
 *   scale is shared). To still render an honest "outward = bad" chart
 *   for indicators where higher is better (e.g. `weeklyExercising`,
 *   `volunteerWork`), we transform values *before plotting*:
 *
 *       plotted = highIsBad ? value : 100 - value
 *
 *   Tooltips reverse the transform so the displayed number is always
 *   the real percentage from the data. This is documented in
 *   IMPLEMENTATION_PLAN.md Section 7.4 (correction to "reverse:true").
 *
 * Default axes are the four loneliness metrics + the two strongest
 * co-indicators. A "Show all 18 metrics" toggle is provided.
 */
const DEFAULT_KEYS = Object.freeze([
    ...LONELINESS_KEYS,
    'highRiskAnxietyOrDepression',
    'strugglingMakeEnds'
]);

const COLORS = Object.freeze({
    primary:    'rgba(37, 99, 235, 0.85)',
    primaryFill:'rgba(37, 99, 235, 0.18)',
    benchmark:  'rgba(99, 102, 241, 0.95)',
    cityAvg:    'rgba(100, 116, 139, 0.95)'
});

export class RadarChartView {
    constructor(options = {}) {
        this._showAll = Boolean(options.showAll);
        /** @type {HTMLCanvasElement|null} */
        this._canvas = null;
        /** @type {any} */
        this._chart = null;
        this._root = null;
        this._lastInputs = null;
        this._onToggle = this._onToggle.bind(this);
    }

    mount(container) {
        const root = document.createElement('section');
        root.className = 'chart-panel chart-panel--radar';
        root.innerHTML = `
            <header class="chart-panel__head">
                <div>
                    <h3 class="chart-panel__title">Indicator profile</h3>
                    <p class="chart-panel__subtitle" data-role="subtitle">Select a neighborhood to view its radar profile.</p>
                </div>
                <button type="button" class="chart-toggle" data-role="toggle"
                        aria-pressed="${this._showAll}">
                    ${this._showAll ? 'Show key metrics' : 'Show all 18 metrics'}
                </button>
            </header>
            <div class="chart-panel__body">
                <canvas data-role="canvas" aria-label="Radar chart of neighborhood indicators"></canvas>
            </div>
            <footer class="chart-panel__foot" data-role="legend"></footer>
        `;
        container.appendChild(root);
        this._root   = root;
        this._canvas = root.querySelector('[data-role="canvas"]');
        root.querySelector('[data-role="toggle"]').addEventListener('click', this._onToggle);
    }

    unmount() {
        this._destroyChart();
        this._root?.remove();
        this._root = null;
        this._canvas = null;
    }

    /**
     * @param {{
     *   districtName: string,
     *   filterSummary: string,
     *   metrics:      Object.<string, number>,
     *   cityAverage:  Object.<string, number>,
     *   benchmark:    Object.<string, number>
     * }} inputs
     */
    update(inputs) {
        this._lastInputs = inputs;
        if (!this._canvas) return;
        if (!inputs?.metrics) {
            this._destroyChart();
            return;
        }

        const keys = this._showAll ? METRIC_CATALOGUE.map(m => m.key) : DEFAULT_KEYS;
        const labels = keys.map(k => METRIC_CATALOGUE.find(m => m.key === k)?.label ?? k);

        const transform = (metricKey, raw) => {
            const def = METRIC_CATALOGUE.find(m => m.key === metricKey);
            if (!def) return raw ?? 0;
            const v = Number.isFinite(raw) ? raw : 0;
            return def.highIsBad ? v : 100 - v;
        };

        const seriesBuurt = keys.map(k => transform(k, inputs.metrics?.[k]));
        const seriesCity  = keys.map(k => transform(k, inputs.cityAverage?.[k]));
        const seriesBench = keys.map(k => transform(k, inputs.benchmark?.[k]));

        const datasets = [
            {
                label: inputs.districtName || 'Selected buurt',
                data:  seriesBuurt,
                fill:  true,
                borderColor:     COLORS.primary,
                backgroundColor: COLORS.primaryFill,
                pointBackgroundColor: COLORS.primary,
                pointBorderColor: '#fff',
                pointRadius: 3,
                borderWidth: 2
            },
            {
                label: 'City average',
                data:  seriesCity,
                fill:  false,
                borderColor: COLORS.cityAvg,
                borderDash:  [2, 4],
                pointRadius: 0,
                borderWidth: 1.5
            }
        ];

        if (Object.keys(inputs.benchmark ?? {}).length > 0) {
            datasets.push({
                label: 'Benchmark target',
                data:  seriesBench,
                fill:  false,
                borderColor: COLORS.benchmark,
                borderDash:  [6, 4],
                pointRadius: 0,
                borderWidth: 2
            });
        }

        const subtitleEl = this._root?.querySelector('[data-role="subtitle"]');
        if (subtitleEl) subtitleEl.textContent =
            `${inputs.districtName} · ${inputs.filterSummary}`;

        if (!this._chart) {
            this._chart = new window.Chart(this._canvas, {
                type: 'radar',
                data: { labels, datasets },
                options: this._chartOptions(keys)
            });
        } else {
            this._chart.data.labels = labels;
            this._chart.data.datasets = datasets;
            this._chart.options = this._chartOptions(keys);
            this._chart.update('none');
        }

        this._renderLegend(keys);
    }

    /**
     * Re-render the chart with the same inputs, used after toggling the
     * "key metrics ↔ all 18" view.
     */
    refresh() {
        if (this._lastInputs) this.update(this._lastInputs);
    }

    // ---------------- internals ----------------

    /** @private */
    _onToggle() {
        this._showAll = !this._showAll;
        const btn = this._root?.querySelector('[data-role="toggle"]');
        if (btn) {
            btn.textContent = this._showAll ? 'Show key metrics' : 'Show all 18 metrics';
            btn.setAttribute('aria-pressed', String(this._showAll));
        }
        this.refresh();
    }

    /** @private */
    _chartOptions(keys) {
        return {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                r: {
                    suggestedMin: 0,
                    suggestedMax: 100,
                    ticks: { stepSize: 20, showLabelBackdrop: false, color: '#94a3b8', font: { size: 10 } },
                    grid:  { color: '#e2e8f0' },
                    angleLines: { color: '#e2e8f0' },
                    pointLabels: {
                        color: '#475569',
                        font: { size: 11 },
                        callback: (label) => this._wrapLabel(label)
                    }
                }
            },
            plugins: {
                legend: { display: false },  // we render our own
                tooltip: {
                    callbacks: {
                        label: (ctx) => {
                            const key = keys[ctx.dataIndex];
                            const def = METRIC_CATALOGUE.find(m => m.key === key);
                            const plotted = ctx.parsed.r;
                            const raw = def?.highIsBad ? plotted : 100 - plotted;
                            const suffix = def?.highIsBad
                                ? ''
                                : ' (higher is better)';
                            return `${ctx.dataset.label}: ${raw.toFixed(1)}%${suffix}`;
                        }
                    }
                }
            }
        };
    }

    /**
     * Soft line-wrap for axis labels so long names like "High risk of
     * anxiety/depression" don't bleed into neighbouring vertices.
     * @private
     */
    _wrapLabel(label) {
        const s = String(label ?? '');
        if (s.length <= 18) return s;
        const mid = Math.floor(s.length / 2);
        const left = s.lastIndexOf(' ', mid);
        const right = s.indexOf(' ', mid);
        const idx = left !== -1 ? left : right;
        if (idx === -1) return s;
        return [s.slice(0, idx), s.slice(idx + 1)];
    }

    /** @private */
    _renderLegend() {
        if (!this._root) return;
        const legendEl = this._root.querySelector('[data-role="legend"]');
        if (!legendEl) return;
        legendEl.innerHTML = `
            <ul class="chart-legend">
                <li class="chart-legend__item">
                    <span class="chart-legend__swatch" style="background:${COLORS.primary}"></span>
                    Selected buurt
                </li>
                <li class="chart-legend__item">
                    <span class="chart-legend__swatch chart-legend__swatch--dotted" style="border-color:${COLORS.cityAvg}"></span>
                    City average
                </li>
                <li class="chart-legend__item">
                    <span class="chart-legend__swatch chart-legend__swatch--dashed" style="border-color:${COLORS.benchmark}"></span>
                    Benchmark target
                </li>
            </ul>
            <p class="chart-legend__hint">
                Axes are oriented so that pushing outward always means a worse outcome —
                metrics where higher is better (e.g. weekly exercise, volunteering)
                are inverted before plotting. Tooltips show the raw percentage.
            </p>
        `;
    }

    /** @private */
    _destroyChart() {
        if (this._chart) {
            this._chart.destroy();
            this._chart = null;
        }
    }
}
