"""Reliable multipart uploader for the Jaipur Road Audit Worker."""
from __future__ import annotations

import json
import os
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests

try:
    from dotenv import dotenv_values
except ImportError:
    dotenv_values = None


DEFAULT_CLOUD_URL = "https://jaipur-road-audit.mananbd07.workers.dev/api/ingest/detection"
ROOT = Path(__file__).resolve().parent
QUEUE_DIR = ROOT / "offline_queue"


def _read_values(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    if dotenv_values is not None:
        return {key: value for key, value in dotenv_values(path).items() if value is not None}
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def load_config() -> dict[str, str]:
    """Read repo test credentials only when rover/.env did not override them.

    Values are deliberately never logged; callers only see request outcomes.
    """
    inherited = _read_values(ROOT.parent / ".dev.vars")
    local = _read_values(ROOT / ".env")
    config = dict(inherited)
    config.update({key: value for key, value in os.environ.items() if key in {"CLOUD_API_URL", "ROVER_API_KEY", "ROVER_ID", "UPLOAD_COOLDOWN_SEC"}})
    config.update(local)
    return {
        "cloud_api_url": config.get("CLOUD_API_URL", DEFAULT_CLOUD_URL),
        "rover_api_key": config.get("ROVER_API_KEY", ""),
        "rover_id": config.get("ROVER_ID", "thinkcentre-rover-01"),
        "upload_cooldown_sec": config.get("UPLOAD_COOLDOWN_SEC", "8"),
    }


@dataclass
class RoverUploader:
    cloud_api_url: str = DEFAULT_CLOUD_URL
    rover_api_key: str = ""
    rover_id: str = "thinkcentre-rover-01"
    upload_cooldown_sec: float = 8.0
    queue_dir: Path = QUEUE_DIR

    def __post_init__(self) -> None:
        self.last_upload_monotonic = 0.0
        self.queue_dir.mkdir(parents=True, exist_ok=True)

    @classmethod
    def from_env(cls) -> "RoverUploader":
        config = load_config()
        try:
            cooldown = max(0.0, float(config["upload_cooldown_sec"]))
        except ValueError:
            cooldown = 8.0
        return cls(config["cloud_api_url"], config["rover_api_key"], config["rover_id"], cooldown)

    def queue_count(self) -> int:
        return len(list(self.queue_dir.glob("*.json")))

    def _queue(self, jpeg_bytes: bytes, metadata: dict[str, Any], reason: str) -> str:
        self.queue_dir.mkdir(parents=True, exist_ok=True)
        key = f"{datetime.now(timezone.utc):%Y%m%dT%H%M%S%fZ}_{uuid.uuid4().hex[:8]}"
        image_path = self.queue_dir / f"{key}.jpg"
        metadata_path = self.queue_dir / f"{key}.json"
        image_path.write_bytes(jpeg_bytes)
        metadata_path.write_text(json.dumps({"metadata": metadata, "queued_reason": reason}, ensure_ascii=False, indent=2), encoding="utf-8")
        return key

    def send_detection(self, jpeg_bytes: bytes, metadata_dict: dict[str, Any], force: bool = False) -> dict[str, Any]:
        """POST a scan; queue only network failures and server-side failures."""
        elapsed = time.monotonic() - self.last_upload_monotonic
        if not force and elapsed < self.upload_cooldown_sec:
            return {"ok": False, "skipped": "cooldown", "retry_in_sec": round(self.upload_cooldown_sec - elapsed, 1)}
        metadata = dict(metadata_dict)
        metadata.setdefault("rover_id", self.rover_id)
        headers = {"X-Rover-Key": self.rover_api_key} if self.rover_api_key else {}
        try:
            response = requests.post(
                self.cloud_api_url,
                headers=headers,
                files={"snapshot": ("rover_scan.jpg", jpeg_bytes, "image/jpeg")},
                data={"metadata": json.dumps(metadata, separators=(",", ":"))},
                timeout=15,
            )
            self.last_upload_monotonic = time.monotonic()
        except requests.RequestException as error:
            queued = self._queue(jpeg_bytes, metadata, f"network error: {type(error).__name__}")
            return {"ok": False, "queued": True, "queue_id": queued, "error": "network unavailable; scan queued for retry"}
        try:
            payload: dict[str, Any] = response.json()
        except ValueError:
            payload = {"raw_response": response.text[:200]}
        if response.status_code >= 500:
            queued = self._queue(jpeg_bytes, metadata, f"HTTP {response.status_code}")
            return {"ok": False, "queued": True, "queue_id": queued, "status_code": response.status_code, "error": "cloud server error; scan queued"}
        if not response.ok:
            return {"ok": False, "status_code": response.status_code, "error": payload.get("error", "cloud request failed")}
        verdict = payload.get("verdict") or {}
        return {
            "ok": True,
            "status_code": response.status_code,
            "verdict": verdict.get("verdict"),
            "verdict_id": verdict.get("id"),
            "matched_claim": payload.get("matched_claim"),
            "budget_at_risk_inr": verdict.get("budget_at_risk_inr"),
            "snapshot_url": payload.get("snapshot_url"),
            "response": payload,
        }

    def flush_queue(self) -> dict[str, Any]:
        """Attempt queued entries in oldest-first order, retaining failed entries."""
        uploaded = 0
        errors: list[str] = []
        for metadata_path in sorted(self.queue_dir.glob("*.json")):
            image_path = metadata_path.with_suffix(".jpg")
            try:
                record = json.loads(metadata_path.read_text(encoding="utf-8"))
                jpeg_bytes = image_path.read_bytes()
                result = self.send_detection(jpeg_bytes, record["metadata"], force=True)
                if result.get("ok"):
                    metadata_path.unlink(missing_ok=True)
                    image_path.unlink(missing_ok=True)
                    uploaded += 1
                else:
                    errors.append(str(result.get("error", result.get("skipped", "retry failed"))))
                    break
            except (OSError, ValueError, KeyError) as error:
                errors.append(f"bad queued item {metadata_path.name}: {error}")
        return {"ok": not errors, "uploaded": uploaded, "remaining": self.queue_count(), "errors": errors}


_default_uploader: RoverUploader | None = None


def get_uploader() -> RoverUploader:
    global _default_uploader
    if _default_uploader is None:
        _default_uploader = RoverUploader.from_env()
    return _default_uploader


def send_detection(jpeg_bytes: bytes, metadata_dict: dict[str, Any], force: bool = False) -> dict[str, Any]:
    return get_uploader().send_detection(jpeg_bytes, metadata_dict, force)


def flush_queue() -> dict[str, Any]:
    return get_uploader().flush_queue()
