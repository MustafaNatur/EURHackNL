/**
 * DistrictData
 * -------------
 * Plain data shape returned by DataService.fetchDistrictData().
 * Mirrors the schema of `rotterdam_neighborhood_health_2018_2022.csv`
 * plus a few identifier/geometry fields used by the UI.
 *
 * All percentage metrics are expressed as numbers in the closed
 * interval [0, 100], matching the CSV convention.
 */

/**
 * @typedef {Object} HealthMetrics
 *
 * Social / economic strain
 * @property {number} strugglingMakeEnds          - % struggling to make ends meet
 * @property {number} receivesSupportFromOthers   - % receiving informal support
 * @property {number} volunteerWork               - % doing volunteer work
 * @property {number} caregiver                   - % acting as informal caregiver
 *
 * Mental & psychosocial
 * @property {number} fragileHealthSocialDomain   - % with fragile social-domain health
 * @property {number} highRiskAnxietyOrDepression - % at high risk of anxiety/depression
 * @property {number} lowResilience               - % with low resilience
 * @property {number} moderateControlOverOwnLife  - % with only moderate self-control
 * @property {number} veryMuchStressLast4Weeks    - % reporting very high stress in last 4 weeks
 * @property {number} suicideThoughtsLast12Months - % with suicidal thoughts in last 12 months
 *
 * Physical health
 * @property {number} goodExperiencedHealth       - % rating own health as good
 * @property {number} movementImpairment          - % with movement impairment
 * @property {number} hearingImpairment           - % with hearing impairment
 * @property {number} weeklyExercising            - % exercising weekly
 *
 * Loneliness (primary focus)
 * @property {number} lonely                      - % lonely (overall)
 * @property {number} severelyLonely              - % severely lonely
 * @property {number} emotionallyLonely           - % emotionally lonely
 * @property {number} sociallyLonely              - % socially lonely
 */

/**
 * @typedef {Object} DistrictData
 * @property {string}            districtId   - Stable identifier (e.g. CBS wijkcode "WK059901")
 * @property {string}            districtName - Human-readable name (e.g. "Rotterdam Centrum")
 * @property {number}            year         - Reporting year
 * @property {[number, number]}  centroid     - [longitude, latitude] of district centroid
 * @property {HealthMetrics}     metrics      - Survey-derived percentage metrics
 */

/**
 * Ordered metric catalogue used by both DataService (for generation) and
 * SidebarController (for rendering). Grouping the schema in one place makes
 * it the single source of truth — adding a new CSV column is a one-line
 * change here.
 *
 * Each entry:
 *   key      - property name on HealthMetrics
 *   label    - human-readable label for the UI
 *   group    - section heading in the sidebar
 *   csvName  - original column header in the CSV (for traceability)
 *   range    - [min, max] plausible value range for fake-data generation
 *   highIsBad - true when a high % is undesirable (drives color coding)
 */
export const METRIC_CATALOGUE = Object.freeze([
    // Loneliness — primary focus
    { key: 'lonely',                      label: 'Lonely',                          group: 'Loneliness',   csvName: 'Lonely_25',                       range: [25, 65], highIsBad: true  },
    { key: 'severelyLonely',              label: 'Severely lonely',                 group: 'Loneliness',   csvName: 'SeverelyLonely_26',               range: [5, 25],  highIsBad: true  },
    { key: 'emotionallyLonely',           label: 'Emotionally lonely',              group: 'Loneliness',   csvName: 'EmotionallyLonely_27',            range: [15, 45], highIsBad: true  },
    { key: 'sociallyLonely',              label: 'Socially lonely',                 group: 'Loneliness',   csvName: 'SociallyLonely_28',               range: [20, 45], highIsBad: true  },

    // Social & economic
    { key: 'strugglingMakeEnds',          label: 'Struggling to make ends meet',    group: 'Social',       csvName: 'StrugglingMakeEnds',              range: [10, 30], highIsBad: true  },
    { key: 'receivesSupportFromOthers',   label: 'Receives informal support',       group: 'Social',       csvName: 'ReceivesSupportFromOthers',       range: [8, 22],  highIsBad: false },
    { key: 'volunteerWork',               label: 'Does volunteer work',             group: 'Social',       csvName: 'VolunteerWork',                   range: [20, 40], highIsBad: false },
    { key: 'caregiver',                   label: 'Informal caregiver',              group: 'Social',       csvName: 'Caregiver',                       range: [10, 25], highIsBad: false },

    // Mental & psychosocial
    { key: 'fragileHealthSocialDomain',   label: 'Fragile social-domain health',    group: 'Mental',       csvName: 'FragileHealthSocialDomain',       range: [8, 18],  highIsBad: true  },
    { key: 'highRiskAnxietyOrDepression', label: 'High risk of anxiety/depression', group: 'Mental',       csvName: 'HighRiskAnxietyDisorderOrDepression', range: [8, 22], highIsBad: true  },
    { key: 'lowResilience',               label: 'Low resilience',                  group: 'Mental',       csvName: 'LowResilience',                   range: [10, 22], highIsBad: true  },
    { key: 'moderateControlOverOwnLife',  label: 'Moderate self-control',           group: 'Mental',       csvName: 'ModerateControlOverMyOwnLife',    range: [55, 70], highIsBad: false },
    { key: 'veryMuchStressLast4Weeks',    label: 'High stress (last 4 weeks)',      group: 'Mental',       csvName: 'VeryMuchStressLast4Weeks',        range: [18, 32], highIsBad: true  },
    { key: 'suicideThoughtsLast12Months', label: 'Suicidal thoughts (12 mo)',       group: 'Mental',       csvName: 'SuicideThoughtsLast12Months',     range: [1, 6],   highIsBad: true  },

    // Physical
    { key: 'goodExperiencedHealth',       label: 'Good experienced health',         group: 'Physical',     csvName: 'GoodExperiencedHealth',           range: [65, 82], highIsBad: false },
    { key: 'movementImpairment',          label: 'Movement impairment',             group: 'Physical',     csvName: 'MovementImpairment',              range: [3, 12],  highIsBad: true  },
    { key: 'hearingImpairment',           label: 'Hearing impairment',              group: 'Physical',     csvName: 'HearingImpairment',               range: [2, 6],   highIsBad: true  },
    { key: 'weeklyExercising',            label: 'Exercises weekly',                group: 'Physical',     csvName: 'WeeklyExercising',                range: [50, 65], highIsBad: false }
]);

