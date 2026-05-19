#!/usr/bin/env python3
"""
build_database.py
-----------------
One-shot builder for the two JSON files that the front-end reads at runtime:

  data/neighborhoods_database.json      — per-buurt × year aggregates
                                          (consumed by the map view)
  data/neighborhoods_demographic.json   — per-buurt × year × age × gender slices
                                          (consumed by the Analytics view)

Both files describe the same underlying world, so by construction:

   mean( demographic.slices[buurt][year][age, gender][metric] )
   ==
   neighborhoods_database.json.neighborhoods[buurt].metricsByYear[year][metric]

This invariant matters because the map and the Analytics view must agree
on what "Charlois 2024 — lonely 41.7 %" means. Achieved by computing a
single per-buurt × year amplification offset and applying it identically
to the aggregate and to every contributing slice.

What lands in each record:

  identity         : CBS buurtcode, name, parent district, category
  source           : "csv"          — every CSV-relevant year matched cleanly
                     "csv-partial"  — some years from CSV, rest deterministic fill
                     "generated"    — no CSV match at all (buurt is industrial,
                                      green, etc.); aggregate-only, no demographic
                                      slices.
  metricsByYear    : { "2018"..."2026" → { 18 metric keys → percentage } }
  publicPlaces     : year-independent counts for the 10 facility categories,
                     scaled by population with deterministic jitter.
  outreachChannels : year-independent inventory of the 13 outreach channels,
                     same scaling recipe.

Schema v3 (this version) adds:
  - Demographic-level slices materialised in a sibling file.
  - Amplification baked into the build output (previously applied at
    runtime by DataService._amplifyForDemo, now removed from JS).

Run from the repo root:

    python3 solution/scripts/build_database.py
"""
from __future__ import annotations

import csv
import hashlib
import json
import math
import os
import random
from pathlib import Path


REPO_ROOT      = Path(__file__).resolve().parent.parent
DATA_DIR       = REPO_ROOT / "data"
CSV_PATH       = DATA_DIR / "rotterdam_neighborhood_health_2018_2022.csv"
GEOJSON_PATH   = DATA_DIR / "rotterdam_neighborhoods.geojson"
OUTPUT_PATH    = DATA_DIR / "neighborhoods_database.json"
DEMOGRAPHIC_PATH = DATA_DIR / "neighborhoods_demographic.json"

SCHEMA_VERSION = 3
# The CSV survey covers 2018–2022; later years (2023–2026) are deterministically
# generated per buurt × age × gender. A buurt that matched the CSV is therefore
# marked "csv-partial" (5 years from CSV + 4 generated), which is accurate.
YEARS          = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]
DEFAULT_YEAR   = 2026

# Demographic dimensions, must stay in sync with what the CSV actually contains
# (Stadsdriehoek 2018 18–24 Female … 55–64 Male).
AGE_GROUPS = ["18-24", "25-34", "35-44", "45-54", "55-64"]
GENDERS    = ["Male", "Female"]

# Loneliness metrics get the demo amplification treatment so the timeline
# tells a visible story. The 14 non-loneliness metrics are left at their
# raw averaged-from-CSV (or per-buurt drifted) values.
LONELINESS_KEYS = ("lonely", "severelyLonely", "emotionallyLonely", "sociallyLonely")

# Amplification parameters — ported from the previous JS AppConfig.demoAmplify*
# defaults so the visual story doesn't change when amplification moves from
# JS to Python.
AMPLIFY_FACTOR         = 6
AMPLIFY_TREND_MAX_PP   = 14
AMPLIFY_WAVE_MAX_PP    = 5

