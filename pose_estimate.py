#!/usr/bin/env python3
"""
Skeleton inference and skinning stage for the image-to-rive pipeline.

Features:
- Optional MediaPipe path for single-component humanoids.
- Stronger creature-focused heuristic for front-facing non-humanoid subjects.
- Segment-distance skinning weights instead of point-to-bone-origin weights.
"""

import argparse
import json
import math
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


def _load_cv2() -> tuple[Any, bool]:
    try:
        import cv2 as cv2_module  # type: ignore

        return cv2_module, True
    except Exception:
        return None, False


cv2, CV2_AVAILABLE = _load_cv2()
import numpy as np
from PIL import Image


def _load_mediapipe() -> tuple[Any, bool]:
    try:
        import mediapipe as mediapipe_module  # type: ignore

        return mediapipe_module, True
    except Exception:
        return None, False


mp, MEDIAPIPE_AVAILABLE = _load_mediapipe()


@dataclass(frozen=True)
class SkeletonConfig:
    """Configuration for skeleton type detection heuristics.

    These thresholds control how the pipeline classifies subjects into
    different skeleton types (biped, quadruped, generic, etc.).
    """

    # Creature detection thresholds
    min_symmetry_for_creature: float = (
        0.55  # Minimum symmetry score to consider creature-like
    )
    min_upper_dual_presence: float = (
        0.30  # Y-normalized range for upper body dual presence check
    )
    min_lower_dual_presence: float = (
        0.72  # Y-normalized range for lower body dual presence check
    )

    # Quadruped detection thresholds
    side_view_aspect_ratio_min: float = (
        1.3  # W/H ratio for side-view quadruped detection
    )
    side_view_symmetry_max: float = 0.65  # Maximum symmetry for side-view quadruped
    front_view_aspect_ratio_min: float = 0.75
    front_view_aspect_ratio_max: float = 1.30
    min_lower_body_mass_ratio: float = (
        0.45  # Required lower body mass for front-view quadruped
    )

    # MediaPipe detection thresholds
    mediapipe_min_confidence: float = 0.35


# Default configuration instance
DEFAULT_CONFIG = SkeletonConfig()


def log(message: str) -> None:
    print(f"[pose] {message}", file=sys.stderr)


def load_mask(masked_png_path: str) -> np.ndarray:
    rgba = np.array(Image.open(masked_png_path).convert("RGBA"))
    return (rgba[:, :, 3] > 10).astype(np.uint8)


def nearest_foreground_row(mask: np.ndarray, target_y: int) -> int:
    h = mask.shape[0]
    target_y = int(np.clip(target_y, 0, h - 1))
    if np.any(mask[target_y] > 0):
        return target_y

    for offset in range(1, h):
        up = target_y - offset
        down = target_y + offset
        if up >= 0 and np.any(mask[up] > 0):
            return up
        if down < h and np.any(mask[down] > 0):
            return down
    return target_y


def row_extent(mask: np.ndarray, y: int):
    y = nearest_foreground_row(mask, y)
    xs = np.where(mask[y] > 0)[0]
    if xs.size == 0:
        return None
    return int(xs.min()), int(xs.max()), y


def side_point(mask: np.ndarray, y_norm: float, side: str, inset_fraction: float):
    h, _ = mask.shape
    row = row_extent(mask, int(round(y_norm * (h - 1))))
    if row is None:
        return None
    left, right, y = row
    width = max(right - left, 1)
    if side == "left":
        x = left + width * inset_fraction
    else:
        x = right - width * inset_fraction
    return float(x), float(y)