/** Keys of metrics that together make up the loneliness composite score. */
export const LONELINESS_KEYS = Object.freeze([
    'lonely',
    'severelyLonely',
    'emotionallyLonely',
    'sociallyLonely'
]);

/**
 * @typedef {Object} PublicPlace
 * @property {string} key       - Stable identifier (e.g. "communityCenter")
 * @property {string} label     - UI label (e.g. "Community centers")
 * @property {string} icon      - Single emoji used as a small visual cue
 * @property {string} influence - How the category typically affects loneliness:
 *                                'reduces' | 'mixed' | 'neutral'
 * @property {number} count     - Number of places of this type in the buurt
 */

/**
 * Catalogue of public-place categories the demo presents. The list is
 * deliberately curated around facilities that the literature associates
 * with social contact and loneliness:
 *
 *   - "reduces": consistent positive evidence (community centers, libraries,
 *               parks, senior centers, sports facilities, religious venues).
 *   - "mixed":   evidence is context-dependent (cafes, playgrounds: helpful
 *               for some demographics, less so for isolated elderly).
 *   - "neutral": broad infrastructure with weak/indirect links
 *               (transit stops, supermarkets).
 *
 * `densityPer1000` is the expected count per 1,000 residents and is used by
 * DataService to derive plausible random counts.
 */
export const PUBLIC_PLACE_CATALOGUE = Object.freeze([
    { key: 'communityCenter', label: 'Community centers',  icon: '🏛',   influence: 'reduces', densityPer1000: 0.20 },
    { key: 'library',         label: 'Libraries',          icon: '📚',  influence: 'reduces', densityPer1000: 0.10 },
    { key: 'park',            label: 'Parks & green areas', icon: '🌳', influence: 'reduces', densityPer1000: 0.45 },
    { key: 'seniorCenter',    label: 'Senior centers',     icon: '👵',  influence: 'reduces', densityPer1000: 0.18 },
    { key: 'sportsFacility',  label: 'Sports facilities',  icon: '🏃',  influence: 'reduces', densityPer1000: 0.40 },
    { key: 'religiousVenue',  label: 'Religious venues',   icon: '⛪',  influence: 'reduces', densityPer1000: 0.22 },
    { key: 'cafe',            label: 'Cafes & restaurants', icon: '☕', influence: 'mixed',   densityPer1000: 1.30 },
    { key: 'playground',      label: 'Playgrounds',        icon: '🛝',  influence: 'mixed',   densityPer1000: 0.60 },
    { key: 'transitStop',     label: 'Public transport stops', icon: '🚏', influence: 'neutral', densityPer1000: 1.10 },
    { key: 'supermarket',     label: 'Supermarkets',       icon: '🛒',  influence: 'neutral', densityPer1000: 0.18 }
]);

/** Subset of place categories whose presence is positively associated with reduced loneliness. */
export const SOCIAL_PLACES_KEYS = Object.freeze(
    PUBLIC_PLACE_CATALOGUE.filter(p => p.influence === 'reduces').map(p => p.key)
);

