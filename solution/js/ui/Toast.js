/**
 * Toast
 * -----
 * Tiny, dependency-free toast notification module. Renders a queue of
 * lightweight messages in the fixed `#toast-region` element at the
 * bottom-right of the viewport.
 *
 *   Toast.show({ message: 'Saved.', tone: 'good' });
 *   Toast.show({
 *       message: 'Saved “Repair café” to the registry',
 *       action:  { label: 'Open registry', id: 'navigate-events' }
 *   });
 *
 * Subscribers register once for action ids:
 *
 *   Toast.onAction('navigate-events', () => router.navigate('analytics'));
 *
 * Toasts auto-dismiss after `defaultDurationMs`; the user can hover to
 * pause and dismiss manually via the close affordance.
 */
const ACTION_HANDLERS = new Map();

const DEFAULT_DURATION_MS = 5000;

function ensureRegion() {
    let region = document.getElementById('toast-region');
    if (!region) {
        region = document.createElement('div');
        region.id = 'toast-region';
        region.className = 'toast-region';
        region.setAttribute('aria-live', 'polite');
        region.setAttribute('aria-atomic', 'true');
        document.body.appendChild(region);
    }
    return region;
}

export class Toast {
    /**
     * @param {Object}  opts
     * @param {string}  opts.message              - Primary text. Plain string; HTML is escaped.
     * @param {'info'|'good'|'warn'|'bad'} [opts.tone='info']
     * @param {{label: string, id: string}} [opts.action]
     *   Optional action button. Clicking fires the handler registered via
     *   `Toast.onAction(id, …)` and dismisses the toast.
     * @param {number} [opts.durationMs]
     */
    static show(opts) {
        const region = ensureRegion();
        const tone     = opts?.tone ?? 'info';
        const message  = String(opts?.message ?? '').trim();
        const action   = opts?.action ?? null;
        const duration = Number.isFinite(opts?.durationMs) ? opts.durationMs : DEFAULT_DURATION_MS;
        if (!message) return;

        const el = document.createElement('div');
        el.className = `toast toast--${tone}`;
        el.setAttribute('role', 'status');
        el.innerHTML = `
            <span class="toast__msg"></span>
            ${action ? `<button type="button" class="toast__action" data-action-id="${escapeAttr(action.id)}">${escapeText(action.label)}</button>` : ''}
            <button type="button" class="toast__close" aria-label="Dismiss">&times;</button>
        `;
        el.querySelector('.toast__msg').textContent = message;

        const dismiss = () => {
            el.classList.add('toast--leaving');
            window.setTimeout(() => el.remove(), 200);
        };

        let dismissTimer = window.setTimeout(dismiss, duration);
        el.addEventListener('mouseenter', () => {
            if (dismissTimer) {
                window.clearTimeout(dismissTimer);
                dismissTimer = null;
            }
        });
        el.addEventListener('mouseleave', () => {
            if (!dismissTimer) {
                dismissTimer = window.setTimeout(dismiss, duration);
            }
        });

        el.querySelector('.toast__close').addEventListener('click', dismiss);
        const actionBtn = el.querySelector('.toast__action');
        if (actionBtn && action) {
            actionBtn.addEventListener('click', () => {
                const handler = ACTION_HANDLERS.get(action.id);
                try {
                    handler?.();
                } catch (err) {
                    console.error(`Toast action "${action.id}" handler failed`, err);
                }
                dismiss();
            });
        }

        region.appendChild(el);
        // Slide-in animation hook (CSS transitions from `.toast--entering`).
        requestAnimationFrame(() => el.classList.add('toast--shown'));
    }

    /**
     * Register a handler for the named action id. Re-registering replaces
     * the previous handler (so callers can safely re-bind on view mount).
     * @param {string} id
     * @param {() => void} handler
     */
    static onAction(id, handler) {
        if (!id) return;
        ACTION_HANDLERS.set(id, handler);
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