# Must stay in sync with METRIC_CATALOGUE in js/models/DistrictData.js.
METRIC_SCHEMA = [
    ("lonely",                      "Lonely_25",                          (25, 65)),
    ("severelyLonely",              "SeverelyLonely_26",                  (5, 25)),
    ("emotionallyLonely",           "EmotionallyLonely_27",               (15, 45)),
    ("sociallyLonely",              "SociallyLonely_28",                  (20, 45)),
    ("strugglingMakeEnds",          "StrugglingMakeEnds",                 (10, 30)),
    ("receivesSupportFromOthers",   "ReceivesSupportFromOthers",          (8, 22)),
    ("volunteerWork",               "VolunteerWork",                      (20, 40)),
    ("caregiver",                   "Caregiver",                          (10, 25)),
    ("fragileHealthSocialDomain",   "FragileHealthSocialDomain",          (8, 18)),
    ("highRiskAnxietyOrDepression", "HighRiskAnxietyDisorderOrDepression",(8, 22)),
    ("lowResilience",               "LowResilience",                      (10, 22)),
    ("moderateControlOverOwnLife",  "ModerateControlOverMyOwnLife",       (55, 70)),
    ("veryMuchStressLast4Weeks",    "VeryMuchStressLast4Weeks",           (18, 32)),
    ("suicideThoughtsLast12Months", "SuicideThoughtsLast12Months",        (1, 6)),
    ("goodExperiencedHealth",       "GoodExperiencedHealth",              (65, 82)),
    ("movementImpairment",          "MovementImpairment",                 (3, 12)),
    ("hearingImpairment",           "HearingImpairment",                  (2, 6)),
    ("weeklyExercising",            "WeeklyExercising",                   (50, 65)),
]
METRIC_KEYS = [k for k, _, _ in METRIC_SCHEMA]

# Must stay in sync with PUBLIC_PLACE_CATALOGUE in DistrictData.js.
PLACE_SCHEMA = [
    ("communityCenter", 0.20),
    ("library",         0.10),
    ("park",            0.45),
    ("seniorCenter",    0.18),
    ("sportsFacility",  0.40),
    ("religiousVenue",  0.22),
    ("cafe",            1.30),
    ("playground",      0.60),
    ("transitStop",     1.10),
    ("supermarket",     0.18),
]

# Must stay in sync with OUTREACH_CHANNEL_CATALOGUE in DistrictData.js.
OUTREACH_SCHEMA = [
    ("adBanner",               0.18),
    ("busShelterPoster",       0.50),
    ("mailboxFlyer",           420.0),
    ("localPressInsert",       380.0),
    ("gpClinicPoster",         0.14),
    ("pharmacyPoster",         0.12),
    ("libraryNoticeBoard",     0.10),
    ("supermarketBoard",       0.18),
    ("schoolNewsletter",       0.22),
    ("religiousVenueBulletin", 0.20),
    ("communityScreen",        0.18),
    ("neighborhoodWhatsApp",   1.10),
    ("doorToDoor",             0.30),
]

# Aliases: GeoJSON name -> CSV name when they differ.
NAME_ALIASES = {
    "CS-Kwartier": "CS-kwartier",
}


# ---------------------------------------------------------------------------
# Deterministic helpers
# ---------------------------------------------------------------------------

def seeded_rng(*parts) -> random.Random:
    """Deterministic RNG keyed by an arbitrary tuple of strings/ints."""
    h = hashlib.sha256("|".join(str(p) for p in parts).encode("utf-8")).digest()
    seed = int.from_bytes(h[:8], "big", signed=False)
    return random.Random(seed)


def hash_unit(*parts) -> float:
    """Deterministic [0, 1) value derived from the input tuple. Same recipe
    as DataService._hashUnit on the JS side, so the per-buurt trajectories
    that used to be computed in the browser come out identical here."""
    h = hashlib.sha256("|".join(str(p) for p in parts).encode("utf-8")).digest()
    n = int.from_bytes(h[:4], "big", signed=False)
    return n / 4_294_967_296


