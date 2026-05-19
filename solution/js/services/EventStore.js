import { MARKETING_CHANNELS } from '../models/EventRecord.js';

/**
 * EventStore
 * ----------
 * Persists `EventRecord[]` to `localStorage` under a single key. Acts as
 * the registry of every event a user has proposed, scheduled, completed,
 * or cancelled — across both the map view and the analytics view.
 *
 * Persistence model:
 *   - The whole array is round-tripped through JSON. The volume (a few
 *     hundred events maximum during a demo) makes this trivial.
 *   - On first load, if the storage key is empty, a deterministic seed
 *     dataset is materialised so the registry is never empty on a fresh
 *     browser. The seed is keyed to known buurt CBS codes from the live
 *     GeoJSON so navigations between map ↔ registry stay coherent.
 *
 * Future swap path:
 *   Replace the four `_storage*` methods to talk to a REST backend; the
 *   rest of the API stays identical.
 */
const STORAGE_KEY = 'rotterdam_loneliness_events_v1';

export class EventStore {
    constructor(options = {}) {
        this._storage = options.storage ?? (typeof window !== 'undefined' ? window.localStorage : null);
        /** @type {import('../models/EventRecord.js').EventRecord[]|null} */
        this._cache = null;
    }

    /** @returns {import('../models/EventRecord.js').EventRecord[]} */
    load() {
        if (this._cache) return this._cache.slice();
        const stored = this._storageGet();
        if (stored && Array.isArray(stored)) {
            this._cache = stored;
        } else {
            this._cache = EventStore._seed();
            this._persist();
        }
        return this._cache.slice();
    }

    /**
     * Returns a record by id.
     * @param {string} id
     * @returns {import('../models/EventRecord.js').EventRecord|null}
     */
    getById(id) {
        if (!this._cache) this.load();
        return this._cache.find(r => r.id === id) ?? null;
    }

    /**
     * Append a fully-formed record. Assigns `id` and timestamps if
     * missing. Returns the persisted record (with any auto-assigned
     * fields populated).
     *
     * @param {Partial<import('../models/EventRecord.js').EventRecord>} record
     * @returns {import('../models/EventRecord.js').EventRecord}
     */
    add(record) {
        if (!this._cache) this.load();
        const finalised = {
            ...record,
            id:        record.id ?? EventStore._uuid(),
            createdAt: record.createdAt ?? Date.now()
        };
        this._cache.push(finalised);
        this._persist();
        return finalised;
    }

    /**
     * Patch an existing record by id. Returns the updated record or
     * `null` if no record matches.
     *
     * @param {string} id
     * @param {Partial<import('../models/EventRecord.js').EventRecord>} partial
     * @returns {import('../models/EventRecord.js').EventRecord|null}
     */
    update(id, partial) {
        if (!this._cache) this.load();
        const idx = this._cache.findIndex(r => r.id === id);
        if (idx === -1) return null;
        const updated = { ...this._cache[idx], ...partial, id, updatedAt: Date.now() };
        this._cache[idx] = updated;
        this._persist();
        return updated;
    }

    /** @param {string} id */
    delete(id) {
        if (!this._cache) this.load();
        const before = this._cache.length;
        this._cache = this._cache.filter(r => r.id !== id);
        if (this._cache.length !== before) this._persist();
    }

    /**
     * @param {string} districtId
     * @returns {import('../models/EventRecord.js').EventRecord[]}
     */
    getByDistrict(districtId) {
        if (!this._cache) this.load();
        return this._cache.filter(r => r.districtId === districtId);
    }

    /**
     * @param {import('../models/EventRecord.js').EventStatus} status
     */
    getByStatus(status) {
        if (!this._cache) this.load();
        return this._cache.filter(r => r.status === status);
    }

    /**
     * Case-insensitive substring search across title, description, and
     * buurt name. Returns all records when the query is empty.
     *
     * @param {string} query
     * @returns {import('../models/EventRecord.js').EventRecord[]}
     */
    search(query) {
        if (!this._cache) this.load();
        const q = String(query ?? '').trim().toLowerCase();
        if (!q) return this._cache.slice();
        return this._cache.filter(r => {
            return (
                r.title?.toLowerCase().includes(q) ||
                r.description?.toLowerCase().includes(q) ||
                r.districtName?.toLowerCase().includes(q)
            );
        });
    }

