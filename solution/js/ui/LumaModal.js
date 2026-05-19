import { PUBLIC_PLACE_CATALOGUE } from '../models/DistrictData.js';

/**
 * LumaModal
 * ---------
 * Singleton overlay that previews an AI-recommended event as it would
 * look on Luma (https://luma.com) and offers a CTA to host it there.
 *
 * Lifecycle:
 *   - install() — lazily creates the modal root in <body>. Idempotent.
 *   - show(eventRec, ctx) — fills it with the given event and opens.
 *   - hide() — closes and unfreezes scroll.
 *
 * The modal is owned globally: anyone in the UI layer can call
 * LumaModal.show(...) without holding a reference. This matches the
 * way browser-native dialogs are usually wired.
 */
export class LumaModal {
    /** @type {HTMLElement|null} */
    static _root = null;
    /** @type {HTMLElement|null} */
    static _bodyEl = null;
    static _keydownHandler = null;

    /** Lazily mount the modal shell. Safe to call repeatedly. */
    static install() {
        if (LumaModal._root) return;

        const el = document.createElement('div');
        el.className = 'luma-modal';
        el.setAttribute('aria-hidden', 'true');
        el.innerHTML = `
            <div class="luma-modal__backdrop" data-role="dismiss"></div>
            <div class="luma-modal__sheet" role="dialog" aria-modal="true"
                 aria-labelledby="luma-modal-title">
                <button type="button" class="luma-modal__close"
                        data-role="dismiss" aria-label="Close">×</button>
                <div class="luma-modal__body" data-role="body"></div>
            </div>
        `;
        document.body.appendChild(el);

        LumaModal._root = el;
        LumaModal._bodyEl = el.querySelector('[data-role="body"]');

        el.addEventListener('click', (e) => {
            if (e.target.closest('[data-role="dismiss"]')) LumaModal.hide();
        });

        LumaModal._keydownHandler = (e) => {
            if (e.key === 'Escape' && LumaModal.isOpen()) LumaModal.hide();
        };
        document.addEventListener('keydown', LumaModal._keydownHandler);
    }

    static isOpen() {
        return !!LumaModal._root && LumaModal._root.classList.contains('luma-modal--open');
    }

    /**
     * @param {import('../models/RecommendationData.js').EventRecommendation} rec
     * @param {{ districtName?: string, parentDistrict?: string }} [ctx]
     */
    static show(rec, ctx = {}) {
        LumaModal.install();
        LumaModal._bodyEl.innerHTML = LumaModal._render(rec, ctx);
        LumaModal._root.classList.add('luma-modal--open');
        LumaModal._root.setAttribute('aria-hidden', 'false');
        document.body.classList.add('luma-no-scroll');
    }

    static hide() {
        if (!LumaModal._root) return;
        LumaModal._root.classList.remove('luma-modal--open');
        LumaModal._root.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('luma-no-scroll');
    }

    // ----------------------------------------------------------------
    //  Rendering
    // ----------------------------------------------------------------