def centerline(mask: np.ndarray):
    h, _ = mask.shape
    centres = np.zeros(h, dtype=np.float32)
    valid = np.zeros(h, dtype=bool)

    for y in range(h):
        xs = np.where(mask[y] > 0)[0]
        if xs.size > 0:
            centres[y] = float(xs.mean())
            valid[y] = True

    if not np.any(valid):
        centres[:] = mask.shape[1] / 2.0
        return centres

    last = float(np.where(valid)[0][0])
    last_value = float(centres[int(last)])
    for y in range(h):
        if valid[y]:
            last = float(y)
            last_value = float(centres[y])
        else:
            centres[y] = last_value

    last_value = float(centres[np.where(valid)[0][-1]])
    for y in range(h - 1, -1, -1):
        if valid[y]:
            last_value = float(centres[y])
        else:
            centres[y] = last_value

    kernel = np.ones(9, dtype=np.float32) / 9.0
    return np.convolve(centres, kernel, mode="same")


def centre_point(mask: np.ndarray, centreline_x: np.ndarray, y_norm: float):
    h = mask.shape[0]
    y = nearest_foreground_row(mask, int(round(y_norm * (h - 1))))
    return float(centreline_x[y]), float(y)


def ear_tip(mask: np.ndarray, side: str):
    h, w = mask.shape
    x_mid = w // 2
    y_limit = max(1, int(round(h * 0.35)))
    if side == "left":
        region = mask[:y_limit, :x_mid]
        x_offset = 0
    else:
        region = mask[:y_limit, x_mid:]
        x_offset = x_mid

    ys, xs = np.where(region > 0)
    if ys.size == 0:
        return None

    min_y = int(ys.min())
    candidate_xs = xs[ys <= min_y + 2]
    x = float(np.median(candidate_xs) + x_offset)
    return x, float(min_y)


