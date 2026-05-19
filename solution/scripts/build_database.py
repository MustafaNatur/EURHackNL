#!/usr/bin/env python3
"""
build_database.py
-----------------
One-shot builder for `data/neighborhoods_database.json`, the single source
of truth the front-end reads at runtime.

For each of the 91 Rotterdam buurten we produce one record containing:

  - identity         : CBS buurtcode, name, parent district, category
  - source           : "csv" when every year has full CSV coverage,
                       "csv-partial" when only some years matched,
                       "generated" when the CSV had no entry at all
  - metricsByYear    : { "2018": {...}, "2019": {...}, ..., "2022": {...} }
                       all 18 health/loneliness percentages, averaged across
                       age & gender bins. Missing years/keys are deterministically
                       generated so the front-end never sees blanks.
  - publicPlaces     : year-independent counts for the 10 facility categories,
                       scaled by population with a deterministic jitter seeded
                       by the buurtcode (matches the previous behaviour).
  - outreachChannels : year-independent inventory of the 13 outreach channels
                       (ad banners, bus-shelter posters, mailbox flyer drops,
                       GP-clinic posters, …) the municipality can use to reach
                       residents in this buurt. Same scaling/jitter recipe.

Schema v2 adds top-level `years` and `defaultYear` so the timeline UI knows
which range of years to expose.

Run from the repo root:

    python3 solution/scripts/build_database.py
"""
from __future__ import annotations

import csv
import hashlib
import json
import os
import random
from pathlib import Path


REPO_ROOT      = Path(__file__).resolve().parent.parent
DATA_DIR       = REPO_ROOT / "data"
CSV_PATH       = DATA_DIR / "rotterdam_neighborhood_health_2018_2022.csv"
GEOJSON_PATH   = DATA_DIR / "rotterdam_neighborhoods.geojson"
OUTPUT_PATH    = DATA_DIR / "neighborhoods_database.json"

SCHEMA_VERSION = 2
# The CSV survey covers 2018–2022; the later years (2023–2026) are
# deterministically generated per-buurt via `generate_year_metrics`.
# A buurt that matched the CSV will therefore be marked "csv-partial"
# (5 years from CSV + 4 generated), which is accurate.
YEARS          = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]
DEFAULT_YEAR   = 2026

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
# (key, density per 1,000 residents).
# Densities >> 1 represent reach (e.g. mailbox flyer drop = ~one per
# household). Densities < 1 represent physical slots (poster panels,
# bulletin boards, outreach worker visits/week, etc.).
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


def seeded_rng(*parts) -> random.Random:
    """Deterministic RNG keyed by an arbitrary tuple of strings/ints."""
    h = hashlib.sha256("|".join(str(p) for p in parts).encode("utf-8")).digest()
    seed = int.from_bytes(h[:8], "big", signed=False)
    return random.Random(seed)


def load_csv_aggregates_by_year(years: list[int]) -> dict[str, dict[int, dict[str, float]]]:
    """
    For each neighborhood and year, average each metric across all age/gender
    bins. Returns {neighborhoodName: {year: {metricKey: value}}}.
    """
    sums:   dict[str, dict[int, dict[str, float]]] = {}
    counts: dict[str, dict[int, dict[str, int]]]   = {}
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

            name = row["Neighborhood"]
            year_sums   = sums.setdefault(name, {}).setdefault(year, {})
            year_counts = counts.setdefault(name, {}).setdefault(year, {})
            for key, csv_col, _ in METRIC_SCHEMA:
                raw = row.get(csv_col)
                if raw is None or raw == "":
                    continue
                try:
                    v = float(raw)
                except ValueError:
                    continue
                year_sums[key]   = year_sums.get(key, 0.0) + v
                year_counts[key] = year_counts.get(key, 0) + 1

    out: dict[str, dict[int, dict[str, float]]] = {}
    for name, by_year in sums.items():
        out[name] = {}
        for year, by_key in by_year.items():
            out[name][year] = {
                k: round(v / counts[name][year][k], 1)
                for k, v in by_key.items()
                if counts[name][year].get(k, 0) > 0
            }
    return out


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
    Deterministic per-year metrics that drift around the per-buurt base.
    Drift is at most +/-2.5% of the metric's plausible range — visible on
    the timeline but never out-of-band.
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


