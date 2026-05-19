/**
 * DemographicData
 * ---------------
 * Type definitions for the per-buurt × year × age × gender slice file
 * produced by `scripts/build_database.py` (`neighborhoods_demographic.json`).
 *
 * These are JSDoc typedefs only — there's no runtime behaviour here.
 * `DemographicService` is the runtime consumer.
 */

/**
 * Subset of dimensions a user can filter on. Every field is optional; an
 * absent field means "include all values for that dimension".
 *
 * @typedef {Object} DemographicFilter
 * @property {number[]} [years]    - e.g. [2018, 2022]
 * @property {string[]} [ages]     - e.g. ['25-34', '35-44']
 * @property {string[]} [genders]  - e.g. ['Female']
 */

/**
 * A single survey result row, isolated to one age × gender × year for
 * one buurt. The `metrics` object has the same shape as the per-buurt
 * `HealthMetrics` exposed by `DistrictData`.
 *
 * @typedef {Object} DemographicSlice
 * @property {number} year
 * @property {string} age
 * @property {string} gender
 * @property {Object.<string, number>} metrics
 */

/**
 * Order-stable list of age groups present in the demographic file. The
 * UI uses this for filter checkboxes so the rendering order is stable.
 */
export const AGE_GROUPS = Object.freeze([
    '18-24',
    '25-34',
    '35-44',
    '45-54',
    '55-64'
]);

/**
 * Order-stable list of genders present in the demographic file. The
 * survey is a binary-gender dataset; we expose it as-is and document the
 * limitation rather than synthesising additional categories.
 */
export const GENDERS = Object.freeze(['Male', 'Female']);
