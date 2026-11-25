"""Download the compact Indian-road YOLOv8 model without pulling PyTorch.

The ONNX model is the ThinkCentre default and is normally about 45 MB. The
optional PT download is supplied for teams that deliberately install Ultralytics.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import requests


REPOSITORY = "vinothvikas1987/pothole-detection-yolov8"
BASE_URL = "https://huggingface.co/{repo}/resolve/main/{filename}?download=true"


def download(url: str, destination: Path, timeout: int) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_suffix(destination.suffix + ".part")
    try:
        with requests.get(url, stream=True, timeout=(10, timeout), headers={"User-Agent": "sadaksatya-rover/1.0"}) as response:
            response.raise_for_status()
            total = int(response.headers.get("content-length", 0))
            received = 0
            print(f"Downloading {destination.name}" + (f" ({total / 1024 / 1024:.1f} MB)" if total else ""))
            with partial.open("wb") as handle:
                for chunk in response.iter_content(chunk_size=1024 * 256):
                    if not chunk:
                        continue
                    handle.write(chunk)
                    received += len(chunk)
                    if total:
                        print(f"\r  {received / total:6.1%}  {received / 1024 / 1024:5.1f} MB", end="", flush=True)
        if total and received != total:
            raise RuntimeError(f"download was incomplete ({received} of {total} bytes)")
        if received < 1024:
            raise RuntimeError("downloaded file is unexpectedly small")
        partial.replace(destination)
        print(f"\nSaved {destination} ({received / 1024 / 1024:.1f} MB)")
    except (requests.RequestException, OSError, RuntimeError) as error:
        partial.unlink(missing_ok=True)
        raise RuntimeError(
            f"Could not download the model: {error}. Check Wi-Fi or download it manually from "
            f"https://huggingface.co/{REPOSITORY} into {destination}."
        ) from error


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--format", choices=("onnx", "pt"), default="onnx", help="onnx is the fast CPU default")
    parser.add_argument("--force", action="store_true", help="replace an existing model")
    parser.add_argument("--timeout", type=int, default=60, help="per-request read timeout in seconds")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    filename = "best.onnx" if args.format == "onnx" else "best.pt"
    destination = root / "models" / ("pothole_yolov8s.onnx" if args.format == "onnx" else "pothole_yolov8s.pt")
    if destination.exists() and not args.force:
        print(f"Model already exists: {destination}. Use --force to replace it.")
        return 0
    try:
        download(BASE_URL.format(repo=REPOSITORY, filename=filename), destination, max(10, args.timeout))
    except RuntimeError as error:
        print(error, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
