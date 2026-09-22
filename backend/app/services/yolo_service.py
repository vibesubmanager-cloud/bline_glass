"""YOLO object detection with a swappable ObjectDetector interface.

Default implementation uses Ultralytics YOLOv8n (nano) for CPU-friendly
production deploys. Set YOLO_MODEL to upgrade later without changing routes.
"""

from __future__ import annotations

import threading
from abc import ABC, abstractmethod
from dataclasses import dataclass

import numpy as np
from PIL import Image

from app.utils.logging import log_error, log_event


@dataclass
class Detection:
    label: str
    confidence: float
    bbox: list[float]
    position: str

    def to_dict(self) -> dict:
        return {
            "label": self.label,
            "confidence": round(float(self.confidence), 3),
            "bbox": [round(float(v), 1) for v in self.bbox],
            "position": self.position,
        }


class ObjectDetector(ABC):
    @abstractmethod
    def detect(self, image: Image.Image, confidence: float = 0.35) -> list[Detection]:
        raise NotImplementedError


def relative_position(cx: float, cy: float, width: float, height: float) -> str:
    if width <= 0 or height <= 0:
        return "center"
    horiz = "left" if cx < width * 0.33 else "right" if cx > width * 0.67 else "center"
    vert = "top" if cy < height * 0.33 else "bottom" if cy > height * 0.67 else "middle"
    if horiz == "center" and vert == "middle":
        return "center"
    if horiz == "center":
        return f"{vert} center"
    if vert == "middle":
        return horiz
    return f"{vert} {horiz}"


class UltralyticsYOLODetector(ObjectDetector):
    """Loads a YOLO model once, then runs inference on CPU or GPU if present."""

    def __init__(self, model_path: str):
        self.model_path = model_path
        self._model = None
        self._lock = threading.Lock()

    def _load(self):
        if self._model is not None:
            return
        with self._lock:
            if self._model is not None:
                return
            try:
                from ultralytics import YOLO
            except ImportError as exc:
                raise RuntimeError(
                    "YOLO dependencies are not installed. Install ultralytics to enable detection."
                ) from exc
            log_event("YOLO_MODEL_LOADING", model=self.model_path)
            self._model = YOLO(self.model_path)
            try:
                self._model.predict(np.zeros((320, 320, 3), dtype=np.uint8), imgsz=320, verbose=False)
            except Exception:
                pass
            log_event("YOLO_MODEL_READY", model=self.model_path)

    def detect(self, image: Image.Image, confidence: float = 0.35) -> list[Detection]:
        self._load()
        array = np.array(image.convert("RGB"))
        height, width = array.shape[:2]
        results = self._model.predict(array, conf=confidence, verbose=False, imgsz=320)
        detections: list[Detection] = []
        if not results:
            return detections
        result = results[0]
        names = result.names or {}
        boxes = getattr(result, "boxes", None)
        if boxes is None:
            return detections
        for box in boxes:
            xyxy = box.xyxy[0].tolist()
            conf = float(box.conf[0]) if box.conf is not None else 0.0
            cls_id = int(box.cls[0]) if box.cls is not None else -1
            label = str(names.get(cls_id, f"class_{cls_id}"))
            x1, y1, x2, y2 = xyxy
            cx = (x1 + x2) / 2
            cy = (y1 + y2) / 2
            detections.append(
                Detection(
                    label=label,
                    confidence=conf,
                    bbox=[x1, y1, x2, y2],
                    position=relative_position(cx, cy, width, height),
                )
            )
        return detections


class YOLOService:
    def __init__(self, detector: ObjectDetector | None = None, model_path: str = "yolov8n.pt"):
        self.detector = detector or UltralyticsYOLODetector(model_path)

    def detect(self, image: Image.Image, confidence: float = 0.35) -> list[dict]:
        log_event("YOLO_REQUEST")
        try:
            detections = self.detector.detect(image, confidence=confidence)
        except Exception as exc:
            log_error("YOLO_ERROR", exc)
            raise
        payload = [item.to_dict() if isinstance(item, Detection) else item for item in detections]
        log_event("YOLO_SUCCESS", count=len(payload))
        return payload

    def warmup(self) -> None:
        loader = getattr(self.detector, "_load", None)
        if callable(loader):
            loader()


_service: YOLOService | None = None


def get_yolo_service(model_path: str | None = None) -> YOLOService:
    global _service
    if _service is None:
        from flask import current_app

        path = model_path or current_app.config.get("YOLO_MODEL", "yolov8n.pt")
        _service = YOLOService(model_path=path)
    return _service
