"""YOLOv8 ONNX pothole detector with a transparent tabletop OpenCV fallback."""
from __future__ import annotations

from pathlib import Path
from typing import Any

import cv2
import numpy as np

try:
    import onnxruntime as ort
except ImportError:  # The tabletop fallback intentionally works without ONNX Runtime.
    ort = None


CLASS_NAMES = {
    0: "Longitudinal Crack",
    1: "Transverse Crack",
    2: "Alligator Crack",
    3: "Pothole",
    4: "Other",
}
POTHOLE_CLASS = 3
CRACK_CLASSES = {0, 1, 2}


def _nms_by_class(boxes: list[list[int]], scores: list[float], class_ids: list[int], iou: float) -> list[int]:
    kept: list[int] = []
    for class_id in sorted(set(class_ids)):
        candidates = [index for index, item in enumerate(class_ids) if item == class_id]
        selected = cv2.dnn.NMSBoxes([boxes[index] for index in candidates], [scores[index] for index in candidates], 0.0, iou)
        for local_index in np.array(selected).reshape(-1) if len(selected) else []:
            kept.append(candidates[int(local_index)])
    return kept


class PotholeDetector:
    """Select ONNX when the model is available; otherwise use the local heuristic."""

    def __init__(self, model_path: str | Path | None = None, mode: str = "auto", conf: float = 0.30, iou: float = 0.45):
        self.model_path = Path(model_path or Path(__file__).with_name("models") / "pothole_yolov8s.onnx")
        self.mode = mode
        self.conf = float(conf)
        self.iou = float(iou)
        self.session: Any | None = None
        self.input_name: str | None = None
        self.ultralytics_model: Any | None = None
        self.load_error: str | None = None
        if mode != "tabletop" and self.model_path.exists() and ort is not None:
            try:
                self.session = ort.InferenceSession(str(self.model_path), providers=["CPUExecutionProvider"])
                self.input_name = self.session.get_inputs()[0].name
            except Exception as error:  # Fall back instead of failing a live demonstration.
                self.load_error = str(error)
        elif mode == "onnx":
            self.load_error = "ONNX model missing or onnxruntime is not installed"
        # A downloaded .pt can be used in auto mode when a team intentionally
        # installs Ultralytics. It is never required for the small ONNX setup.
        pt_path = self.model_path.with_suffix(".pt")
        if mode == "auto" and self.session is None and pt_path.exists():
            try:
                from ultralytics import YOLO

                self.ultralytics_model = YOLO(str(pt_path))
            except Exception as error:
                self.load_error = f"PT model unavailable: {error}"

    @property
    def engine(self) -> str:
        if self.mode == "tabletop":
            return "opencv_heuristic"
        if self.session is not None:
            return "onnx_yolov8"
        if self.ultralytics_model is not None:
            return "ultralytics_yolov8"
        return "opencv_heuristic"

    def detect(self, preprocessed: dict[str, Any]) -> dict[str, Any]:
        if self.session is not None and self.mode != "tabletop":
            try:
                detections = self._detect_onnx(preprocessed)
                engine = "onnx_yolov8"
            except Exception as error:
                self.load_error = f"ONNX inference failed: {error}"
                detections = self._detect_tabletop(preprocessed["processed_frame"])
                engine = "opencv_heuristic"
        elif self.ultralytics_model is not None and self.mode == "auto":
            try:
                detections = self._detect_ultralytics(preprocessed["processed_frame"])
                engine = "ultralytics_yolov8"
            except Exception as error:
                self.load_error = f"Ultralytics inference failed: {error}"
                detections = self._detect_tabletop(preprocessed["processed_frame"])
                engine = "opencv_heuristic"
        else:
            detections = self._detect_tabletop(preprocessed["processed_frame"])
            engine = "opencv_heuristic"
        summary = self._summarize(detections, preprocessed["processed_frame"].shape[:2])
        summary.update({"detections": detections, "detector_engine": engine})
        if self.load_error:
            summary["engine_note"] = self.load_error
        return summary

    def _detect_onnx(self, preprocessed: dict[str, Any]) -> list[dict[str, Any]]:
        assert self.session is not None and self.input_name is not None
        raw = self.session.run(None, {self.input_name: preprocessed["letterbox_tensor"]})[0]
        data = np.squeeze(np.asarray(raw))
        if data.ndim != 2:
            raise RuntimeError(f"unexpected YOLO output shape {np.asarray(raw).shape}")
        # YOLOv8 commonly returns (4 + classes, 8400); some exports return its transpose.
        if data.shape[0] <= 128 and data.shape[1] > data.shape[0]:
            data = data.T
        if data.shape[1] < 5:
            raise RuntimeError(f"unexpected YOLO prediction width {data.shape[1]}")

        boxes: list[list[int]] = []
        scores: list[float] = []
        class_ids: list[int] = []
        scale = float(preprocessed["scale"])
        pad_x, pad_y = preprocessed["pad"]
        height, width = preprocessed["processed_frame"].shape[:2]
        for prediction in data:
            class_scores = prediction[4:]
            class_id = int(np.argmax(class_scores))
            confidence = float(class_scores[class_id])
            if confidence < self.conf:
                continue
            center_x, center_y, box_w, box_h = map(float, prediction[:4])
            x = int((center_x - box_w / 2 - pad_x) / scale)
            y = int((center_y - box_h / 2 - pad_y) / scale)
            box_w, box_h = int(box_w / scale), int(box_h / scale)
            x, y = max(0, x), max(0, y)
            box_w, box_h = min(box_w, width - x), min(box_h, height - y)
            if box_w < 3 or box_h < 3:
                continue
            boxes.append([x, y, box_w, box_h])
            scores.append(confidence)
            class_ids.append(class_id)
        return [
            {"box": boxes[index], "class_id": class_ids[index], "label": CLASS_NAMES.get(class_ids[index], f"Class {class_ids[index]}"), "confidence": round(scores[index], 3)}
            for index in _nms_by_class(boxes, scores, class_ids, self.iou)
        ]

    def _detect_ultralytics(self, frame: np.ndarray) -> list[dict[str, Any]]:
        assert self.ultralytics_model is not None
        result = self.ultralytics_model.predict(frame, conf=self.conf, iou=self.iou, device="cpu", verbose=False)[0]
        output: list[dict[str, Any]] = []
        for box in result.boxes:
            x1, y1, x2, y2 = [int(value) for value in box.xyxy[0].tolist()]
            class_id = int(box.cls[0].item())
            confidence = float(box.conf[0].item())
            if x2 - x1 < 3 or y2 - y1 < 3:
                continue
            output.append({"box": [max(0, x1), max(0, y1), x2 - x1, y2 - y1], "class_id": class_id, "label": CLASS_NAMES.get(class_id, f"Class {class_id}"), "confidence": round(confidence, 3)})
        return output

    def _detect_tabletop(self, frame: np.ndarray) -> list[dict[str, Any]]:
        """Find dark, filled cut-outs on the cardboard/asphalt tabletop track."""
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        blurred = cv2.GaussianBlur(gray, (5, 5), 0)
        adaptive = cv2.adaptiveThreshold(blurred, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 35, 5)
        # Require a cavity to be materially darker than the local road surface;
        # a broad 30th-percentile threshold turns normal cardboard texture into
        # false positives under hackathon lighting.
        percentile_cutoff = int(min(np.percentile(blurred, 12), float(np.mean(blurred)) * 0.68))
        dark = cv2.threshold(blurred, percentile_cutoff, 255, cv2.THRESH_BINARY_INV)[1]
        mask = cv2.bitwise_and(adaptive, dark)
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=2)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, iterations=1)
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        height, width = gray.shape
        image_area = height * width
        output: list[dict[str, Any]] = []
        for contour in contours:
            area = float(cv2.contourArea(contour))
            if area < max(120.0, image_area * 0.0015) or area > image_area * 0.30:
                continue
            x, y, box_w, box_h = cv2.boundingRect(contour)
            aspect = box_w / max(box_h, 1)
            fill = area / max(box_w * box_h, 1)
            if not 0.20 <= aspect <= 5.5 or fill < 0.18:
                continue
            confidence = min(0.92, 0.42 + area / image_area * 6.0 + fill * 0.22)
            output.append({"box": [x, y, box_w, box_h], "class_id": POTHOLE_CLASS, "label": "Pothole", "confidence": round(float(confidence), 3)})
        return sorted(output, key=lambda item: item["confidence"], reverse=True)

    @staticmethod
    def _summarize(detections: list[dict[str, Any]], shape: tuple[int, int]) -> dict[str, Any]:
        height, width = shape
        area = max(1, height * width)
        potholes = [item for item in detections if item["class_id"] == POTHOLE_CLASS]
        cracks = [item for item in detections if item["class_id"] in CRACK_CLASSES]
        pothole_area_ratio = sum(item["box"][2] * item["box"][3] for item in potholes) / area
        largest_pothole_ratio = max((item["box"][2] * item["box"][3] / area for item in potholes), default=0.0)
        score = int(round(max(0.0, min(100.0, 100 - len(potholes) * 8 - pothole_area_ratio * 300 - len(cracks) * 2))))
        if len(potholes) >= 3 or largest_pothole_ratio > 0.06:
            severity = "critical"
        elif len(potholes) >= 2 or pothole_area_ratio > 0.03:
            severity = "medium"
        elif potholes or cracks or score < 80:
            severity = "low"
        else:
            severity = "none"
        confidence = max((float(item["confidence"]) for item in potholes), default=max((float(item["confidence"]) for item in cracks), default=0.0))
        return {
            "pothole_count": len(potholes),
            "crack_count": len(cracks),
            "road_condition_score": score,
            "severity": severity,
            "confidence": round(confidence, 3),
            "pothole_area_ratio": round(pothole_area_ratio, 5),
        }