    /** @private */
    static _render(rec, ctx) {
        const seed = LumaModal._hash(`${rec.title}|${rec.audience ?? ''}`);
        const palette = LumaModal._palette(seed);
        const when = LumaModal._nextOccurrence(rec.recurrence, seed);
        const venue = LumaModal._venueLabel(rec.venuePlaceKey);
        const host = LumaModal._hostName(ctx);
        const district = ctx?.districtName || 'Rotterdam';
        const lumaUrl = 'https://luma.com';

        return `
            <article class="luma-event">
                <div class="luma-event__cover"
                     style="background: ${palette.gradient};">
                    <div class="luma-event__cover-glow"
                         style="background: ${palette.glow};"></div>
                    <div class="luma-event__cover-content">
                        <span class="luma-event__badge">
                            <span class="luma-event__badge-dot"></span>
                            Event preview
                        </span>
                        <h2 id="luma-modal-title" class="luma-event__title">${rec.title}</h2>
                        <p class="luma-event__subtitle">A neighborhood event for ${district}</p>
                    </div>
                    <div class="luma-event__cover-mark" aria-hidden="true">
                        <span class="luma-event__cover-glyph">✦</span>
                    </div>
                </div>

                <div class="luma-event__body">
                    <ul class="luma-event__facts">
                        <li class="luma-event__fact">
                            <div class="luma-event__fact-date">
                                <span class="luma-event__fact-date-mon">${when.monShort}</span>
                                <span class="luma-event__fact-date-day">${when.day}</span>
                            </div>
                            <div class="luma-event__fact-text">
                                <span class="luma-event__fact-title">${when.weekday}, ${when.monLong} ${when.day}</span>
                                <span class="luma-event__fact-meta">${when.timeRange} · ${when.year}</span>
                            </div>
                        </li>
                        <li class="luma-event__fact">
                            <div class="luma-event__fact-icon" aria-hidden="true">📍</div>
                            <div class="luma-event__fact-text">
                                <span class="luma-event__fact-title">${venue ?? 'Venue to be confirmed'}</span>
                                <span class="luma-event__fact-meta">${district}, Rotterdam</span>
                            </div>
                        </li>
                        ${rec.audience ? `
                        <li class="luma-event__fact">
                            <div class="luma-event__fact-icon" aria-hidden="true">👥</div>
                            <div class="luma-event__fact-text">
                                <span class="luma-event__fact-title">${rec.audience}</span>
                                <span class="luma-event__fact-meta">Open to the neighborhood</span>
                            </div>
                        </li>` : ''}
                    </ul>

                    <section class="luma-event__section">
                        <h3 class="luma-event__section-title">About the event</h3>
                        <p class="luma-event__description">${rec.rationale}</p>
                    </section>

                    <section class="luma-event__host">
                        <div class="luma-event__host-avatar"
                             style="background: ${palette.avatar};">${host.initials}</div>
                        <div class="luma-event__host-text">
                            <span class="luma-event__host-eyebrow">Hosted by</span>
                            <span class="luma-event__host-name">${host.name}</span>
                        </div>
                    </section>

                    <div class="luma-event__actions">
                        <a class="luma-event__cta" href="${lumaUrl}"
                           target="_blank" rel="noopener noreferrer">
                            <span class="luma-event__cta-mark" aria-hidden="true">lu·ma</span>
                            <span class="luma-event__cta-text">Host on Luma</span>
                            <span class="luma-event__cta-arrow" aria-hidden="true">→</span>
                        </a>
                        <button type="button" class="luma-event__secondary"
                                data-role="dismiss">
                            Maybe later
                        </button>
                    </div>

                    <p class="luma-event__footnote">
                        Luma is a third-party event platform. You'll be redirected to
                        <strong>luma.com</strong> to publish and manage attendance.
                    </p>
                </div>
            </article>
        `;
    }

    // ----------------------------------------------------------------
    //  Helpers
    // ----------------------------------------------------------------

    /** @private */
    static _venueLabel(placeKey) {
        if (!placeKey) return null;
        const def = PUBLIC_PLACE_CATALOGUE.find(p => p.key === placeKey);
        return def ? `${def.icon} ${def.label}` : placeKey;
    }

    /** @private */
    static _hostName(ctx) {
        const parent = ctx?.parentDistrict;
        const district = ctx?.districtName || 'Rotterdam';
        const name = parent
            ? `Gemeente Rotterdam · ${parent}`
            : `Gemeente Rotterdam · ${district}`;
        const initials = (parent || district)
            .replace(/[^a-zA-Z ]/g, '')
            .split(/\s+/).filter(Boolean)
            .slice(0, 2)
            .map(w => w[0].toUpperCase())
            .join('') || 'RR';
        return { name, initials };
    }