/**
 * @typedef {Object} OutreachChannel
 * @property {string} key        - Stable identifier (e.g. "adBanner")
 * @property {string} label      - UI label (e.g. "Outdoor ad banners")
 * @property {string} icon       - Single emoji used as a small visual cue
 * @property {string} descr      - One-line description for the inventory tile
 * @property {string} reachKind  - "high" | "targeted" | "trusted" | "digital"
 *                                  Drives tile tone and is referenced by AI heuristics.
 * @property {number} densityPer1000 - Expected count per 1,000 residents
 * @property {number} count      - Concrete count present in the buurt
 */

/**
 * Catalogue of outreach channels the municipality can use to reach
 * residents in a specific buurt. Counts are derived deterministically
 * per buurt by `scripts/build_database.py` (same pattern as
 * `PUBLIC_PLACE_CATALOGUE`).
 *
 * `reachKind` groups channels by the kind of audience they reach best:
 *   - "high":     mass-reach physical formats (banners, bus shelters,
 *                  flyers, local press)
 *   - "targeted": touchpoints frequented by specific cohorts (GP & pharmacy,
 *                  schools, religious venues)
 *   - "trusted":  human-to-human reach (door-to-door welzijn visits)
 *   - "digital":  online / on-screen channels (community-centre screens,
 *                  WhatsApp groups, supermarket community boards,
 *                  library noticeboards)
 *
 * `densityPer1000` matches the realistic scaling for each format. The
 * very high values (mailbox flyer, local press insert) represent reach
 * per 1,000 residents — i.e. ~one drop per household.
 */
export const OUTREACH_CHANNEL_CATALOGUE = Object.freeze([
    { key: 'adBanner',               label: 'Outdoor ad banners',          icon: '🪧', reachKind: 'high',     densityPer1000: 0.18, descr: 'JCDecaux/CS panels on main streets' },
    { key: 'busShelterPoster',       label: 'Bus-shelter posters (Mupi)',  icon: '🚏', reachKind: 'high',     densityPer1000: 0.50, descr: 'Tram & bus stop poster slots' },
    { key: 'mailboxFlyer',           label: 'Mailbox flyer drop',          icon: '📬', reachKind: 'high',     densityPer1000: 420,  descr: 'Household-level flyer distribution' },
    { key: 'localPressInsert',       label: 'Local-press inserts',         icon: '📰', reachKind: 'high',     densityPer1000: 380,  descr: 'Maasstadweekblad weekly insert reach' },
    { key: 'gpClinicPoster',         label: 'GP-clinic posters',           icon: '🩺', reachKind: 'targeted', densityPer1000: 0.14, descr: 'A3 posters in primary-care waiting rooms' },
    { key: 'pharmacyPoster',         label: 'Pharmacy noticeboards',       icon: '💊', reachKind: 'targeted', densityPer1000: 0.12, descr: 'Apotheek bulletin boards' },
    { key: 'libraryNoticeBoard',     label: 'Library bulletin boards',     icon: '📚', reachKind: 'digital',  densityPer1000: 0.10, descr: 'Pinboards inside the local library' },
    { key: 'supermarketBoard',       label: 'Supermarket community board', icon: '🛒', reachKind: 'digital',  densityPer1000: 0.18, descr: 'A4 community slots at AH / Lidl / Jumbo' },
    { key: 'schoolNewsletter',       label: 'School newsletters',          icon: '🎓', reachKind: 'targeted', densityPer1000: 0.22, descr: 'Inserts in primary-school weeklies' },
    { key: 'religiousVenueBulletin', label: 'Religious-venue bulletins',   icon: '⛪', reachKind: 'targeted', densityPer1000: 0.20, descr: 'Sunday/Friday handouts at churches & mosques' },
    { key: 'communityScreen',        label: 'Community-centre screens',    icon: '📺', reachKind: 'digital',  densityPer1000: 0.18, descr: 'Digital displays at community/senior centres' },
    { key: 'neighborhoodWhatsApp',   label: 'Buurtapp groups',             icon: '💬', reachKind: 'digital',  densityPer1000: 1.10, descr: 'Active WhatsApp / Nextdoor groups' },
    { key: 'doorToDoor',             label: 'Door-to-door welzijn visits', icon: '🚪', reachKind: 'trusted',  densityPer1000: 0.30, descr: 'Outreach workers, visits per week' }
]);

/** All outreach channel keys in the order declared in the catalogue. */
export const OUTREACH_CHANNEL_KEYS = Object.freeze(
    OUTREACH_CHANNEL_CATALOGUE.map(c => c.key)
);
