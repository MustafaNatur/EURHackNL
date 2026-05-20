# Rotterdam Loneliness Atlas: Connecting Data to Trusted Hands

> **Buildathon EU 2026 · BCG X & BCG Platinion — AI for Business Track**

An AI-assisted interactive dashboard that visualizes public health and loneliness data across Rotterdam's 91 neighborhoods. It bridges the gap between empty community programs and isolated residents by generating targeted, culturally sensitive intervention recommendations — routed exclusively through trusted community partners, without ever processing personal data or labeling individuals.

---

## The Problem

In Rotterdam, ~59% of residents report feeling lonely and 13–14% experience severe loneliness — figures that have not meaningfully improved despite years of municipal investment. The core issue is not awareness: it's that outreach is broadcast-style, stigma-loaded, and disconnected from individual context. Programs fill with self-selecting participants while the most isolated remain isolated, and no one can prove whether any of it is working.

## Our Solution

The Rotterdam Loneliness Atlas is a **matchmaking and routing layer** that sits between existing public programs and residents who would benefit from them, operated by human intermediaries.

It does three things:
1. **Maps the need** — visualizes CBS Gezondheidsmonitor loneliness and wellbeing metrics at neighborhood level across time (2018–2026)
2. **Identifies opportunities** — AI generates ranked, context-aware intervention recommendations per neighborhood: events, outreach campaigns, infrastructure improvements, and policy actions
3. **Routes through trust** — every recommendation is addressed to a community partner (library, sports club, mosque, social worker), never directly to a resident

## Key Features

- **Interactive neighborhood map** — 91 Rotterdam buurten color-coded by loneliness severity or category; click any neighborhood to inspect 18 health and social metrics
- **AI recommendations engine** — generates tailored events, outreach channel mixes, place-build suggestions, and policy proposals based on each neighborhood's actual metric profile
- **Analytics dashboard** — compare KPIs across buurten, filter by demographic segment, radar chart benchmarking
- **Event management** — browse proposed and past interventions, log marketing reach, receive AI-generated effectiveness evaluation
- **Audience-first planning** — start from a population segment (e.g. seniors 65+, young adults 18–24) and get cross-neighborhood action plans
- **Timeline view** — explore how loneliness indicators evolved from 2018 to present

## Privacy & Ethics by Design

- No individual is ever labeled, scored, or identified as lonely
- All AI processing is at the neighborhood / demographic-segment level — no personal identifiers enter the pipeline
- Every outreach action is reviewed and sent by a human community partner, never the system
- No data about non-responses is retained — declining an invitation leaves no record
- Fully GDPR-compatible; expected AI Act classification: **limited risk**

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla ES Modules — no build toolchain, no framework |
| Map rendering | [MapLibre GL JS](https://maplibre.org/) 4.7.1 (free, open-source) |
| Map tiles | CARTO Positron — no API key required |
| Charts | Chart.js 4.4.3 |
| Data pipeline | Python 3 (`scripts/build_database.py`) |
| Hosting | Static files — runs directly from `solution/index.html` |

## Data Sources

- **CBS Gezondheidsmonitor** — 2018–2022 historical survey data; values for 2023–2026 are algorithmically extrapolated from observed trends for demonstration purposes; 10,450 rows across 91 Rotterdam buurten
- **Rotterdam neighborhood GeoJSON** — official CBS buurt boundaries

## Getting Started

No installation required.

```bash
# Option 1 — open directly in browser
open solution/index.html

# Option 2 — serve locally (avoids CORS on some browsers)
cd solution
python3 -m http.server 8080
# then open http://localhost:8080
```

To rebuild the neighborhood database from the source CSV:

```bash
cd solution
python3 scripts/build_database.py
```

## Project Structure

```
solution/
├── index.html
├── css/styles.css
├── js/
│   ├── app.js                  # Composition root
│   ├── config.js               # AppConfig (map center, paths, timing)
│   ├── map/MapController.js
│   ├── models/                 # DistrictData, RecommendationData, ...
│   ├── services/               # DataService, AIService, GeoService
│   └── ui/                     # SidebarController, AnalyticsDashboard, ...
├── data/
│   ├── rotterdam_neighborhoods.geojson
│   ├── rotterdam_boundary.geojson
│   ├── neighborhoods_database.json   # pre-built; regenerate with build_database.py
│   └── neighborhoods_demographic.json
└── scripts/
    └── build_database.py
```

## Business Impact

If deployed at pilot scale (3 municipalities, ~9 neighborhoods, ~30–50k residents):

| Metric | Target |
|---|---|
| Residents receiving AI-assisted invitations | 2,000+ in 18 months |
| First-time attendance conversion | ≥ 25% |
| Cost per sustained connection | < €150 (vs. €400–800 via traditional social work) |
| Outreach time saved per worker | ~30% vs. current broadcast model |

## Team

Built at Buildathon EU 2026 in Rotterdam.