    /**
     * Convert an AI-generated event recommendation into a draft
     * `EventRecord`. The result is NOT yet persisted — the caller
     * decides when to `add()`.
     *
     * @param {import('../models/RecommendationData.js').EventRecommendation} rec
     * @param {string} districtId
     * @param {string} districtName
     * @returns {import('../models/EventRecord.js').EventRecord}
     */
    fromRecommendation(rec, districtId, districtName) {
        return {
            id:               EventStore._uuid(),
            districtId,
            districtName,
            title:            rec.title,
            description:      rec.rationale,
            status:           'proposed',
            recurrence:       rec.recurrence,
            audience:         rec.audience,
            venuePlaceKey:    rec.venuePlaceKey,
            marketingMethods: EventStore._defaultMethodsFor(rec),
            populationTargeted: undefined,
            populationReached:  undefined,
            expectedImpact:   rec.expectedImpact,
            createdAt:        Date.now(),
            sourceKind:       'event'
        };
    }

    // ---------------- internals ----------------

    /** @private */
    _persist() {
        if (!this._storage) return;
        try {
            this._storage.setItem(STORAGE_KEY, JSON.stringify(this._cache));
        } catch (err) {
            console.warn('EventStore: failed to persist to localStorage', err);
        }
    }

    /** @private */
    _storageGet() {
        if (!this._storage) return null;
        try {
            const raw = this._storage.getItem(STORAGE_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (err) {
            console.warn('EventStore: failed to read localStorage', err);
            return null;
        }
    }

    /**
     * Heuristic default marketing methods derived from the audience hint
     * baked into the recommendation. Pure UX seed — the user can edit.
     *
     * @private
     */
    static _defaultMethodsFor(rec) {
        const aud = (rec?.audience ?? '').toLowerCase();
        const channels = [];
        if (/(\b18-24\b|\bstudent|young)/.test(aud)) channels.push('social_media');
        if (/(65\+|senior|65 or over|elderly|65 ?\+|55\+|housebound)/.test(aud)) {
            channels.push('gp_referral', 'social_worker');
        }
        if (/(parent|famil|child|school)/.test(aud)) channels.push('school_network');
        if (channels.length === 0) channels.push('flyer', 'community_screen');
        return channels.map(channel => ({ channel }));
    }

    /**
     * RFC 4122-ish v4 UUID using crypto.randomUUID when available, and a
     * Math.random fallback otherwise. Sufficient for client-side ids.
     *
     * @private
     */
    static _uuid() {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
        return 'ev-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    }

    /**
     * Deterministic seed used on first run so the registry never appears
     * empty during a demo. Buurt codes are taken from the live GeoJSON
     * (`rotterdam_neighborhoods.geojson`).
     *
     * @private
     */
    static _seed() {
        const now = Date.UTC(2026, 0, 15);  // stable, not Date.now()
        const week = 7 * 24 * 60 * 60 * 1000;
        return [
            {
                id: 'seed-001',
                districtId: 'BU05990110',
                districtName: 'Stadsdriehoek',
                title: 'Weekly community lunch for seniors',
                description: 'Free shared meal at the buurthuis, lowers the threshold to first contact for residents 65+ living alone.',
                status: 'scheduled',
                recurrence: 'Weekly · Saturdays 12:00',
                audience: 'Residents 65+ living alone',
                venuePlaceKey: 'communityCenter',
                marketingMethods: [{ channel: 'flyer' }, { channel: 'gp_referral' }, { channel: 'social_worker' }],
                populationTargeted: 60,
                createdAt: now - 6 * week,
                sourceKind: 'event'
            },
            {
                id: 'seed-002',
                districtId: 'BU05990324',
                districtName: 'Nieuwe Westen',
                title: 'Cook-your-home-country class',
                description: 'A free cooking class that builds bridges between first- and second-generation residents.',
                status: 'completed',
                recurrence: 'Bi-weekly · Wednesday evenings',
                audience: 'All adults, families welcome',
                venuePlaceKey: 'communityCenter',
                marketingMethods: [
                    { channel: 'flyer' },
                    { channel: 'school_network' },
                    { channel: 'whatsapp_group' }
                ],
                populationTargeted: 40,
                populationReached: 47,
                createdAt: now - 5 * week,
                sourceKind: 'event'
            },
            {
                id: 'seed-003',
                districtId: 'BU05991289',
                districtName: 'Groot-IJsselmonde',
                title: 'Repair café — bring something broken',
                description: 'Intergenerational repair café that pairs skilled retirees with younger residents needing help.',
                status: 'proposed',
                recurrence: 'Monthly · second Saturday',
                audience: 'All ages · intergenerational',
                venuePlaceKey: 'library',
                marketingMethods: [
                    { channel: 'flyer' },
                    { channel: 'community_screen' }
                ],
                populationTargeted: 35,
                createdAt: now - 2 * week,
                sourceKind: 'event'
            },
            {
                id: 'seed-004',
                districtId: 'BU05991463',
                districtName: 'Ommoord',
                title: 'Late-night study lounge with snacks',
                description: 'Library opens late on Tuesday & Thursday to reduce the "going out alone" barrier for younger residents.',
                status: 'scheduled',
                recurrence: 'Weekly · Tuesdays & Thursdays, 19:00–22:00',
                audience: 'Students & young adults',
                venuePlaceKey: 'library',
                marketingMethods: [
                    { channel: 'social_media' },
                    { channel: 'school_network' }
                ],
                populationTargeted: 80,
                createdAt: now - 4 * week,
                sourceKind: 'event'
            },
            {
                id: 'seed-005',
                districtId: 'BU05991699',
                districtName: 'Hoogvliet-Zuid',
                title: 'Walking & coffee group',
                description: 'Low-barrier outdoor activity for residents with movement impairment or below-average exercise.',
                status: 'completed',
                recurrence: 'Weekly · Wednesday mornings',
                audience: 'Mixed ages, walking-paced',
                venuePlaceKey: 'park',
                marketingMethods: [
                    { channel: 'gp_referral' },
                    { channel: 'newsletter' },
                    { channel: 'word_of_mouth' }
                ],
                populationTargeted: 25,
                populationReached: 18,
                createdAt: now - 8 * week,
                sourceKind: 'event'
            },
            {
                id: 'seed-006',
                districtId: 'BU05990110',
                districtName: 'Stadsdriehoek',
                title: 'Mindfulness drop-in',
                description: 'Weekly mindfulness session normalising self-care — a soft entry to mental-health support.',
                status: 'proposed',
                recurrence: 'Weekly · Monday evenings',
                audience: 'Adults · all backgrounds',
                venuePlaceKey: 'communityCenter',
                marketingMethods: [
                    { channel: 'social_media' },
                    { channel: 'community_screen' }
                ],
                populationTargeted: 30,
                createdAt: now - 1 * week,
                sourceKind: 'event'
            },
            {
                id: 'seed-007',
                districtId: 'BU05991289',
                districtName: 'Groot-IJsselmonde',
                title: 'Buurtmaaltijd — neighborhood cooking night',
                description: 'Potluck-style cooking night converting a passive meal into shared work.',
                status: 'cancelled',
                recurrence: 'Monthly · last Friday',
                audience: 'All adults, families welcome',
                venuePlaceKey: 'religiousVenue',
                marketingMethods: [{ channel: 'flyer' }, { channel: 'word_of_mouth' }],
                populationTargeted: 50,
                createdAt: now - 12 * week,
                sourceKind: 'event'
            },
            {
                id: 'seed-008',
                districtId: 'BU05990324',
                districtName: 'Nieuwe Westen',
                title: 'Open-mic poetry & storytelling night',
                description: 'Monthly partnership with a local café for expressive formats; tackles emotional loneliness.',
                status: 'scheduled',
                recurrence: 'Monthly · last Thursday',
                audience: 'Adults 18–35',
                venuePlaceKey: 'cafe',
                marketingMethods: [
                    { channel: 'social_media' },
                    { channel: 'whatsapp_group' }
                ],
                populationTargeted: 45,
                createdAt: now - 3 * week,
                sourceKind: 'event'
            }
        ];
    }
}

// Avoid an unused-import warning while keeping the import live for IDEs
// that resolve MARKETING_CHANNELS via this re-export.
export { MARKETING_CHANNELS };