def foot_point(mask: np.ndarray, side: str):
    h, w = mask.shape
    y0 = int(round(h * 0.72))
    if side == "left":
        region = mask[y0:, : w // 2]
        x_offset = 0
    else:
        region = mask[y0:, w // 2 :]
        x_offset = w // 2

    ys, xs = np.where(region > 0)
    if ys.size == 0:
        return None

    max_y = int(ys.max())
    candidate_xs = xs[ys >= max_y - 2]
    x = float(np.median(candidate_xs) + x_offset)
    return x, float(max_y + y0)


def symmetry_score(mask: np.ndarray) -> float:
    h, w = mask.shape
    mid = w // 2
    left = mask[:, :mid]
    right = np.fliplr(mask[:, w - mid :])
    if left.shape != right.shape:
        min_w = min(left.shape[1], right.shape[1])
        left = left[:, :min_w]
        right = right[:, :min_w]
    if left.size == 0:
        return 0.0
    return float(np.mean(left == right))


def has_dual_presence(mask: np.ndarray, y0_norm: float, y1_norm: float) -> bool:
    h, w = mask.shape
    y0 = int(round(y0_norm * (h - 1)))
    y1 = int(round(y1_norm * (h - 1)))
    region = mask[y0 : y1 + 1]
    if region.size == 0:
        return False
    left = np.any(region[:, : w // 2] > 0)
    right = np.any(region[:, w // 2 :] > 0)
    return bool(left and right)


def make_bone(name: str, parent: str | None, role: str, start_px, end_px, size):
    w, h = size
    cx = w / 2.0
    cy = h / 2.0
    sx = float(start_px[0] - cx)
    sy = float(start_px[1] - cy)
    ex = float(end_px[0] - cx)
    ey = float(end_px[1] - cy)
    dx = ex - sx
    dy = ey - sy
    length = float(math.hypot(dx, dy))
    rotation = float(math.atan2(dy, dx)) if length > 1e-6 else -math.pi / 2.0
    return {
        "name": name,
        "parent": parent,
        "role": role,
        "x": round(sx, 2),
        "y": round(sy, 2),
        "rotation": round(rotation, 4),
        "length": round(length, 2),
        "start": {"x": round(sx, 2), "y": round(sy, 2)},
        "end": {"x": round(ex, 2), "y": round(ey, 2)},
    }


def build_creature_front_biped(mask: np.ndarray):
    h, w = mask.shape
    centre_x = centerline(mask)

    pelvis = centre_point(mask, centre_x, 0.66)
    spine_mid = centre_point(mask, centre_x, 0.48)
    neck = centre_point(mask, centre_x, 0.32)
    head = centre_point(mask, centre_x, 0.20)

    left_shoulder = side_point(mask, 0.46, "left", 0.35) or side_point(
        mask, 0.46, "left", 0.25
    )
    right_shoulder = side_point(mask, 0.46, "right", 0.35) or side_point(
        mask, 0.46, "right", 0.25
    )
    left_elbow = side_point(mask, 0.62, "left", 0.14) or left_shoulder
    right_elbow = side_point(mask, 0.62, "right", 0.14) or right_shoulder
    left_wrist = side_point(mask, 0.82, "left", 0.10) or left_elbow
    right_wrist = side_point(mask, 0.82, "right", 0.10) or right_elbow

    left_hip = side_point(mask, 0.72, "left", 0.42) or pelvis
    right_hip = side_point(mask, 0.72, "right", 0.42) or pelvis
    left_knee = side_point(mask, 0.86, "left", 0.25) or left_hip
    right_knee = side_point(mask, 0.86, "right", 0.25) or right_hip
    left_ankle = foot_point(mask, "left") or left_knee
    right_ankle = foot_point(mask, "right") or right_knee

    left_ear_tip = ear_tip(mask, "left") or left_shoulder
    right_ear_tip = ear_tip(mask, "right") or right_shoulder
    left_ear_base = side_point(mask, 0.18, "left", 0.45) or head
    right_ear_base = side_point(mask, 0.18, "right", 0.45) or head

    bones = [
        make_bone("root", None, "root", pelvis, pelvis, (w, h)),
        make_bone("spine", "root", "spine", pelvis, spine_mid, (w, h)),
        make_bone("neck", "spine", "neck", spine_mid, neck, (w, h)),
        make_bone("head", "neck", "head", neck, head, (w, h)),
        make_bone("l_ear", "head", "ear", left_ear_base, left_ear_tip, (w, h)),
        make_bone("r_ear", "head", "ear", right_ear_base, right_ear_tip, (w, h)),
        make_bone("l_upper_arm", "spine", "arm", spine_mid, left_elbow, (w, h)),
        make_bone("r_upper_arm", "spine", "arm", spine_mid, right_elbow, (w, h)),
        make_bone(
            "l_lower_arm", "l_upper_arm", "forearm", left_elbow, left_wrist, (w, h)
        ),
        make_bone(
            "r_lower_arm", "r_upper_arm", "forearm", right_elbow, right_wrist, (w, h)
        ),
        make_bone("l_upper_leg", "root", "leg", left_hip, left_knee, (w, h)),
        make_bone("r_upper_leg", "root", "leg", right_hip, right_knee, (w, h)),
        make_bone("l_lower_leg", "l_upper_leg", "shin", left_knee, left_ankle, (w, h)),
        make_bone(
            "r_lower_leg", "r_upper_leg", "shin", right_knee, right_ankle, (w, h)
        ),
    ]

    return {
        "type": "creature_front_biped",
        "confidence": "heuristic",
        "symmetry_score": round(symmetry_score(mask), 4),
        "bones": bones,
    }


def tail_point(mask: np.ndarray):
    """Detect a probable tail tip — the bottommost or outermost point that
    extends beyond the main body on the lower quarter of the mask."""
    h, w = mask.shape
    y0 = int(round(h * 0.70))
    region = mask[y0:]
    if region.size == 0:
        return None
    ys, xs = np.where(region > 0)
    if ys.size == 0:
        return None
    # Pick the point farthest from the vertical centerline among the lowest 10% of rows
    max_y = int(ys.max())
    low_rows = ys >= max_y - max(3, int(region.shape[0] * 0.10))
    low_xs = xs[low_rows]
    low_ys = ys[low_rows]
    cx = w / 2.0
    # Pick the point with maximum horizontal distance from center
    dist_from_center = np.abs(low_xs.astype(np.float32) - cx)
    best = int(np.argmax(dist_from_center))
    x = float(low_xs[best])
    y = float(low_ys[best] + y0)
    # Only consider it a tail if it's far enough from center
    if abs(x - cx) < w * 0.15:
        return None
    return x, y


def build_quadruped_front(mask: np.ndarray):
    """Front-facing quadruped skeleton (dog, cat, horse, etc.).
    16 bones: root, spine, neck, head, 2 ears, 4 upper legs, 4 lower legs, optional tail."""
    h, w = mask.shape
    centre_x = centerline(mask)

    pelvis = centre_point(mask, centre_x, 0.62)
    spine_mid = centre_point(mask, centre_x, 0.45)
    neck = centre_point(mask, centre_x, 0.30)
    head = centre_point(mask, centre_x, 0.18)

    # Front legs (from shoulders, roughly at 0.42-0.65 height)
    l_front_upper = side_point(mask, 0.42, "left", 0.30) or side_point(
        mask, 0.42, "left", 0.20
    )
    r_front_upper = side_point(mask, 0.42, "right", 0.30) or side_point(
        mask, 0.42, "right", 0.20
    )
    l_front_lower = side_point(mask, 0.62, "left", 0.12) or l_front_upper
    r_front_lower = side_point(mask, 0.62, "right", 0.12) or r_front_upper

    # Hind legs (from hips, roughly at 0.68-0.92 height)
    l_hind_upper = side_point(mask, 0.68, "left", 0.38) or pelvis
    r_hind_upper = side_point(mask, 0.68, "right", 0.38) or pelvis
    l_hind_lower = (
        foot_point(mask, "left") or side_point(mask, 0.88, "left", 0.18) or l_hind_upper
    )
    r_hind_lower = (
        foot_point(mask, "right")
        or side_point(mask, 0.88, "right", 0.18)
        or r_hind_upper
    )

    left_ear_tip = ear_tip(mask, "left") or l_front_upper
    right_ear_tip = ear_tip(mask, "right") or r_front_upper
    left_ear_base = side_point(mask, 0.16, "left", 0.45) or head
    right_ear_base = side_point(mask, 0.16, "right", 0.45) or head

    bones = [
        make_bone("root", None, "root", pelvis, pelvis, (w, h)),
        make_bone("spine", "root", "spine", pelvis, spine_mid, (w, h)),
        make_bone("neck", "spine", "neck", spine_mid, neck, (w, h)),
        make_bone("head", "neck", "head", neck, head, (w, h)),
        make_bone("l_ear", "head", "ear", left_ear_base, left_ear_tip, (w, h)),
        make_bone("r_ear", "head", "ear", right_ear_base, right_ear_tip, (w, h)),
        make_bone("l_front_upper", "spine", "leg", spine_mid, l_front_upper, (w, h)),
        make_bone("r_front_upper", "spine", "leg", spine_mid, r_front_upper, (w, h)),
        make_bone(
            "l_front_lower",
            "l_front_upper",
            "shin",
            l_front_upper,
            l_front_lower,
            (w, h),
        ),
        make_bone(
            "r_front_lower",
            "r_front_upper",
            "shin",
            r_front_upper,
            r_front_lower,
            (w, h),
        ),
        make_bone("l_hind_upper", "root", "leg", l_hind_upper, l_hind_upper, (w, h)),
        make_bone("r_hind_upper", "root", "leg", r_hind_upper, r_hind_upper, (w, h)),
        make_bone(
            "l_hind_lower", "l_hind_upper", "shin", l_hind_upper, l_hind_lower, (w, h)
        ),
        make_bone(
            "r_hind_lower", "r_hind_upper", "shin", r_hind_upper, r_hind_lower, (w, h)
        ),
    ]

    # Optional tail
    tp = tail_point(mask)
    if tp is not None:
        tail_base = centre_point(mask, centre_x, 0.72)
        bones.append(make_bone("tail", "root", "tail", tail_base, tp, (w, h)))

    return {
        "type": "creature_front_quadruped",
        "confidence": "heuristic",
        "symmetry_score": round(symmetry_score(mask), 4),
        "bones": bones,
    }


def build_quadruped_side(mask: np.ndarray):
    """Side-view quadruped skeleton. Horizontal body, head on one side, tail on other.
    14 bones: root, spine_front, spine_rear, neck, head, 4 legs, optional tail."""
    h, w = mask.shape
    centre_x = centerline(mask)

    # For side view: horizontal body means the centerline is roughly mid-height
    # Spine runs left-to-right; head is at the end with more vertical extent up top
    # Detect head side: the side with more mass in the upper 40%
    upper_region = mask[: int(h * 0.40)]
    left_mass = np.sum(upper_region[:, : w // 2])
    right_mass = np.sum(upper_region[:, w // 2 :])
    head_on_left = left_mass >= right_mass

    if head_on_left:
        head_x_norm = 0.18
        neck_x_norm = 0.28
        spine_front_x_norm = 0.35
        spine_rear_x_norm = 0.65
        hip_x_norm = 0.72
        tail_x_norm = 0.90
        front_leg_x_norm = 0.32
        hind_leg_x_norm = 0.70
    else:
        head_x_norm = 0.82
        neck_x_norm = 0.72
        spine_front_x_norm = 0.65
        spine_rear_x_norm = 0.35
        hip_x_norm = 0.28
        tail_x_norm = 0.10
        front_leg_x_norm = 0.68
        hind_leg_x_norm = 0.30

    def h_point(x_norm: float, y_norm: float):
        x = x_norm * (w - 1)
        y = int(round(y_norm * (h - 1)))
        y = nearest_foreground_row(mask, y)
        return float(x), float(y)

    root = h_point(spine_rear_x_norm, 0.50)
    spine_front = h_point(spine_front_x_norm, 0.42)
    neck_pt = h_point(neck_x_norm, 0.30)
    head_pt = h_point(head_x_norm, 0.22)

    # Legs: both front and hind legs drop from the body line
    body_y_norm = 0.52
    foot_y_norm = 0.92

    l_front_hip = h_point(front_leg_x_norm - 0.03, body_y_norm)
    r_front_hip = h_point(front_leg_x_norm + 0.03, body_y_norm)
    l_front_foot = h_point(front_leg_x_norm - 0.04, foot_y_norm)
    r_front_foot = h_point(front_leg_x_norm + 0.02, foot_y_norm)

    l_hind_hip = h_point(hind_leg_x_norm - 0.03, body_y_norm)
    r_hind_hip = h_point(hind_leg_x_norm + 0.03, body_y_norm)
    l_hind_foot = h_point(hind_leg_x_norm - 0.04, foot_y_norm)
    r_hind_foot = h_point(hind_leg_x_norm + 0.02, foot_y_norm)

    bones = [
        make_bone("root", None, "root", root, root, (w, h)),
        make_bone("spine_rear", "root", "spine", root, spine_front, (w, h)),
        make_bone("spine_front", "spine_rear", "spine", spine_front, neck_pt, (w, h)),
        make_bone("neck", "spine_front", "neck", neck_pt, neck_pt, (w, h)),
        make_bone("head", "neck", "head", neck_pt, head_pt, (w, h)),
        make_bone(
            "l_front_upper", "spine_front", "leg", l_front_hip, l_front_hip, (w, h)
        ),
        make_bone(
            "l_front_lower", "l_front_upper", "shin", l_front_hip, l_front_foot, (w, h)
        ),
        make_bone(
            "r_front_upper", "spine_front", "leg", r_front_hip, r_front_hip, (w, h)
        ),
        make_bone(
            "r_front_lower", "r_front_upper", "shin", r_front_hip, r_front_foot, (w, h)
        ),
        make_bone("l_hind_upper", "root", "leg", l_hind_hip, l_hind_hip, (w, h)),
        make_bone(
            "l_hind_lower", "l_hind_upper", "shin", l_hind_hip, l_hind_foot, (w, h)
        ),
        make_bone("r_hind_upper", "root", "leg", r_hind_hip, r_hind_hip, (w, h)),
        make_bone(
            "r_hind_lower", "r_hind_upper", "shin", r_hind_hip, r_hind_foot, (w, h)
        ),
    ]

    # Optional tail (on opposite side from head)
    tp = tail_point(mask)
    if tp is not None:
        tail_base_pt = h_point(hip_x_norm, 0.45)
        bones.append(make_bone("tail", "root", "tail", tail_base_pt, tp, (w, h)))

    return {
        "type": "creature_side_quadruped",
        "confidence": "heuristic",
        "symmetry_score": round(symmetry_score(mask), 4),
        "bones": bones,
    }


def build_generic_skeleton(mask: np.ndarray):
    h, w = mask.shape
    centre_x = centerline(mask)
    p0 = centre_point(mask, centre_x, 0.78)
    p1 = centre_point(mask, centre_x, 0.56)
    p2 = centre_point(mask, centre_x, 0.34)
    p3 = centre_point(mask, centre_x, 0.16)

    bones = [
        make_bone("root", None, "root", p0, p0, (w, h)),
        make_bone("spine", "root", "spine", p0, p1, (w, h)),
        make_bone("neck", "spine", "neck", p1, p2, (w, h)),
        make_bone("head", "neck", "head", p2, p3, (w, h)),
    ]

    return {
        "type": "generic_centerline",
        "confidence": "fallback",
        "symmetry_score": round(symmetry_score(mask), 4),
        "bones": bones,
    }


def point_segment_distance(
    px: float, py: float, ax: float, ay: float, bx: float, by: float
) -> float:
    abx = bx - ax
    aby = by - ay
    denom = abx * abx + aby * aby
    if denom < 1e-6:
        return math.hypot(px - ax, py - ay)
    t = ((px - ax) * abx + (py - ay) * aby) / denom
    t = max(0.0, min(1.0, t))
    qx = ax + t * abx
    qy = ay + t * aby
    return math.hypot(px - qx, py - qy)


def compute_skinning_weights(
    skeleton: dict[str, Any],
    mesh_vertices: list[dict[str, Any]],
    size: tuple[float, float],
):
    w, h = size
    half_w = w / 2.0
    half_h = h / 2.0
    weights = []

    for vertex in mesh_vertices:
        vx = float(vertex["x"]) - half_w
        vy = float(vertex["y"]) - half_h
        influences = []

        for bone in skeleton["bones"]:
            start = bone["start"]
            end = bone["end"]
            dist = point_segment_distance(
                vx, vy, start["x"], start["y"], end["x"], end["y"]
            )

            name = bone["name"]
            role = bone["role"]

            if name.startswith("l_") and vx > 0:
                dist *= 1.35
            if name.startswith("r_") and vx < 0:
                dist *= 1.35
            if role in {"root", "spine", "neck"} and abs(vx) < w * 0.12:
                dist *= 0.85

            score = 1.0 / ((dist + 3.0) ** 2)
            influences.append((name, score))

        influences.sort(key=lambda item: item[1], reverse=True)
        top = influences[:4]
        total = sum(score for _, score in top) or 1.0
        weights.append({name: round(score / total, 4) for name, score in top})

    return weights


def landmarks_to_humanoid_skeleton(landmarks, image_size, source_bounds):
    image_w, image_h = image_size
    bounds = source_bounds
    crop_cx = bounds["w"] / 2.0
    crop_cy = bounds["h"] / 2.0

    required_indices = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]
    max_required = max(required_indices)
    if landmarks is None or len(landmarks) <= max_required:
        raise ValueError(
            f"MediaPipe landmark payload is incomplete: need index {max_required}, got {0 if landmarks is None else len(landmarks) - 1}"
        )

    def px(index):
        lm = landmarks[index]
        gx = lm.x * image_w
        gy = lm.y * image_h
        lx = gx - bounds["x"]
        ly = gy - bounds["y"]
        return lx, ly

    def midpoint(a, b):
        return ((a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0)

    ls = px(11)
    rs = px(12)
    le = px(13)
    re = px(14)
    lw = px(15)
    rw = px(16)
    lh = px(23)
    rh = px(24)
    lk = px(25)
    rk = px(26)
    la = px(27)
    ra = px(28)
    nose = px(0)

    root = midpoint(lh, rh)
    spine = midpoint(ls, rs)
    neck = midpoint(spine, nose)
    head = nose

    bones = [
        make_bone("root", None, "root", root, root, (bounds["w"], bounds["h"])),
        make_bone("spine", "root", "spine", root, spine, (bounds["w"], bounds["h"])),
        make_bone("neck", "spine", "neck", spine, neck, (bounds["w"], bounds["h"])),
        make_bone("head", "neck", "head", neck, head, (bounds["w"], bounds["h"])),
        make_bone("l_upper_arm", "spine", "arm", ls, le, (bounds["w"], bounds["h"])),
        make_bone("r_upper_arm", "spine", "arm", rs, re, (bounds["w"], bounds["h"])),
        make_bone(
            "l_lower_arm", "l_upper_arm", "forearm", le, lw, (bounds["w"], bounds["h"])
        ),
        make_bone(
            "r_lower_arm", "r_upper_arm", "forearm", re, rw, (bounds["w"], bounds["h"])
        ),
        make_bone("l_upper_leg", "root", "leg", lh, lk, (bounds["w"], bounds["h"])),
        make_bone("r_upper_leg", "root", "leg", rh, rk, (bounds["w"], bounds["h"])),
        make_bone(
            "l_lower_leg", "l_upper_leg", "shin", lk, la, (bounds["w"], bounds["h"])
        ),
        make_bone(
            "r_lower_leg", "r_upper_leg", "shin", rk, ra, (bounds["w"], bounds["h"])
        ),
    ]

    return {
        "type": "humanoid",
        "confidence": "mediapipe",
        "symmetry_score": None,
        "bones": bones,
    }


def infer_skeleton(
    mask: np.ndarray,
    component: dict[str, Any],
    input_path: str | None,
    image_size,
    config: SkeletonConfig = DEFAULT_CONFIG,
):
    h, w = mask.shape
    aspect_ratio = w / max(h, 1)
    symmetric = symmetry_score(mask)
    creature_like = (
        symmetric > config.min_symmetry_for_creature
        and has_dual_presence(mask, 0.0, config.min_upper_dual_presence)
        and has_dual_presence(mask, config.min_lower_dual_presence, 1.0)
    )
    h, w = mask.shape
    aspect_ratio = w / max(h, 1)
    symmetric = symmetry_score(mask)
    creature_like = (
        symmetric > 0.55
        and has_dual_presence(mask, 0.0, 0.30)
        and has_dual_presence(mask, 0.72, 1.0)
    )

    # --- MediaPipe humanoid attempt (single-subject humanoid images only) ---
    if (
        MEDIAPIPE_AVAILABLE
        and CV2_AVAILABLE
        and input_path
        and image_size
        and component.get("source_bounds")
        and component["id"].startswith("subject_")
    ):
        try:
            log("trying MediaPipe humanoid path")
            mp_any: Any = mp
            mp_pose = mp_any.solutions.pose
            cv2_any: Any = cv2
            bgr = cv2_any.imread(input_path)
            if bgr is not None:
                with mp_pose.Pose(
                    static_image_mode=True,
                    model_complexity=1,
                    min_detection_confidence=config.mediapipe_min_confidence,
                ) as pose:
                    result = pose.process(cv2_any.cvtColor(bgr, cv2_any.COLOR_BGR2RGB))
                    if result.pose_landmarks:
                        return landmarks_to_humanoid_skeleton(
                            result.pose_landmarks.landmark,
                            image_size,
                            component["source_bounds"],
                        )
        except Exception as exc:
            log(f"MediaPipe failed: {exc}")

    # --- Quadruped detection heuristic ---
    # Side-view quadruped: significantly wider than tall
    if (
        aspect_ratio > config.side_view_aspect_ratio_min
        and symmetric < config.side_view_symmetry_max
    ):
        log(
            f"side-view quadruped heuristic (aspect={aspect_ratio:.2f}, sym={symmetric:.2f})"
        )
        return build_quadruped_side(mask)

    # Front-view quadruped: near-square to wide, symmetric, with significant
    # lower body mass.  Tall upright subjects (aspect < 0.75) strongly favour
    # the biped path — real quadrupeds seen from front are at least ~square.
    if (
        creature_like
        and config.front_view_aspect_ratio_min
        <= aspect_ratio
        <= config.front_view_aspect_ratio_max
    ):
        lower_mass_ratio = float(np.sum(mask[int(h * 0.60) :]) / max(np.sum(mask), 1))
        # Require > 45% lower mass — four legs spread more mass below the midline
        if lower_mass_ratio > config.min_lower_body_mass_ratio:
            log(
                f"front-view quadruped heuristic (aspect={aspect_ratio:.2f}, lower_mass={lower_mass_ratio:.2f})"
            )
            return build_quadruped_front(mask)
    # Side-view quadruped: significantly wider than tall
    if aspect_ratio > 1.3 and symmetric < 0.65:
        log(
            f"side-view quadruped heuristic (aspect={aspect_ratio:.2f}, sym={symmetric:.2f})"
        )
        return build_quadruped_side(mask)

    # Front-view quadruped: near-square to wide, symmetric, with significant
    # lower body mass.  Tall upright subjects (aspect < 0.75) strongly favour
    # the biped path — real quadrupeds seen from front are at least ~square.
    if creature_like and 0.75 <= aspect_ratio <= 1.30:
        lower_mass_ratio = float(np.sum(mask[int(h * 0.60) :]) / max(np.sum(mask), 1))
        # Require > 45% lower mass — four legs spread more mass below the midline
        if lower_mass_ratio > 0.45:
            log(
                f"front-view quadruped heuristic (aspect={aspect_ratio:.2f}, lower_mass={lower_mass_ratio:.2f})"
            )
            return build_quadruped_front(mask)

    # --- Creature biped (front-facing, tall, symmetric) ---
    if creature_like:
        return build_creature_front_biped(mask)

    return build_generic_skeleton(mask)


def main():
    parser = argparse.ArgumentParser(description="Infer skeletons and skinning weights")
    parser.add_argument("--input", help="Original input image")
    parser.add_argument("--seg", required=True, help="Segmentation JSON path")
    parser.add_argument("--output", required=True, help="Output JSON path")
    args = parser.parse_args()

    try:
        seg = json.loads(Path(args.seg).read_text())
        image_size = (seg["image_size"]["w"], seg["image_size"]["h"])
        output_components = []

        for component in seg["components"]:
            mask = load_mask(component["masked_png_path"])
            skeleton = infer_skeleton(mask, component, args.input, image_size)
            weights = compute_skinning_weights(
                skeleton,
                component["mesh"]["vertices"],
                (component["image_size"]["w"], component["image_size"]["h"]),
            )
            output_components.append(
                {
                    "id": component["id"],
                    "skeleton": skeleton,
                    "vertex_weights": weights,
                }
            )
            bones = skeleton.get("bones")
            bone_count = len(bones) if isinstance(bones, list) else 0
            log(
                f"{component['id']}: {skeleton['type']} / {bone_count} bones / "
                f"{len(weights)} weighted vertices"
            )

        payload = {
            "schema_version": 2,
            "components": output_components,
        }
        Path(args.output).write_text(json.dumps(payload, indent=2))
        print(
            json.dumps(
                {
                    "status": "ok",
                    "output": args.output,
                    "component_count": len(output_components),
                }
            )
        )
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
