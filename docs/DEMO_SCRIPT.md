# SadakSatya: three-minute judge demo

## 0:00–1:00 — Member 1: the problem and rover

“Jaipur taxpayers fund road-repair packages worth crores, but a tender status cannot tell us whether a pothole has really been fixed. SadakSatya turns that missing last mile into an audit loop.

This is our Lenovo ThinkCentre edge rover. Its webcam sees the tabletop road, OpenCV normalizes difficult lighting with CLAHE, and our Indian-road YOLOv8 ONNX model identifies potholes. If the model or network is unavailable, a clearly labelled OpenCV tabletop detector still keeps the demo operational.

Each printed QR road sign is a Jaipur zone. I’ll show the Sitapura sign; the rover switches its active zone automatically. The wireless HUD on my laptop shows FPS, pothole count, road score, detector engine, and its offline queue. The rover compresses the annotated frame and sends it with GPS-style zone metadata to the audit platform.”

## 1:00–2:00 — Member 2: live web-data pipeline and map

“Now we move from a camera observation to public evidence. SadakSatya uses four Scrapingdog APIs: `/google` discovers Jaipur road-repair tenders; `/scrape` converts source pages into LLM-ready Markdown and extracts structured tender fields; `/google_news/v2` corroborates recent repair claims; and `/google_maps` positions the road on our map.

We cap detail-page work with `max_scrape_pages`, record estimated credits, retries, timings, and results in `scrape_runs`, and show live or fallback mode transparently. Here is the live Jaipur audit map: claims, rover detections, and outcomes are visible together rather than in separate systems.

For this Sitapura example, the public claim is JDA-SITAPURA-2025-144, ₹1.47 Cr. The point is not to accuse anyone automatically—it is to give a reviewer a precise, source-backed reason to inspect.”

## 2:00–3:00 — Member 3: verdict, ethics, and scale

“When a rover scan arrives, our deterministic comparison engine matches it by road name, pincode, and proximity. It produces one of four explainable outcomes: `DISCREPANCY_UNFIXED`, `POST_REPAIR_FAILURE`, `UNREPORTED_DAMAGE`, or `VERIFIED_CLEAR`.

The platform then creates a one-click Accountability Kit: a formal grievance draft for Rajasthan Sampark or PWD Sugam Path and an X intent link. These remain human-reviewed; we do not automate government forms or social posts.

The immediate impact is a transparent demo of physical verification. The next step is scale: ThinkCentre edge kits mounted on Jaipur Nagar Nigam garbage trucks and JCTSL buses could create daily, city-wide road observations. We used Gemini for architecture and prompt design and OpenAI Codex for code, documentation, and testing—with human ownership of hardware, civic modeling, API orchestration, and final review. Thank you; please scan or open the live URL and try the audit map.”

## If venue Wi-Fi drops

1. Start the rover with `--source mock --mode tabletop --dry-run`; the local HUD at port 5050 still shows the full camera, QR-zone, telemetry, and detection experience.
2. Use the seeded Jaipur claims and the deck’s recorded flow to explain the deterministic verdicts.
3. Explain that failed uploads are stored as JPEG + JSON in the local offline queue and replay automatically when Wi-Fi returns.
4. Do not fabricate a live cloud verdict. Clearly label the demonstration as offline mode and show the queue count.
