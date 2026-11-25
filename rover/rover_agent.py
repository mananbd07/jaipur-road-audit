"""ThinkCentre rover daemon: camera/QR loop, vision pipeline, HUD, and uploader."""
from __future__ import annotations

import argparse
import json
import threading
import time
from pathlib import Path
from typing import Any, Iterator

import cv2
import numpy as np
from flask import Flask, Response, jsonify, render_template_string

from detector import PotholeDetector, annotate_frame
from preprocess import preprocess_frame
from uploader import RoverUploader


ROOT = Path(__file__).resolve().parent
PUBLIC_MAP_URL = "https://jaipur-road-audit.mananbd07.workers.dev/"


HUD_HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>SadakSatya Rover</title><style>
:root{color-scheme:dark;--bg:#0b1220;--card:#141e2f;--blue:#61b8ff;--muted:#9cafc6;--danger:#ff6b6b;--ok:#66d89b}*{box-sizing:border-box}body{margin:0;font:15px system-ui,sans-serif;background:var(--bg);color:#edf4ff}main{max-width:1300px;margin:auto;padding:20px}h1{margin:0;font-size:24px;color:var(--blue)}.sub{color:var(--muted);margin:5px 0 20px}.grid{display:grid;grid-template-columns:minmax(0,2fr) minmax(300px,1fr);gap:16px}.card{background:var(--card);border:1px solid #23334d;border-radius:12px;padding:15px}img{width:100%;display:block;border-radius:8px;background:#05080e}.metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.metric{background:#0e1726;border-radius:8px;padding:10px;color:var(--muted)}.metric b{display:block;color:#fff;font-size:18px;margin-top:3px}.zones{display:flex;flex-wrap:wrap;gap:7px}button,a.button{border:1px solid #365d83;border-radius:7px;padding:9px 10px;background:#192b42;color:#edf4ff;cursor:pointer;text-decoration:none;font:inherit}button:hover{background:#24476b}.primary{background:#075a9a;border-color:#1680d0}.danger{background:#762c3b;border-color:#b94a5a}.zone.active{outline:2px solid var(--blue)}.verdict{min-height:72px;line-height:1.5}.small{font-size:12px;color:var(--muted)}.status-ok{color:var(--ok)}.status-bad{color:var(--danger)}@media(max-width:850px){.grid{grid-template-columns:1fr}}
</style></head><body><main>
<h1>SADAKSATYA · ThinkCentre Edge Rover</h1><div class="sub">Wireless audit console · <span id="connection">connecting…</span></div>
<div class="grid"><section class="card"><img src="/video_feed" alt="Live rover feed"><p class="small">Preprocessed road ROI with live edge annotations.</p></section>
<aside class="card"><h3 style="margin-top:0">Live Edge Telemetry</h3><div class="metrics" id="metrics"></div><h3>Jaipur Audit Zone <span class="small" id="qr"></span></h3><div class="zones" id="zones"></div><h3>Audit actions</h3><div class="zones"><button class="primary" onclick="post('/capture')">Capture & Upload to Live Audit Now</button><button onclick="post('/capture-clear')">Log Verified Clear Road</button><button id="auto" onclick="post('/toggle-auto')">Toggle Auto Upload</button></div><h3>Latest Cloud Verdict</h3><div class="verdict" id="verdict">No upload yet.</div><a class="button" target="_blank" href="{{ map_url }}">Open live public map ↗</a></aside></div>
</main><script>
const zoneData={{ zones|tojson }};const metricNames=[['fps','FPS'],['pothole_count','Potholes'],['crack_count','Cracks'],['road_condition_score','Road score'],['severity','Severity'],['detector_engine','Engine'],['offline_queue','Offline queue'],['lighting_score','Lighting'],['blur_score','Blur']];
async function post(path){const r=await fetch(path,{method:'POST'});const j=await r.json();if(!j.ok)alert(j.error||j.skipped||'Action did not complete');refresh()}
function zones(s){const node=document.getElementById('zones');node.innerHTML='';zoneData.forEach(z=>{const b=document.createElement('button');b.className='zone '+(z.id===s.active_zone?'active':'');b.textContent=z.id;b.onclick=()=>post('/set-zone/'+encodeURIComponent(z.id));node.appendChild(b)})}
function money(n){return typeof n==='number'?'₹'+(n/10000000).toFixed(2)+' Cr':'—'}
async function refresh(){try{const s=await (await fetch('/status')).json();document.getElementById('connection').textContent='live · '+s.rover_id;document.getElementById('connection').className='status-ok';const m=document.getElementById('metrics');m.innerHTML='';metricNames.forEach(([key,label])=>{const d=document.createElement('div');d.className='metric';d.innerHTML=label+'<b>'+((s[key]??'—'))+'</b>';m.appendChild(d)});document.getElementById('qr').textContent=s.qr_auto_switch?'QR auto-switch active':'manual zone';document.getElementById('auto').textContent='Auto Upload: '+(s.auto_upload?'ON':'OFF');zones(s);const v=s.latest_cloud_verdict;if(v){document.getElementById('verdict').innerHTML='<b>'+ (v.verdict||'UPLOADED')+'</b><br>'+money(v.budget_at_risk_inr)+(v.matched_claim?.tender_ref?' · '+v.matched_claim.tender_ref:'')+(v.snapshot_url?'<br><a target="_blank" href="'+v.snapshot_url+'">Open snapshot</a>':'')} }catch(e){document.getElementById('connection').textContent='HUD retrying…';document.getElementById('connection').className='status-bad'}}refresh();setInterval(refresh,1000);
</script></body></html>"""


def load_zones() -> dict[str, dict[str, Any]]:
    zones = json.loads((ROOT / "zones_jaipur.json").read_text(encoding="utf-8"))
    return {zone["id"]: zone for zone in zones}


def mock_road_frame(tick: int) -> np.ndarray:
    """A deterministic synthetic roadway with dark potholes for smoke tests."""
    height, width = 720, 1280
    image = np.full((height, width, 3), (84, 90, 93), dtype=np.uint8)
    image[:105] = (146, 124, 93)
    noise = np.random.default_rng(tick // 6).normal(0, 5, (height, width, 1)).astype(np.int16)
    image = np.clip(image.astype(np.int16) + noise, 0, 255).astype(np.uint8)
    cv2.line(image, (width // 2, 120), (width // 2, height), (191, 188, 168), 8)
    cv2.line(image, (0, 110), (width, 110), (235, 219, 177), 3)
    phase = tick % 160
    cv2.ellipse(image, (335 + phase, 420), (65, 32), 18, 0, 360, (18, 18, 18), -1)
    cv2.ellipse(image, (900 - phase // 3, 580), (92, 52), -11, 0, 360, (22, 22, 22), -1)
    cv2.ellipse(image, (920 - phase // 3, 580), (66, 30), -11, 0, 360, (7, 7, 7), -1)
    return image


class RoverState:
    def __init__(self, zones: dict[str, dict[str, Any]], initial_zone: str, detector: PotholeDetector, uploader: RoverUploader, auto_upload: bool, dry_run: bool):
        self.zones = zones
        self.active_zone_id = initial_zone if initial_zone in zones else next(iter(zones))
        self.detector = detector
        self.uploader = uploader
        self.auto_upload = auto_upload
        self.dry_run = dry_run
        self.lock = threading.RLock()
        self.latest_jpeg: bytes | None = None
        self.latest_metrics: dict[str, Any] = {"fps": 0.0, "pothole_count": 0, "crack_count": 0, "road_condition_score": 100, "severity": "none", "detector_engine": detector.engine, "lighting_score": 0.0, "blur_score": 0.0}
        self.latest_cloud_verdict: dict[str, Any] | None = None
        self.qr_auto_switch = False
        self.running = True

    def zone(self) -> dict[str, Any]:
        with self.lock:
            return dict(self.zones[self.active_zone_id])

    def set_zone(self, zone_id: str, qr: bool = False) -> bool:
        with self.lock:
            if zone_id not in self.zones:
                return False
            self.active_zone_id = zone_id
            self.qr_auto_switch = qr
            return True

    def status(self) -> dict[str, Any]:
        with self.lock:
            status = dict(self.latest_metrics)
            status.update({"active_zone": self.active_zone_id, "rover_id": self.uploader.rover_id, "auto_upload": self.auto_upload, "dry_run": self.dry_run, "qr_auto_switch": self.qr_auto_switch, "offline_queue": self.uploader.queue_count(), "latest_cloud_verdict": self.latest_cloud_verdict})
            return status

    def metadata(self, clear: bool = False) -> dict[str, Any]:
        with self.lock:
            zone = dict(self.zones[self.active_zone_id])
            metrics = dict(self.latest_metrics)
        if clear:
            metrics.update({"pothole_count": 0, "crack_count": 0, "road_condition_score": 100, "severity": "none", "confidence": 0.0})
        return {
            "rover_id": self.uploader.rover_id,
            "road_tag": zone["road_tag"],
            "pincode": zone["pincode"],
            "lat": zone["lat"],
            "lng": zone["lng"],
            "pothole_count": int(metrics.get("pothole_count", 0)),
            "severity": metrics.get("severity", "none"),
            "road_condition_score": int(metrics.get("road_condition_score", 100)),
            "confidence": float(metrics.get("confidence", 0.0)),
            "telemetry": {key: metrics.get(key) for key in ("fps", "crack_count", "detector_engine", "lighting_score", "blur_score", "pothole_area_ratio", "engine_note") if key in metrics},
        }

    def upload_current(self, clear: bool = False, force: bool = True) -> dict[str, Any]:
        with self.lock:
            jpeg = self.latest_jpeg
        if not jpeg:
            return {"ok": False, "error": "camera frame is not ready"}
        result = self.uploader.send_detection(jpeg, self.metadata(clear=clear), force=force)
        with self.lock:
            if result.get("ok"):
                snapshot_url = result.get("snapshot_url")
                if isinstance(snapshot_url, str) and snapshot_url.startswith("/"):
                    snapshot_url = self.uploader.cloud_api_url.split("/api/", 1)[0] + snapshot_url
                self.latest_cloud_verdict = {key: result.get(key) for key in ("verdict", "verdict_id", "matched_claim", "budget_at_risk_inr")}
                self.latest_cloud_verdict["snapshot_url"] = snapshot_url
        return result


class CaptureWorker(threading.Thread):
    def __init__(self, state: RoverState, source: str):
        super().__init__(name="rover-capture", daemon=True)
        self.state = state
        self.source = source
        self.cap: cv2.VideoCapture | None = None
        self.qr_detector = cv2.QRCodeDetector()

    def _open_capture(self) -> None:
        if self.source == "mock":
            return
        parsed: int | str = int(self.source) if self.source.isdigit() else self.source
        self.cap = cv2.VideoCapture(parsed)
        if not self.cap.isOpened():
            raise RuntimeError(f"Could not open camera/video source {self.source!r}; use --source mock to test without hardware.")

    def run(self) -> None:
        try:
            self._open_capture()
            frame_index, started, last_flush = 0, time.monotonic(), 0.0
            while self.state.running:
                if self.source == "mock":
                    frame = mock_road_frame(frame_index)
                    time.sleep(0.055)
                else:
                    assert self.cap is not None
                    ok, frame = self.cap.read()
                    if not ok:
                        if isinstance(self.source, str) and self.source.lower().endswith((".mp4", ".avi", ".mov", ".mkv")):
                            self.cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                            continue
                        time.sleep(0.1)
                        continue
                frame_index += 1
                if frame_index % 5 == 0:
                    try:
                        code, _, _ = self.qr_detector.detectAndDecode(frame)
                        if code.startswith("ZONE:"):
                            self.state.set_zone(code.split(":", 1)[1].strip(), qr=True)
                    except cv2.error:
                        pass
                preprocessed = preprocess_frame(frame)
                result = self.state.detector.detect(preprocessed)
                elapsed = max(0.001, time.monotonic() - started)
                result.update({"fps": round(frame_index / elapsed, 1), "lighting_score": preprocessed["lighting_score"], "blur_score": preprocessed["blur_score"]})
                jpeg = annotate_frame(preprocessed["processed_frame"], result["detections"], self.state.zone(), result)
                with self.state.lock:
                    self.state.latest_jpeg = jpeg
                    self.state.latest_metrics = result
                    auto_upload = self.state.auto_upload
                    dry_run = self.state.dry_run
                if auto_upload and not dry_run and result["pothole_count"] > 0:
                    self.state.upload_current(force=False)
                now = time.monotonic()
                if now - last_flush >= 30:
                    last_flush = now
                    self.state.uploader.flush_queue()
        except Exception as error:
            with self.state.lock:
                self.state.latest_metrics["capture_error"] = str(error)
        finally:
            if self.cap is not None:
                self.cap.release()


def create_app(state: RoverState) -> Flask:
    app = Flask(__name__)

    @app.get("/")
    def index() -> str:
        return render_template_string(HUD_HTML, zones=list(state.zones.values()), map_url=PUBLIC_MAP_URL)

    @app.get("/status")
    def status() -> Response:
        return jsonify(state.status())

    @app.get("/video_feed")
    def video_feed() -> Response:
        def stream() -> Iterator[bytes]:
            while state.running:
                with state.lock:
                    jpeg = state.latest_jpeg
                if jpeg:
                    yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + jpeg + b"\r\n"
                time.sleep(0.09)
        return Response(stream(), mimetype="multipart/x-mixed-replace; boundary=frame")

    @app.post("/set-zone/<zone_id>")
    @app.post("/zone/<zone_id>")  # Backwards-compatible alias for early demo bookmarks.
    def set_zone(zone_id: str) -> Response:
        if not state.set_zone(zone_id):
            return jsonify({"ok": False, "error": "unknown Jaipur zone"}), 404
        return jsonify({"ok": True, "active_zone": zone_id})

    @app.post("/capture")
    def capture() -> Response:
        # A deliberate button press is allowed even in --dry-run mode.
        return jsonify(state.upload_current(clear=False, force=True))

    @app.post("/capture-clear")
    def capture_clear() -> Response:
        return jsonify(state.upload_current(clear=True, force=True))

    @app.post("/toggle-auto")
    def toggle_auto() -> Response:
        with state.lock:
            state.auto_upload = not state.auto_upload
            enabled = state.auto_upload
        return jsonify({"ok": True, "auto_upload": enabled})

    return app


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", default="0", help="webcam index, RTSP/HTTP URL, video path, or mock")
    parser.add_argument("--zone", default="SITAPURA_302022", help="initial zone ID")
    parser.add_argument("--mode", choices=("auto", "onnx", "tabletop"), default="auto")
    parser.add_argument("--conf", type=float, default=0.30)
    parser.add_argument("--iou", type=float, default=0.45)
    parser.add_argument("--port", type=int, default=5050)
    parser.add_argument("--dry-run", action="store_true", help="do not auto-upload; manual capture remains available")
    parser.add_argument("--auto-upload", action="store_true", help="upload detections after cooldown")
    args = parser.parse_args()
    zones = load_zones()
    detector = PotholeDetector(mode=args.mode, conf=args.conf, iou=args.iou)
    state = RoverState(zones, args.zone, detector, RoverUploader.from_env(), args.auto_upload, args.dry_run)
    worker = CaptureWorker(state, args.source)
    worker.start()
    print(f"SadakSatya Rover HUD: http://0.0.0.0:{args.port} (engine: {detector.engine})")
    try:
        create_app(state).run(host="0.0.0.0", port=args.port, threaded=True, use_reloader=False)
    except KeyboardInterrupt:
        pass
    finally:
        state.running = False
        worker.join(timeout=2)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