    /**
     * Parse the recurrence string (e.g. "Weekly · Saturdays 12:00") and
     * compute the next plausible occurrence. Deterministic given the
     * (recurrence, seed) pair so re-opening the modal doesn't shuffle
     * the date — but anchored to "today" so dates always look future.
     * @private
     */
    static _nextOccurrence(recurrence, seed) {
        const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const weekdayShort = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const monthsShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const monthsLong = ['January','February','March','April','May','June','July','August','September','October','November','December'];

        const text = String(recurrence ?? '').toLowerCase();
        const dayMatch = text.match(/\b(sun|mon|tue|wed|thu|fri|sat)/);
        const timeMatch = text.match(/\b(\d{1,2}):(\d{2})\b/);
        const morningHint = /morning/.test(text);
        const eveningHint = /evening|night/.test(text);

        const now = new Date();
        const target = new Date(now);
        if (dayMatch) {
            const map = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
            const want = map[dayMatch[1]];
            const cur = now.getDay();
            // Always at least 3 days out so it feels schedulable.
            let add = ((want - cur) + 7) % 7;
            if (add < 3) add += 7;
            target.setDate(now.getDate() + add);
        } else {
            target.setDate(now.getDate() + 7 + (seed % 7));
        }

        let hour = 18;
        let minute = 0;
        if (timeMatch) {
            hour = Math.min(23, Math.max(0, parseInt(timeMatch[1], 10)));
            minute = Math.min(59, Math.max(0, parseInt(timeMatch[2], 10)));
        } else if (morningHint) {
            hour = 10;
        } else if (eveningHint) {
            hour = 19;
        }
        target.setHours(hour, minute, 0, 0);

        const endHour = Math.min(23, hour + 2);
        const fmt = (h, m) =>
            `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        const timeRange = `${fmt(hour, minute)} – ${fmt(endHour, minute)}`;

        return {
            weekday: weekdays[target.getDay()],
            weekdayShort: weekdayShort[target.getDay()],
            monShort: monthsShort[target.getMonth()],
            monLong:  monthsLong[target.getMonth()],
            day:      target.getDate(),
            year:     target.getFullYear(),
            timeRange
        };
    }

    /**
     * Pick a deterministic Luma-style cover gradient based on a seed.
     * @private
     */
    static _palette(seed) {
        const palettes = [
            { gradient: 'linear-gradient(135deg, #1e1b4b 0%, #4338ca 45%, #9333ea 100%)',
              glow:     'radial-gradient(circle at 70% 20%, rgba(192, 132, 252, 0.45), transparent 60%)',
              avatar:   'linear-gradient(135deg, #a855f7, #6366f1)' },
            { gradient: 'linear-gradient(135deg, #0f172a 0%, #1e40af 50%, #06b6d4 100%)',
              glow:     'radial-gradient(circle at 25% 30%, rgba(56, 189, 248, 0.45), transparent 60%)',
              avatar:   'linear-gradient(135deg, #38bdf8, #2563eb)' },
            { gradient: 'linear-gradient(135deg, #1f1147 0%, #be185d 55%, #f97316 100%)',
              glow:     'radial-gradient(circle at 80% 80%, rgba(251, 146, 60, 0.45), transparent 55%)',
              avatar:   'linear-gradient(135deg, #fb7185, #f97316)' },
            { gradient: 'linear-gradient(135deg, #052e2b 0%, #047857 45%, #84cc16 100%)',
              glow:     'radial-gradient(circle at 20% 80%, rgba(132, 204, 22, 0.4), transparent 60%)',
              avatar:   'linear-gradient(135deg, #4ade80, #047857)' },
            { gradient: 'linear-gradient(135deg, #18181b 0%, #475569 50%, #facc15 110%)',
              glow:     'radial-gradient(circle at 75% 35%, rgba(250, 204, 21, 0.35), transparent 60%)',
              avatar:   'linear-gradient(135deg, #facc15, #f59e0b)' }
        ];
        return palettes[seed % palettes.length];
    }

    /** Tiny FNV-1a string hash. @private */
    static _hash(str) {
        let h = 2166136261 >>> 0;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return h >>> 0;
    }
}