def generate_public_places(rng: random.Random, population: int) -> list[dict]:
    """Deterministic counts scaled by population. Year-independent."""
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
    """
    Per-buurt outreach channel inventory.

    Same scaling pattern as `generate_public_places`: expected = density *
    population/1000, multiplied by a per-channel deterministic jitter in
    [0.65, 1.35]. Very-high-density channels (mailbox flyer drop, local
    press inserts) end up as integer "reach" counts, which the UI happily
    formats compactly (e.g. "12.3k flyers").

    Sparsely populated buurten (population < 100) get hard caps so the
    inventory doesn't claim something silly like "school newsletters: 4"
    in an industrial zone.
    """
    per_1000 = max(1, population) / 1000.0
    out: list[dict] = []
    for key, density in OUTREACH_SCHEMA:
        expected = density * per_1000
        jitter   = 0.65 + rng.random() * 0.70  # 0.65 .. 1.35
        count    = round(expected * jitter)
        if population < 100:
            count = min(count, 1)
        out.append({"key": key, "count": max(0, count)})
    return out


def build_metrics_by_year(
    buurtcode: str,
    csv_by_year: dict[int, dict[str, float]] | None,
) -> tuple[dict[str, dict[str, float]], str]:
    """
    Produce the full {year: {metricKey: value}} map plus a source tag.

    Strategy: derive a per-buurt baseline once, then for each requested year
    fall back to CSV values when present (full row, no holes) — otherwise
    use deterministic drift from the baseline. Each year's record is
    guaranteed to have every key from METRIC_SCHEMA.
    """
    base_rng = seeded_rng(buurtcode, "base")
    base = base_metrics(base_rng)

    if csv_by_year:
        # Anchor the baseline on the latest CSV year so generated fill-ins
        # match the documented data when both coexist for one buurt.
        latest = max(csv_by_year.keys())
        latest_metrics = csv_by_year[latest]
        for k, v in latest_metrics.items():
            base[k] = v

    matched_full = 0
    matched_partial = 0
    metrics_by_year: dict[str, dict[str, float]] = {}

    for year in YEARS:
        csv_year = csv_by_year.get(year) if csv_by_year else None
        generated = generate_year_metrics(buurtcode, year, base)
        if csv_year:
            merged = dict(generated)
            merged.update(csv_year)
            if len(csv_year) == len(METRIC_SCHEMA):
                matched_full += 1
            else:
                matched_partial += 1
            metrics_by_year[str(year)] = merged
        else:
            metrics_by_year[str(year)] = generated

    if matched_full == len(YEARS):
        source = "csv"
    elif matched_full + matched_partial > 0:
        source = "csv-partial"
    else:
        source = "generated"
    return metrics_by_year, source


def build() -> dict:
    csv_data = load_csv_aggregates_by_year(YEARS)
    geojson  = json.loads(GEOJSON_PATH.read_text(encoding="utf-8"))

    db: dict = {
        "schemaVersion": SCHEMA_VERSION,
        "years":         YEARS,
        "defaultYear":   DEFAULT_YEAR,
        "neighborhoods": {},
    }

    counts = {"csv": 0, "csv-partial": 0, "generated": 0}
    for feat in geojson["features"]:
        p = feat["properties"]
        buurtcode  = p["id"]
        name       = p["name"]
        population = int(p.get("population") or 0)

        csv_name = NAME_ALIASES.get(name, name)
        csv_by_year = csv_data.get(csv_name)

        metrics_by_year, source = build_metrics_by_year(buurtcode, csv_by_year)
        counts[source] = counts.get(source, 0) + 1

        place_rng    = seeded_rng(buurtcode, "places")
        outreach_rng = seeded_rng(buurtcode, "outreach")

        db["neighborhoods"][buurtcode] = {
            "districtId":      buurtcode,
            "districtName":    name,
            "source":          source,
            "metricsByYear":   metrics_by_year,
            "publicPlaces":    generate_public_places(place_rng, population),
            "outreachChannels": generate_outreach_channels(outreach_rng, population),
        }

    db["stats"] = {
        "total":       sum(counts.values()),
        "fromCsv":     counts["csv"],
        "csvPartial":  counts["csv-partial"],
        "generated":   counts["generated"],
    }
    print(f"  full CSV coverage:  {counts['csv']}")
    print(f"  partial CSV cover.: {counts['csv-partial']}")
    print(f"  fully generated:    {counts['generated']}")
    return db


def main() -> None:
    print(f"Building {OUTPUT_PATH.relative_to(REPO_ROOT)} …")
    db = build()
    OUTPUT_PATH.write_text(json.dumps(db, separators=(",", ":"), ensure_ascii=False))
    size = os.path.getsize(OUTPUT_PATH)
    print(f"Wrote {OUTPUT_PATH.relative_to(REPO_ROOT)} ({size:,} bytes)")


if __name__ == "__main__":
    main()
