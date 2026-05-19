import { METRIC_CATALOGUE, LONELINESS_KEYS } from '../models/DistrictData.js';

/**
 * TrendChartView
 * --------------
 * Wraps Chart.js Line for the analytics view. Shows three series for a
 * single user-chosen metric across the selected year range:
 *
 *   1. Selected buurt under the current filter (filled area)
 *   2. City average under the same filter
 *   3. Benchmark target — a flat horizontal line, only when the
 *      benchmark dataset has a value for the active metric
 *
 * A small pill-group above the chart lets the user pick which metric
 * to plot. The four loneliness keys are surfaced as quick picks; the
 * full 18 metrics are reachable via the dropdown.
 */
export class TrendChartView extends EventTarget {
    constructor() {
        super();
        this._root  = null;
        this._chart = null;
        this._canvas = null;
        this._activeMetric = 'lonely';
        this._lastInputs = null;
        this._onPick = this._onPick.bind(this);
        this._onSelect = this._onSelect.bind(this);
    }

    mount(container) {
        const root = document.createElement('section');
        root.className = 'chart-panel chart-panel--trend';
        root.innerHTML = `
            <header class="chart-panel__head">
                <div>
                    <h3 class="chart-panel__title">Year-over-year trend</h3>
                    <p class="chart-panel__subtitle" data-role="subtitle">Pick a metric to see the trajectory across the selected year range.</p>
                </div>
                <div class="trend-metric-pills" role="tablist" aria-label="Quick metric picker" data-role="pills">
                    ${LONELINESS_KEYS.map(k => {
                        const def = METRIC_CATALOGUE.find(m => m.key === k);
                        return `
                            <button type="button" role="tab" class="trend-pill"
                                    data-role="metric-pill" data-metric="${k}">
                                ${escapeText(def?.label ?? k)}
                            </button>`;
                    }).join('')}
                    <select class="trend-pill trend-pill--select" data-role="metric-select" aria-label="All metrics">
                        <option value="">All 18 metrics…</option>
                        ${METRIC_CATALOGUE.map(m =>
                            `<option value="${m.key}">${escapeText(m.label)}</option>`
                        ).join('')}
                    </select>
                </div>
            </header>
            <div class="chart-panel__body">
                <canvas data-role="canvas" aria-label="Trend line chart"></canvas>
            </div>
        `;
        container.appendChild(root);
        this._root = root;
        this._canvas = root.querySelector('[data-role="canvas"]');
        for (const btn of root.querySelectorAll('[data-role="metric-pill"]')) {
            btn.addEventListener('click', this._onPick);
        }
        root.querySelector('[data-role="metric-select"]').addEventListener('change', this._onSelect);
        this._syncPills();
    }

    unmount() {
        if (this._chart) this._chart.destroy();
        this._chart = null;
        this._root?.remove();
        this._root = null;
        this._canvas = null;
    }

    /**
     * @param {{
     *   districtName: string,
     *   filterSummary: string,
     *   buurtSeries:  {year: number, value: number}[],
     *   citySeries:   {year: number, value: number}[],
     *   benchmark:    {value: number, label: string} | null
     * }} inputs
     */
    update(inputs) {
        this._lastInputs = inputs;
        if (!this._canvas) return;
        if (!Array.isArray(inputs?.buurtSeries) || inputs.buurtSeries.length === 0) {
            this._destroyChart();
            return;
        }

        const labels = inputs.buurtSeries.map(p => p.year);
        const buurtData = inputs.buurtSeries.map(p => p.value);
        const citySeriesByYear = new Map(inputs.citySeries?.map(p => [p.year, p.value]) ?? []);
        const cityData = labels.map(y => citySeriesByYear.get(y) ?? null);

        const def = METRIC_CATALOGUE.find(m => m.key === this._activeMetric);
        const subtitleEl = this._root?.querySelector('[data-role="subtitle"]');
        if (subtitleEl) subtitleEl.textContent =
            `${def?.label ?? this._activeMetric} · ${inputs.districtName} · ${inputs.filterSummary}`;

        const datasets = [
            {
                label: inputs.districtName || 'Selected buurt',
                data:  buurtData,
                fill:  'origin',
                borderColor:     'rgba(37, 99, 235, 1)',
                backgroundColor: 'rgba(37, 99, 235, 0.12)',
                tension: 0.25,
                pointRadius: 3,
                pointBackgroundColor: 'rgba(37, 99, 235, 1)',
                pointBorderColor: '#fff'
            },
            {
                label: 'City average',
                data:  cityData,
                fill:  false,
                borderColor: 'rgba(100, 116, 139, 0.85)',
                borderDash:  [3, 3],
                tension: 0.25,
                pointRadius: 0
            }
        ];

        if (inputs.benchmark && Number.isFinite(inputs.benchmark.value)) {
            datasets.push({
                label: inputs.benchmark.label ?? 'Benchmark target',
                data:  labels.map(() => inputs.benchmark.value),
                fill:  false,
                borderColor: 'rgba(99, 102, 241, 0.95)',
                borderDash:  [6, 4],
                pointRadius: 0,
                borderWidth: 2
            });
        }

        const options = {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            scales: {
                x: { grid: { color: '#f1f5f9' }, ticks: { color: '#64748b' } },
                y: {
                    beginAtZero: false,
                    grid: { color: '#f1f5f9' },
                    ticks: { color: '#64748b', callback: v => `${v}%` }
                }
            },
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { color: '#475569', boxWidth: 14, font: { size: 11 } }
                },
                tooltip: {
                    callbacks: {
                        label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y?.toFixed(1)}%`
                    }
                }
            }
        };

        if (!this._chart) {
            this._chart = new window.Chart(this._canvas, {
                type: 'line',
                data: { labels, datasets },
                options
            });
        } else {
            this._chart.data.labels   = labels;
            this._chart.data.datasets = datasets;
            this._chart.options       = options;
            this._chart.update('none');
        }
    }

    /** @returns {string} the metric key currently selected for the trend. */
    activeMetric() {
        return this._activeMetric;
    }

    // ---------------- internals ----------------

    /** @private */
    _onPick(e) {
        const metric = e.currentTarget.getAttribute('data-metric');
        if (!metric) return;
        this._setMetric(metric);
    }

    /** @private */
    _onSelect(e) {
        const metric = e.target.value;
        if (!metric) return;
        this._setMetric(metric);
        // Reset the select to the placeholder so it's clear pills are
        // the primary control.
        e.target.value = '';
    }

    /** @private */
    _setMetric(metric) {
        if (metric === this._activeMetric) return;
        this._activeMetric = metric;
        this._syncPills();
        this.dispatchEvent(new CustomEvent('metricchange', { detail: { metric } }));
    }

    /** @private */
    _syncPills() {
        if (!this._root) return;
        for (const btn of this._root.querySelectorAll('[data-role="metric-pill"]')) {
            const active = btn.getAttribute('data-metric') === this._activeMetric;
            btn.classList.toggle('trend-pill--active', active);
            btn.setAttribute('aria-selected', active ? 'true' : 'false');
        }
    }

    /** @private */
    _destroyChart() {
        if (this._chart) {
            this._chart.destroy();
            this._chart = null;
        }
    }
}

function escapeText(s) {
    return String(s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
}
