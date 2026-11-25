"""Generate six print-ready QR road signs for the tabletop audit track."""
from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np


ROOT = Path(__file__).resolve().parent


def _qr_image(value: str) -> np.ndarray:
    try:
        import qrcode

        qr = qrcode.QRCode(version=None, error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=10, border=4)
        qr.add_data(value)
        qr.make(fit=True)
        return np.array(qr.make_image(fill_color="black", back_color="white").convert("RGB"))[:, :, ::-1]
    except ImportError:
        # OpenCV's encoder keeps the script useful even if qrcode was omitted.
        encoder = cv2.QRCodeEncoder_create()
        matrix = encoder.encode(value)
        bordered = cv2.copyMakeBorder(matrix, 4, 4, 4, 4, cv2.BORDER_CONSTANT, value=255)
        return cv2.resize(bordered, (360, 360), interpolation=cv2.INTER_NEAREST)


def _make_sign(zone: dict[str, object]) -> np.ndarray:
    qr = _qr_image(str(zone["qr"]))
    qr = cv2.resize(qr, (330, 330), interpolation=cv2.INTER_NEAREST)
    canvas = np.full((485, 430, 3), 255, dtype=np.uint8)
    cv2.rectangle(canvas, (0, 0), (429, 62), (21, 34, 52), -1)
    cv2.putText(canvas, "SADAKSATYA ROVER", (39, 29), cv2.FONT_HERSHEY_SIMPLEX, 0.68, (255, 255, 255), 2, cv2.LINE_AA)
    cv2.putText(canvas, "SCAN TO SWITCH AUDIT ZONE", (48, 52), cv2.FONT_HERSHEY_SIMPLEX, 0.37, (170, 220, 255), 1, cv2.LINE_AA)
    canvas[72:402, 50:380] = qr
    cv2.putText(canvas, str(zone["id"]), (20, 430), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (20, 29, 42), 2, cv2.LINE_AA)
    cv2.putText(canvas, str(zone["pincode"]), (20, 462), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (74, 87, 101), 1, cv2.LINE_AA)
    return canvas


def main() -> int:
    zones = json.loads((ROOT / "zones_jaipur.json").read_text(encoding="utf-8"))
    output = ROOT / "road_signs"
    output.mkdir(exist_ok=True)
    for zone in zones:
        destination = output / f"{zone['id']}.png"
        if not cv2.imwrite(str(destination), _make_sign(zone)):
            raise RuntimeError(f"could not write {destination}")
        print(destination)
    print(f"Generated {len(zones)} printable signs in {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