def annotate_frame(frame: np.ndarray, detections: list[dict[str, Any]], zone: dict[str, Any], metrics: dict[str, Any]) -> bytes:
    """Draw a demo-ready overlay and return a bounded-size JPEG."""
    canvas = frame.copy()
    for detection in detections:
        x, y, width, height = [int(value) for value in detection["box"]]
        pothole = detection["class_id"] == POTHOLE_CLASS
        color = (40, 40, 235) if pothole else (0, 180, 255)  # BGR: red / amber
        label = f"{detection['label']} {float(detection['confidence']) * 100:.0f}%"
        cv2.rectangle(canvas, (x, y), (x + width, y + height), color, 2)
        cv2.putText(canvas, label, (x, max(18, y - 6)), cv2.FONT_HERSHEY_SIMPLEX, 0.48, color, 2, cv2.LINE_AA)
    overlay = canvas.copy()
    bar_height = min(72, max(52, canvas.shape[0] // 7))
    cv2.rectangle(overlay, (0, 0), (canvas.shape[1], bar_height), (16, 20, 31), -1)
    canvas = cv2.addWeighted(overlay, 0.83, canvas, 0.17, 0)
    line_one = f"SADAKSATYA ROVER | {zone.get('id', 'UNKNOWN')} | Potholes {metrics.get('pothole_count', 0)} | Score {metrics.get('road_condition_score', 100)}"
    line_two = f"FPS {metrics.get('fps', 0):.1f} | {metrics.get('detector_engine', 'opencv_heuristic')} | {metrics.get('severity', 'none').upper()}"
    cv2.putText(canvas, line_one, (12, 23), cv2.FONT_HERSHEY_SIMPLEX, 0.52, (242, 246, 255), 1, cv2.LINE_AA)
    cv2.putText(canvas, line_two, (12, 47), cv2.FONT_HERSHEY_SIMPLEX, 0.48, (164, 216, 255), 1, cv2.LINE_AA)
    if canvas.shape[1] > 960:
        resized_height = round(canvas.shape[0] * 960 / canvas.shape[1])
        canvas = cv2.resize(canvas, (960, resized_height), interpolation=cv2.INTER_AREA)
    ok, encoded = cv2.imencode(".jpg", canvas, [cv2.IMWRITE_JPEG_QUALITY, 82])
    if not ok:
        raise RuntimeError("could not encode annotated frame")
    return encoded.tobytes()
