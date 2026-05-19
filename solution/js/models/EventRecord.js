/**
 * EventRecord
 * -----------
 * Type definitions and constant catalogues for the event registry —
 * the persistent journal of interventions a user has proposed,
 * scheduled, completed, or cancelled.
 *
 * Runtime persistence lives in `services/EventStore.js`; this file owns
 * the schema, the enum-like constants, and the human-readable labels
 * referenced by both the registry UI and the AI feedback logic.
 */

/** @typedef {'proposed'|'scheduled'|'completed'|'cancelled'} EventStatus */

/**
 * Marketing / outreach channel used (or planned) for a single event.
 *
 * @typedef {Object} MarketingMethod
 * @property {string} channel  - one of `MARKETING_CHANNELS[*].key`
 * @property {string} [notes]  - free-text qualifier (e.g. "+ flyer drop")
 */

/**
 * @typedef {Object} EventRecord
 * @property {string}                   id
 * @property {string}                   districtId
 * @property {string}                   districtName
 * @property {string}                   title
 * @property {string}                   description
 * @property {EventStatus}              status
 * @property {string}                   [recurrence]
 * @property {string}                   [audience]
 * @property {string}                   [venuePlaceKey]
 * @property {MarketingMethod[]}        marketingMethods
 * @property {number}                   [populationTargeted]
 * @property {number}                   [populationReached]
 * @property {Object}                   [expectedImpact]
 * @property {string}                   [aiFeedback]
 * @property {number}                   createdAt
 * @property {number}                   [updatedAt]
 * @property {string}                   sourceKind
 */

/**
 * Ordered status enum with UI metadata. Order drives the status tab
 * order in `EventListView`; tone keys reuse the existing CSS variables
 * (`--good`, `--warn`, `--bad`, etc.) so we don't introduce new colours.
 */
export const EVENT_STATUSES = Object.freeze([
    { key: 'proposed',  label: 'Proposed',  tone: 'accent' },
    { key: 'scheduled', label: 'Scheduled', tone: 'good'   },
    { key: 'completed', label: 'Completed', tone: 'neutral' },
    { key: 'cancelled', label: 'Cancelled', tone: 'bad'    }
]);

/**
 * Marketing / outreach channels available to an event. Pulled from the
 * outreach-channel taxonomy but deliberately a smaller curated set —
 * the registry tracks *how the event was promoted*, not the buurt's
 * inventory of channels.
 */
export const MARKETING_CHANNELS = Object.freeze([
    { key: 'flyer',           label: 'Flyer drop',           icon: '📬', cohort: 'broad' },
    { key: 'social_media',    label: 'Social media',         icon: '📱', cohort: 'youth' },
    { key: 'newsletter',      label: 'Local newsletter',     icon: '📰', cohort: 'broad' },
    { key: 'gp_referral',     label: 'GP referral',          icon: '🩺', cohort: 'senior' },
    { key: 'social_worker',   label: 'Welzijn / social worker', icon: '🚪', cohort: 'senior' },
    { key: 'school_network',  label: 'School newsletter',    icon: '🎓', cohort: 'family' },
    { key: 'community_screen', label: 'Community screen',    icon: '📺', cohort: 'broad' },
    { key: 'whatsapp_group',  label: 'Buurtapp group',       icon: '💬', cohort: 'broad' },
    { key: 'word_of_mouth',   label: 'Word of mouth',        icon: '🗣', cohort: 'broad' }
]);

/** @type {Object.<string, {label: string, tone: string}>} */
export const EVENT_STATUS_LOOKUP = Object.freeze(
    EVENT_STATUSES.reduce((acc, s) => { acc[s.key] = s; return acc; }, {})
);

/** @type {Object.<string, {label: string, icon: string, cohort: string}>} */
export const MARKETING_CHANNEL_LOOKUP = Object.freeze(
    MARKETING_CHANNELS.reduce((acc, c) => { acc[c.key] = c; return acc; }, {})
);
