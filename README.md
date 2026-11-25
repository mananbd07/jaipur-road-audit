# SadakSatya — Jaipur Autonomous Road Audit

**Track:** Open Innovation — *Build with Web Data — Scrapingdog × TechEve, JECRC University*

[Open the live demo](https://jaipur-road-audit.mananbd07.workers.dev)

SadakSatya helps taxpayers audit whether Jaipur road-repair claims match what is actually on the road. Public tenders can allocate crores through JDA, Jaipur Nagar Nigam, and Rajasthan PWD, while citizens have no automated way to verify the result on the ground. We combine live public-web research through Scrapingdog with a Lenovo ThinkCentre edge-vision rover to surface that gap in real time.

## The two-tier audit loop

```text
┌──────────────────────── EDGE ROVER ────────────────────────┐
│ Lenovo ThinkCentre + webcam + Wi-Fi                         │
│   OpenCV CLAHE / denoise / road ROI                          │
│      ↓                                                       │
│ Indian-road YOLOv8s ONNX (onnxruntime)                      │
│   └─ OpenCV tabletop fallback when a model or Wi-Fi is absent│
│      ↓                                                       │
│ QR road-sign zone tag → Wireless HUD (:5050)                │
│      ↓                                                       │
│ Compressed JPEG + JSON multipart → offline retry queue      │
└──────────────────────────────┬─────────────────────────────┘
                               │ X-Rover-Key
                               ▼
┌────────────────── LIVE CLOUD AUDIT PLATFORM ───────────────┐
│ Cloudflare Workers + Hono + D1 + R2                         │
│   Scrapingdog 4-API sync → structured public repair claims  │
│      ↓                                                       │
│ Deterministic comparison engine                              │
│ DISCREPANCY_UNFIXED · POST_REPAIR_FAILURE                   │
│ UNREPORTED_DAMAGE · VERIFIED_CLEAR                          │
│      ↓                                                       │
│ Leaflet Jaipur Audit Map + Accountability Kit                │
│ (formal grievance draft + X intent URL)                     │
└────────────────────────────────────────────────────────────┘
```

## Scrapingdog: four APIs, one evidence trail

SadakSatya uses Scrapingdog for discovery, extraction, corroboration, and geography rather than treating search results as an audit verdict by themselves.

| Scrapingdog endpoint | Role in SadakSatya | What is retained |
| --- | --- | --- |
| `GET /google` | Discovers live Jaipur JDA, Nagar Nigam, and PWD road-repair tenders with `country=in` and `location=Jaipur`. | Candidate URLs, titles, and result context. |
| `GET /scrape` | Reads tender pages as LLM-ready Markdown and applies `ai_extract_rules` to normalize `tender_ref`, `authority`, `zone_or_road`, `budget_inr`, and `claimed_status`. | Structured public-claim fields and source URL. |
| `GET /google_news/v2` | Finds recent press reports that claim a repair is complete, including publication dates. | Claim context, source, and date for human review. |
| `GET /google_maps` | Geocodes an extracted Jaipur road or zone before it appears on the live audit map. | Latitude, longitude, and pincode. |

The sync uses bounded retries/timeouts and limits detail-page work with `max_scrape_pages` to keep credit consumption predictable. Each run records endpoint, mode, HTTP status, estimated credits, records found, duration, and timestamp in `scrape_runs`, so judges can inspect live telemetry rather than trust a black box.

## What the verdict means

The Worker matches rover evidence with public claims by road tokens, pincode, and proximity. It then applies a deterministic rule set:

- `DISCREPANCY_UNFIXED`: damage remains where a relevant repair claim exists.
- `POST_REPAIR_FAILURE`: damage remains despite a claim marked fixed.
- `UNREPORTED_DAMAGE`: damage has no corresponding public claim.
- `VERIFIED_CLEAR`: no potholes and a healthy road-condition score.

The output includes a human-readable evidence summary and an Accountability Kit: a reviewable Rajasthan Sampark / PWD Sugam Path grievance draft and an X intent URL. SadakSatya does not submit forms or publish posts automatically.

## Compliance and ethics

SadakSatya uses strictly public web data and preserves source context for review. It respects government website terms by assisting human reporting—not automating government forms, bypassing access controls, or making a final legal finding. A rover observation is evidence for inspection, not proof of corruption or contractor wrongdoing.

## AI coding tools disclosure

AI assistance was used transparently alongside human engineering:

- **Gemini** supported architecture exploration and prompt design.
- **OpenAI Codex** assisted with code generation, refactoring, documentation, and automated verification.
- **Human work** covered Lenovo ThinkCentre hardware integration, Jaipur civic-domain modeling, live test decisions, Scrapingdog API orchestration, and final review of every public-facing claim.

## Quick start

### Cloudflare Worker

```bash
npm install
copy .dev.vars.example .dev.vars       # Windows PowerShell / Command Prompt
# cp .dev.vars.example .dev.vars       # Linux/macOS
```

Add your own values to the untracked `.dev.vars` file—never commit them:

```ini
SCRAPINGDOG_API_KEY=your_scrapingdog_key
ROVER_API_KEY=your_private_rover_key
```

Then initialize the local D1 database and run the app:

```bash
npm run db:migrate:local
npm run db:seed:local
npm run dev
```

Open the local URL printed by Wrangler. The deployed demo is [jaipur-road-audit.mananbd07.workers.dev](https://jaipur-road-audit.mananbd07.workers.dev).

### Lenovo ThinkCentre rover

```bash
cd rover
python -m venv .venv
# Windows PowerShell: .\.venv\Scripts\Activate.ps1
# Linux/macOS: source .venv/bin/activate
python -m pip install -r requirements.txt
copy .env.example .env                 # use cp on Linux/macOS
python download_model.py
python generate_road_qrs.py
python rover_agent.py --source 0 --zone SITAPURA_302022 --mode auto --auto-upload
```

Set the private `ROVER_API_KEY` in local `rover/.env` before a real upload. For a no-hardware tabletop rehearsal, use `python rover_agent.py --source mock --mode tabletop --dry-run`. Open `http://THINKCENTRE-LAN-IP:5050` from the presentation laptop.

## Submission assets

- [Print-ready 8-slide pitch deck](docs/pitch-deck.html) — open in a browser, then use `Ctrl+P` → **Save as PDF**.
- [Three-minute judge demo script](docs/DEMO_SCRIPT.md)
- [ThinkCentre rover guide](rover/README_THINKCENTRE.md)