def trajectory_for(buurtcode: str) -> dict:
    """Per-buurt amplification trajectory: a bipolar trend offset + a
    sinusoidal wave with deterministic phase. Magnitudes stay in
    [40 %, 100 %] of the configured max so no buurt is visually flat."""
    a = hash_unit(buurtcode, "trend")
    b = hash_unit(buurtcode, "wave-amp")
    c = hash_unit(buurtcode, "wave-phase")

    sign = -1 if a < 0.5 else 1
    t    = a * 2 if a < 0.5 else (a - 0.5) * 2          # in [0, 1)
    # Empty inner 40 % of the range so no buurt comes out flat.
    trend_pp = sign * (AMPLIFY_TREND_MAX_PP * 0.4 + t * AMPLIFY_TREND_MAX_PP * 0.6)
    wave_amp = AMPLIFY_WAVE_MAX_PP * (0.4 + b * 0.6)
    wave_phase = c * 2 * math.pi
    return {"trend_pp": trend_pp, "wave_amp": wave_amp, "wave_phase": wave_phase}


# ---------------------------------------------------------------------------
# CSV ingestion
# ---------------------------------------------------------------------------

def load_csv_slices(years: list[int]) -> dict:
    """
    Read the survey CSV row-by-row and return the slice-level structure:

        slices[buurt_name][year][age][gender] = { metric_key: value }

    A buurt × year × age × gender combination appears at most once in the
    CSV; the survey doesn't repeat rows for the same demographic cell.
    Empty / non-numeric metric cells are dropped silently — downstream
    code treats them as missing.
    """
    out: dict = {}
    years_set = set(years)

    with open(CSV_PATH, newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            if row["Municipality"] != "Rotterdam":
                continue
            try:
                year = int(row["Year"])
            except ValueError:
                continue
            if year not in years_set:
                continue

            name   = row["Neighborhood"]
            age    = row["Age"]
            gender = row["Gender"]
            if age not in AGE_GROUPS or gender not in GENDERS:
                continue

            metrics: dict[str, float] = {}
            for key, csv_col, _ in METRIC_SCHEMA:
                raw = row.get(csv_col)
                if raw is None or raw == "":
                    continue
                try:
                    metrics[key] = float(raw)
                except ValueError:
                    continue

            if not metrics:
                continue

            (out.setdefault(name, {})
                .setdefault(year, {})
                .setdefault(age, {})[gender]) = metrics
    return out


def aggregate_slices_to_year(
    slices_for_buurt: dict,
    year: int,
) -> dict[str, float] | None:
    """Average each metric across all age × gender slices present for a
    buurt × year. Returns None when the year has no slices at all."""
    year_slices = slices_for_buurt.get(year)
    if not year_slices:
        return None
    sums:   dict[str, float] = {}
    counts: dict[str, int]   = {}
    for age, by_gender in year_slices.items():
        for gender, metrics in by_gender.items():
            for k, v in metrics.items():
                sums[k]   = sums.get(k, 0.0) + v
                counts[k] = counts.get(k, 0) + 1
    if not counts:
        return None
    return {k: round(sums[k] / counts[k], 1) for k in sums if counts[k] > 0}


# ---------------------------------------------------------------------------
# Per-buurt metric generation
# ---------------------------------------------------------------------------

def base_metrics(rng: random.Random) -> dict[str, float]:
    """Per-buurt baseline values, used as the anchor for year-over-year drift."""
    return {
        key: rng.uniform(*rng_range)
        for key, _, rng_range in METRIC_SCHEMA
    }


def generate_year_metrics(
    buurtcode: str,
    year: int,
    base: dict[str, float],
) -> dict[str, float]:
    """
    Deterministic per-year metrics that drift around the per-buurt base
    by at most ±2.5 % of each metric's plausible range. Used for buurten
    with no CSV match (industrial / green) and to fill gaps.
    """
    rng = seeded_rng(buurtcode, "metrics", year)
    out: dict[str, float] = {}
    for key, _, rng_range in METRIC_SCHEMA:
        lo, hi = rng_range
        span = hi - lo
        drift = rng.uniform(-0.025, 0.025) * span
        value = max(lo, min(hi, base[key] + drift))
        out[key] = round(value, 1)
    return out


def synthesize_slice_for_year(
    buurtcode: str,
    age: str,
    gender: str,
    year: int,
    anchor_slice: dict[str, float],
) -> dict[str, float]:
    """
    Synthesize a (buurt, age, gender) slice for a year that's outside the
    CSV's 2018–2022 window, by drifting from the most recent CSV slice
    (typically 2022). Drift is small (±3 % of the metric's plausible range)
    so the per-cohort character is preserved year-over-year.

    The amplification layer is applied *afterwards*, on the per-buurt
    aggregate — so this only needs to handle the underlying cohort drift.
    """
    rng = seeded_rng(buurtcode, age, gender, "slice", year)
    out: dict[str, float] = {}
    for key, _, rng_range in METRIC_SCHEMA:
        lo, hi = rng_range
        span = hi - lo
        anchor = anchor_slice.get(key)
        if anchor is None:
            anchor = (lo + hi) / 2
        drift = rng.uniform(-0.03, 0.03) * span
        out[key] = round(max(lo, min(hi, anchor + drift)), 1)
    return out


def build_slices_for_buurt(
    buurtcode: str,
    csv_slices: dict | None,
) -> dict:
    """
    Produce the complete (year × age × gender) slice map for a buurt
    that has *any* CSV data. The 2018–2022 slices come straight from the
    CSV; 2023–2026 are synthesised by drifting from the latest available
    CSV slice for each (age, gender) cell.

    Returns the nested dict {year: {age: {gender: {metric: value}}}}.
    Returns an empty dict when csv_slices is None (the caller should mark
    such buurten as "generated" with no demographic data).
    """
    if not csv_slices:
        return {}

    # For each (age, gender), find the most recent CSV slice to use as
    # the anchor when synthesising future years.
    anchors: dict[tuple[str, str], tuple[int, dict[str, float]]] = {}
    for year, by_age in csv_slices.items():
        for age, by_gender in by_age.items():
            for gender, metrics in by_gender.items():
                cur = anchors.get((age, gender))
                if cur is None or year > cur[0]:
                    anchors[(age, gender)] = (year, metrics)

    out: dict = {}
    for year in YEARS:
        out[year] = {}
        csv_year = csv_slices.get(year, {})
        for age in AGE_GROUPS:
            out[year][age] = {}
            for gender in GENDERS:
                slice_metrics = csv_year.get(age, {}).get(gender)
                if slice_metrics is not None:
                    # CSV slice may be missing a few metric columns; fill
                    # missing keys deterministically so every slice has the
                    # full 18-key shape downstream code expects.
                    full = synthesize_slice_for_year(
                        buurtcode, age, gender, year,
                        anchor_slice=slice_metrics,
                    )
                    full.update(slice_metrics)  # CSV wins where present
                    out[year][age][gender] = {
                        k: round(v, 1) for k, v in full.items()
                    }
                else:
                    anchor = anchors.get((age, gender))
                    anchor_slice = anchor[1] if anchor else {}
                    out[year][age][gender] = synthesize_slice_for_year(
                        buurtcode, age, gender, year, anchor_slice
                    )
    return out


def build_metrics_by_year(
    buurtcode: str,
    csv_by_year: dict[int, dict[str, float]] | None,
    slices_full: dict | None,
) -> tuple[dict[str, dict[str, float]], str]:
    """
    Pre-amplification yearly aggregate map per buurt.

    Two strategies, depending on whether the buurt has CSV data:

      - WITH CSV (slices_full present): derive the aggregate by literally
        averaging the (age × gender) slices for each year. This guarantees
        that demographic ↔ aggregate stay numerically consistent for both
        CSV years and the synthesised future years.

      - WITHOUT CSV: fall back to the per-buurt baseline + small drift.
        No demographic slices exist for these buurten, so consistency is
        only enforced for the aggregate itself.

    Every returned year has the full 18-metric shape.
    """
    base_rng = seeded_rng(buurtcode, "base")
    base = base_metrics(base_rng)

    if slices_full:
        # Anchor the baseline on the most recent CSV year so that the
        # source-tag heuristic below (`matched_full` / `matched_partial`)
        # remains meaningful.
        if csv_by_year:
            latest = max(csv_by_year.keys())
            for k, v in csv_by_year[latest].items():
                base[k] = v

    matched_full = 0
    matched_partial = 0
    metrics_by_year: dict[str, dict[str, float]] = {}

    for year in YEARS:
        csv_year = csv_by_year.get(year) if csv_by_year else None

        if slices_full and year in slices_full:
            # Average all (age, gender) cells for this year — both CSV-derived
            # and synthesised cells participate identically.
            sums: dict[str, float] = {}
            counts: dict[str, int]   = {}
            for age, by_gender in slices_full[year].items():
                for gender, metrics in by_gender.items():
                    for k, v in metrics.items():
                        sums[k]   = sums.get(k, 0.0) + v
                        counts[k] = counts.get(k, 0) + 1
            aggregated = {
                k: round(sums[k] / counts[k], 1)
                for k in sums if counts[k] > 0
            }
            # Belt and braces: fill any missing metric keys deterministically
            # so the front-end's normalisation never sees gaps.
            generated = generate_year_metrics(buurtcode, year, base)
            merged = dict(generated)
            merged.update(aggregated)
            metrics_by_year[str(year)] = merged
        else:
            metrics_by_year[str(year)] = generate_year_metrics(buurtcode, year, base)

        if csv_year:
            if len(csv_year) == len(METRIC_SCHEMA):
                matched_full += 1
            else:
                matched_partial += 1

    if matched_full == len(YEARS):
        source = "csv"
    elif matched_full + matched_partial > 0:
        source = "csv-partial"
    else:
        source = "generated"
    return metrics_by_year, source


# ---------------------------------------------------------------------------
# Amplification — the demo's signature year-over-year movement
# ---------------------------------------------------------------------------

def compute_amplification_offsets(
    buurtcode: str,
    metrics_by_year: dict[str, dict[str, float]],
) -> dict[str, dict[str, float]]:
    """
    Return per-year amplification offsets (in percentage points) for each
    loneliness metric, computed exactly as the previous JS code did:

        amplified(year) = clamp(0, 100,
            mean_over_years
              + (raw_year - mean_over_years) * factor
              + ramp(year)
              + wave(year))

        offset(year) = amplified(year) - raw_year

    The same offset is then applied to (a) the yearly aggregate that
    lands in neighborhoods_database.json and (b) every contributing
    age × gender slice in neighborhoods_demographic.json. That dual
    application is what keeps the two files consistent.

    Returns { year_str: { metric_key: offset_pp } }.
    """
    trajectory = trajectory_for(buurtcode)
    years_sorted = sorted(int(y) for y in metrics_by_year.keys())
    if len(years_sorted) < 2:
        return {str(y): {} for y in years_sorted}

    middle    = (years_sorted[0] + years_sorted[-1]) / 2
    span      = years_sorted[-1] - years_sorted[0]
    half_span = max(1, span / 2)

    offsets: dict[str, dict[str, float]] = {}
    for key in LONELINESS_KEYS:
        series = [metrics_by_year[str(y)].get(key) for y in years_sorted]
        finite = [v for v in series if v is not None]
        if not finite:
            continue
        mean = sum(finite) / len(finite)
        for i, year in enumerate(years_sorted):
            raw = series[i]
            if raw is None:
                continue
            ramp = trajectory["trend_pp"] * ((year - middle) / half_span)
            wave = trajectory["wave_amp"] * math.sin(
                2 * math.pi * (year - years_sorted[0]) / max(1, span)
                + trajectory["wave_phase"]
            )
            amplified = mean + (raw - mean) * AMPLIFY_FACTOR + ramp + wave
            amplified = max(0.0, min(100.0, amplified))
            offsets.setdefault(str(year), {})[key] = round(amplified - raw, 4)

    # Ensure every year is present in the result, even if empty.
    for y in years_sorted:
        offsets.setdefault(str(y), {})
    return offsets


def apply_offsets_to_aggregate(
    metrics_by_year: dict[str, dict[str, float]],
    offsets: dict[str, dict[str, float]],
) -> dict[str, dict[str, float]]:
    """Apply amplification offsets to the yearly aggregate, clamping to
    [0, 100] and rounding to 1 decimal — matching what the JS code used
    to do at runtime."""
    out: dict[str, dict[str, float]] = {}
    for year_str, metrics in metrics_by_year.items():
        out[year_str] = dict(metrics)
        for key, delta in offsets.get(year_str, {}).items():
            if key in out[year_str]:
                amplified = out[year_str][key] + delta
                out[year_str][key] = round(max(0.0, min(100.0, amplified)), 1)
    return out


def apply_offsets_to_slices(
    slices_for_buurt: dict,
    offsets: dict[str, dict[str, float]],
) -> dict:
    """Apply the same per-year, per-metric offset to every age × gender
    slice. Preserves the invariant that the average across slices for
    (buurt, year) equals the amplified aggregate, modulo small clamping
    drift at the extremes — which is acceptable for a demo."""
    out: dict = {}
    for year, by_age in slices_for_buurt.items():
        year_offsets = offsets.get(str(year), {})
        out[year] = {}
        for age, by_gender in by_age.items():
            out[year][age] = {}
            for gender, metrics in by_gender.items():
                adjusted = dict(metrics)
                for key, delta in year_offsets.items():
                    if key in adjusted:
                        v = adjusted[key] + delta
                        adjusted[key] = round(max(0.0, min(100.0, v)), 1)
                out[year][age][gender] = adjusted
    return out


# ---------------------------------------------------------------------------
# Public-place / outreach generation (unchanged from v2)
# ---------------------------------------------------------------------------

def generate_public_places(rng: random.Random, population: int) -> list[dict]:
    per_1000 = max(1, population) / 1000.0
    out = []
    for key, density in PLACE_SCHEMA:
        expected = density * per_1000
        jitter   = 0.65 + rng.random() * 0.70  # 0.65 .. 1.35
        count    = round(expected * jitter)
        if population < 100:
            count = min(count, 1)
        out.append({"key": key, "count": max(0, count)})
    return out


def generate_outreach_channels(rng: random.Random, population: int) -> list[dict]:
    per_1000 = max(1, population) / 1000.0
    out: list[dict] = []
    for key, density in OUTREACH_SCHEMA:
        expected = density * per_1000
        jitter   = 0.65 + rng.random() * 0.70
        count    = round(expected * jitter)
        if population < 100:
            count = min(count, 1)
        out.append({"key": key, "count": max(0, count)})
    return out


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def build() -> tuple[dict, dict]:
    csv_slices = load_csv_slices(YEARS)
    geojson    = json.loads(GEOJSON_PATH.read_text(encoding="utf-8"))

    db: dict = {
        "schemaVersion": SCHEMA_VERSION,
        "years":         YEARS,
        "defaultYear":   DEFAULT_YEAR,
        "neighborhoods": {},
    }
    demographic_db: dict = {
        "schemaVersion": SCHEMA_VERSION,
        "years":         YEARS,
        "ageGroups":     AGE_GROUPS,
        "genders":       GENDERS,
        "neighborhoods": {},
    }

    counts = {"csv": 0, "csv-partial": 0, "generated": 0}
    demographic_buurt_count = 0
    slice_count = 0

    for feat in geojson["features"]:
        p = feat["properties"]
        buurtcode  = p["id"]
        name       = p["name"]
        population = int(p.get("population") or 0)

        csv_name      = NAME_ALIASES.get(name, name)
        csv_for_buurt = csv_slices.get(csv_name)
        csv_aggregate = None
        if csv_for_buurt:
            csv_aggregate = {
                y: agg for y in csv_for_buurt
                if (agg := aggregate_slices_to_year(csv_for_buurt, y))
            }

        # 1) Build the full slice map (only if the buurt has any CSV data).
        # The aggregate is then derived from these slices so the two
        # datasets cannot drift apart.
        slices_full = build_slices_for_buurt(buurtcode, csv_for_buurt) if csv_for_buurt else None

        # 2) Build the per-year aggregate + decide the provenance tag.
        metrics_by_year, source = build_metrics_by_year(buurtcode, csv_aggregate, slices_full)
        counts[source] = counts.get(source, 0) + 1

        # 3) Compute per-year amplification offsets once, share across files.
        offsets = compute_amplification_offsets(buurtcode, metrics_by_year)

        # 4) Apply offsets to the aggregate destined for the main file.
        metrics_by_year = apply_offsets_to_aggregate(metrics_by_year, offsets)

        # 5) Material public-place / outreach inventories (year-independent).
        place_rng    = seeded_rng(buurtcode, "places")
        outreach_rng = seeded_rng(buurtcode, "outreach")

        db["neighborhoods"][buurtcode] = {
            "districtId":       buurtcode,
            "districtName":     name,
            "source":           source,
            "metricsByYear":    metrics_by_year,
            "publicPlaces":     generate_public_places(place_rng, population),
            "outreachChannels": generate_outreach_channels(outreach_rng, population),
        }

        # 6) Only emit demographic slices for buurten that had CSV data,
        # following the plan's design (buurten with no CSV → no meaningful
        # demographic breakdown to expose). They still show up in the map
        # view, just not in the Analytics filters.
        if slices_full:
            slices_full = apply_offsets_to_slices(slices_full, offsets)
            demographic_db["neighborhoods"][buurtcode] = {
                "districtId":   buurtcode,
                "districtName": name,
                "slices":       _flatten_slices(slices_full),
            }
            demographic_buurt_count += 1
            slice_count += len(demographic_db["neighborhoods"][buurtcode]["slices"])

    db["stats"] = {
        "total":       sum(counts.values()),
        "fromCsv":     counts["csv"],
        "csvPartial":  counts["csv-partial"],
        "generated":   counts["generated"],
    }
    demographic_db["stats"] = {
        "buurten": demographic_buurt_count,
        "slices":  slice_count,
    }
    print(f"  full CSV coverage:   {counts['csv']}")
    print(f"  partial CSV cover.:  {counts['csv-partial']}")
    print(f"  fully generated:     {counts['generated']}")
    print(f"  demographic buurten: {demographic_buurt_count}")
    print(f"  demographic slices:  {slice_count}")
    return db, demographic_db


def _flatten_slices(slices_nested: dict) -> list[dict]:
    """Convert {year: {age: {gender: metrics}}} into a flat array that's
    parser- and filter-friendly in the browser:

        [ { year, age, gender, metrics }, ... ]

    Stable order: years ascending, then AGE_GROUPS order, then GENDERS
    order — so byte-identical builds produce byte-identical files.
    """
    flat: list[dict] = []
    for year in sorted(slices_nested.keys()):
        by_age = slices_nested[year]
        for age in AGE_GROUPS:
            by_gender = by_age.get(age, {})
            for gender in GENDERS:
                metrics = by_gender.get(gender)
                if not metrics:
                    continue
                flat.append({
                    "year":    year,
                    "age":     age,
                    "gender":  gender,
                    "metrics": metrics,
                })
    return flat


def main() -> None:
    print(f"Building {OUTPUT_PATH.relative_to(REPO_ROOT)} + "
          f"{DEMOGRAPHIC_PATH.relative_to(REPO_ROOT)} …")
    db, demographic_db = build()

    OUTPUT_PATH.write_text(json.dumps(db, separators=(",", ":"), ensure_ascii=False))
    DEMOGRAPHIC_PATH.write_text(json.dumps(demographic_db, separators=(",", ":"), ensure_ascii=False))

    main_size = os.path.getsize(OUTPUT_PATH)
    demo_size = os.path.getsize(DEMOGRAPHIC_PATH)
    print(f"Wrote {OUTPUT_PATH.relative_to(REPO_ROOT)} ({main_size:,} bytes)")
    print(f"Wrote {DEMOGRAPHIC_PATH.relative_to(REPO_ROOT)} ({demo_size:,} bytes)")


if __name__ == "__main__":
    main()
