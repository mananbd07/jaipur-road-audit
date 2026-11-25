# SadakSatya ThinkCentre Rover

This folder turns a Lenovo ThinkCentre into the edge camera for the Jaipur Road Audit demo. It is deliberately usable without a GPU and remains demoable before the trained model finishes downloading.

## 1. Install on Windows or Linux

Install Python 3.10+ and connect a USB webcam (or put the phone camera and ThinkCentre on the same Wi-Fi/hotspot). From the repository root:

```bash
cd rover
python -m venv .venv
# Windows PowerShell
.\.venv\Scripts\Activate.ps1
# Linux
# source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
copy .env.example .env                 # Windows
# cp .env.example .env                 # Linux
```

In `rover/.env`, set the real `ROVER_API_KEY` from the Worker. Keep it local; `.env` is ignored. The default endpoint is already the deployed Worker:

```ini
CLOUD_API_URL=https://jaipur-road-audit.mananbd07.workers.dev/api/ingest/detection
ROVER_ID=thinkcentre-rover-01
UPLOAD_COOLDOWN_SEC=8
```

For repository-local development only, `uploader.py` can silently read `ROVER_API_KEY` from the parent `.dev.vars` when `rover/.env` does not set one. It never prints this value.

## 2. Get the detector

The default model is ONNX Runtime CPU inference, avoiding a PyTorch install:

```bash
python download_model.py
```

This downloads `models/pothole_yolov8s.onnx` from `vinothvikas1987/pothole-detection-yolov8` (classes: longitudinal crack, transverse crack, alligator crack, pothole, other). Model files are ignored by Git. If Wi-Fi is unavailable, the program automatically uses the clearly labelled `opencv_heuristic` engine. The fallback is especially effective for dark cut-out potholes on a tabletop cardboard road.

## 3. Make tabletop road signs

```bash
python generate_road_qrs.py
```

Print the six PNG cards in `road_signs/` and tape them along the demo track. Point the camera at a card; every fifth frame the rover reads `ZONE:<ID>` and swaps its active Jaipur zone. The six zones exactly match the seeded Worker claims: Sitapura, Malviya Nagar, Mahal Road, Tonk Road, Mansarovar, and Vidyadhar Nagar.

## 4. Launch the wireless HUD

Use a webcam (index zero), an IP/phone camera URL, a dashcam file, or the no-hardware mock source:

```bash
python rover_agent.py --source 0 --zone SITAPURA_302022 --mode auto --auto-upload
python rover_agent.py --source "http://PHONE-IP:8080/video" --mode auto
python rover_agent.py --source demo-drive.mp4 --mode onnx
python rover_agent.py --source mock --mode tabletop --dry-run
```

Open `http://THINKCENTRE-LAN-IP:5050` from the presentation laptop (or `http://127.0.0.1:5050` on the ThinkCentre). On Windows, allow Python through the private-network firewall prompt. The page has a live MJPEG feed, active-zone buttons, QR-switch state, telemetry, manual capture/clear buttons, auto-upload toggle, offline queue count, and the most recent cloud verdict.

`--dry-run` blocks automatic uploads but retains the manual buttons for a deliberate presentation upload. `--auto-upload` sends scans with potholes after the configurable cooldown. Network/5xx failures write JPEG + metadata to `offline_queue/`; the daemon retries that queue every 30 seconds when Wi-Fi returns.

## Payload and safety notes

Every upload uses multipart form data: JPEG `snapshot`, JSON `metadata`, and the `X-Rover-Key` header. Metadata contains `rover_id`, `road_tag`, `pincode`, `lat`, `lng`, `pothole_count`, `severity`, `road_condition_score`, `confidence`, and detailed `telemetry`; it matches the deployed ingest contract. Keep source video footage and secrets off the project Git history.
