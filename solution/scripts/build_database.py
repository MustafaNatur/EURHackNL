#!/usr/bin/env python3
"""
build_database.py
-----------------
One-shot builder for `data/neighborhoods_database.json`, the single source
of truth the front-end reads at runtime.

For each of the 91 Rotterdam buurten we produce one record containing:

  - identity         : CBS buurtcode, name, parent district, category
  - source           : "csv" when the CSV had a matching neighborhood for
                       the latest year, otherwise "generated"
  - metrics          : all 18 health/loneliness percentages
                       (averaged across age & gender bins for the year)
  - publicPlaces     : counts for the 10 facility categories, scaled by
                       population with a deterministic jitter seeded by the
                       buurtcode (so re-running this script reproduces the
                       same numbers — the demo is no longer random)

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

# Aliases: GeoJSON name -> CSV name when they differ.
NAME_ALIASES = {
    "CS-Kwartier": "CS-kwartier",
}


def seeded_rng(seed_str: str) -> random.Random:
    """Deterministic RNG keyed by a string (e.g. buurtcode)."""
    h = hashlib.sha256(seed_str.encode("utf-8")).digest()
    seed = int.from_bytes(h[:8], "big", signed=False)
    return random.Random(seed)


def load_csv_aggregates(year: int) -> dict[str, dict[str, float]]:
    """
    For each neighborhood, average each metric across all age/gender bins
    of the requested year. Returns {neighborhoodName: {metricKey: value}}.
    """
    sums:   dict[str, dict[str, float]] = {}
    counts: dict[str, dict[str, int]]   = {}

    with open(CSV_PATH, newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            if row["Municipality"] != "Rotterdam":
                continue
            try:
                if int(row["Year"]) != year:
                    continue
            except ValueError:
                continue
            name = row["Neighborhood"]
            row_sums   = sums.setdefault(name, {})
            row_counts = counts.setdefault(name, {})
            for key, csv_col, _ in METRIC_SCHEMA:
                raw = row.get(csv_col)
                if raw is None or raw == "":
                    continue
                try:
                    v = float(raw)
                except ValueError:
                    continue
                row_sums[key]   = row_sums.get(key, 0.0) + v
                row_counts[key] = row_counts.get(key, 0) + 1

    out: dict[str, dict[str, float]] = {}
    for name, by_key in sums.items():
        out[name] = {
            k: round(v / counts[name][k], 1)
            for k, v in by_key.items()
            if counts[name].get(k, 0) > 0
        }
    return out


def generate_metrics(rng: random.Random) -> dict[str, float]:
    """Fallback when the CSV has no rows for this neighborhood."""
    return {
        key: round(rng.uniform(*rng_range), 1)
        for key, _, rng_range in METRIC_SCHEMA
    }


def generate_public_places(rng: random.Random, population: int) -> list[dict]:
    """Deterministic counts scaled by population."""
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


def build(year: int = 2022) -> dict:
    csv_data = load_csv_aggregates(year)
    geojson  = json.loads(GEOJSON_PATH.read_text(encoding="utf-8"))

    db = {
        "schemaVersion": 1,
        "year":          year,
        "neighborhoods": {},
    }

    matched = unmatched = 0
    for feat in geojson["features"]:
        p = feat["properties"]
        buurtcode  = p["id"]
        name       = p["name"]
        population = int(p.get("population") or 0)
        category   = p.get("category", "residential")

        csv_name = NAME_ALIASES.get(name, name)
        csv_metrics = csv_data.get(csv_name)

        rng = seeded_rng(buurtcode)

        if csv_metrics and len(csv_metrics) == len(METRIC_SCHEMA):
            metrics = csv_metrics
            source  = "csv"
            matched += 1
        else:
            # Fill in missing keys from RNG so the UI never sees blanks
            metrics = generate_metrics(rng)
            if csv_metrics:
                metrics.update(csv_metrics)
            source = "csv-partial" if csv_metrics else "generated"
            unmatched += 1

        db["neighborhoods"][buurtcode] = {
            "districtId":   buurtcode,
            "districtName": name,
            "year":         year,
            "source":       source,
            "metrics":      metrics,
            "publicPlaces": generate_public_places(rng, population),
        }

    db["stats"] = {
        "total":     matched + unmatched,
        "fromCsv":   matched,
        "generated": unmatched,
    }
    print(f"  matched (full CSV): {matched}")
    print(f"  generated/partial:  {unmatched}")
    return db


def main() -> None:
    print(f"Building {OUTPUT_PATH.relative_to(REPO_ROOT)} …")
    db = build(year=2022)
    OUTPUT_PATH.write_text(json.dumps(db, separators=(",", ":"), ensure_ascii=False))
    size = os.path.getsize(OUTPUT_PATH)
    print(f"Wrote {OUTPUT_PATH.relative_to(REPO_ROOT)} ({size:,} bytes)")


if __name__ == "__main__":
    main()
