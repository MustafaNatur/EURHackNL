/**
 * Router
 * ------
 * Minimal hash-based router. Two responsibilities:
 *
 *   1. Mount/unmount registered routes when the URL hash changes.
 *      Exactly one route is mounted at a time; switching routes runs the
 *      outgoing route's `unmount` before the incoming route's `mount`.
 *   2. Keep the topbar's `[data-route]` navigation buttons in sync with
 *      the active route — the active button gets `--active` mod-class.
 *
 * The router is intentionally tiny: no query parsing, no nested routes,
 * no lazy code-splitting. Those are not needed for two top-level views
 * in a static-deploy demo.
 *
 * Routes are registered once at startup:
 *
 *     const router = new Router({ defaultRoute: 'map' });
 *     router.register('map',       { mount: () => mountMap(),       unmount: () => unmountMap() });
 *     router.register('analytics', { mount: () => mountAnalytics(), unmount: () => unmountAnalytics() });
 *     router.start();
 *
 * Programmatic navigation:
 *     router.navigate('analytics');
 */
export class Router {
    /**
     * @param {Object} [options]
     * @param {string} [options.defaultRoute='map']
     * @param {string} [options.navSelector='[data-route]']
     */
    constructor(options = {}) {
        this._defaultRoute = options.defaultRoute ?? 'map';
        this._navSelector  = options.navSelector  ?? '[data-route]';
        /** @type {Map<string, {mount: () => void|Promise<void>, unmount: () => void|Promise<void>}>} */
        this._routes      = new Map();
        /** @type {string|null} */
        this._currentRoute = null;
        this._started      = false;
        this._onHashChange = this._onHashChange.bind(this);
    }

    /**
     * Register a route's mount/unmount handlers. Routes are referenced by
     * name without the leading '#'; matching is case-insensitive.
     *
     * @param {string} name
     * @param {{ mount: () => void|Promise<void>, unmount: () => void|Promise<void> }} handlers
     */
    register(name, handlers) {
        if (!name || typeof name !== 'string') {
            throw new Error('Router.register: route name must be a non-empty string');
        }
        if (!handlers || typeof handlers.mount !== 'function' || typeof handlers.unmount !== 'function') {
            throw new Error(`Router.register("${name}"): handlers must include mount() and unmount()`);
        }
        this._routes.set(name.toLowerCase(), handlers);
    }

    /**
     * Begin listening to `hashchange` events and fire the initial route.
     * Safe to call once — subsequent calls are no-ops.
     */
    async start() {
        if (this._started) return;
        this._started = true;
        window.addEventListener('hashchange', this._onHashChange);
        await this._activate(this._resolveRouteFromHash());
    }

    /**
     * Programmatically navigate to a route. Updates the URL hash, which
     * in turn fires `hashchange` and runs the standard transition path.
     *
     * @param {string} name
     */
    navigate(name) {
        const route = (name ?? '').toLowerCase();
        if (!this._routes.has(route)) {
            console.warn(`Router.navigate: unknown route "${name}"`);
            return;
        }
        const target = `#${route}`;
        if (window.location.hash === target) {
            // Same hash → no hashchange event will fire. Activate anyway,
            // useful right after first registration.
            this._activate(route);
            return;
        }
        window.location.hash = target;
    }

    /** @returns {string|null} */
    currentRoute() {
        return this._currentRoute;
    }

    /** @private */
    _onHashChange() {
        this._activate(this._resolveRouteFromHash());
    }

    /**
     * Resolve the hash to a known route name, falling back to the default.
     * @private
     * @returns {string}
     */
    _resolveRouteFromHash() {
        const raw = (window.location.hash || '').replace(/^#/, '').toLowerCase();
        if (raw && this._routes.has(raw)) return raw;
        return this._defaultRoute;
    }

    /**
     * Run the unmount/mount transition. Idempotent: navigating to the
     * already-active route is a no-op (no double-mount).
     * @private
     */
    async _activate(name) {
        if (name === this._currentRoute) {
            this._syncNav();
            return;
        }
        const next = this._routes.get(name);
        if (!next) {
            console.warn(`Router._activate: route "${name}" is not registered`);
            return;
        }

        if (this._currentRoute) {
            const prev = this._routes.get(this._currentRoute);
            if (prev) {
                try {
                    await prev.unmount();
                } catch (err) {
                    console.error(`Router: unmount("${this._currentRoute}") failed`, err);
                }
            }
        }

        this._currentRoute = name;
        this._syncNav();

        try {
            await next.mount();
        } catch (err) {
            console.error(`Router: mount("${name}") failed`, err);
        }
    }

    /**
     * Toggle the `--active` mod-class on every nav button whose
     * `data-route` matches the active route.
     * @private
     */
    _syncNav() {
        if (!this._currentRoute) return;
        const buttons = document.querySelectorAll(this._navSelector);
        for (const btn of buttons) {
            const route = (btn.getAttribute('data-route') ?? '').toLowerCase();
            const active = route === this._currentRoute;
            btn.classList.toggle('topbar__nav-btn--active', active);
            btn.setAttribute('aria-current', active ? 'page' : 'false');
        }
    }
}
