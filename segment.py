#!/usr/bin/env python3
"""
Honest segmentation stage for the image-to-rive pipeline.

Features:
- Uses alpha if the input already has transparency.
- Uses rembg if available.
- Falls back to border-colour segmentation when rembg is unavailable.
- Splits sprite sheets into connected components.
- Extracts contours and generates a Delaunay mesh per component.
- Writes masked PNG crops plus a stable JSON contract for the TS pipeline.
"""

import argparse
import io
import json
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from scipy.spatial import Delaunay

rembg_remove = None
rembg_import_error = None
try:
    from rembg import remove as rembg_remove

    rembg_available = True
except BaseException as exc:
    rembg_available = False
    rembg_import_error = str(exc)


def log(message: str) -> None:
    print(f"[segment] {message}", file=sys.stderr)


def load_rgba(path: str) -> np.ndarray:
    return np.array(Image.open(path).convert("RGBA"))


def has_meaningful_alpha(rgba: np.ndarray) -> bool:
    alpha = rgba[:, :, 3]
    return bool(np.any(alpha < 250) and np.any(alpha > 0))


def mask_from_alpha(rgba: np.ndarray) -> np.ndarray:
    return (rgba[:, :, 3] > 10).astype(np.uint8)


def mask_from_rembg(input_path: str) -> np.ndarray:
    if rembg_remove is None:
        raise RuntimeError("rembg backend is not available")
    with open(input_path, "rb") as f:
        raw = f.read()
    result = rembg_remove(raw)
    if not isinstance(result, (bytes, bytearray)):
        raise RuntimeError("rembg returned unexpected output type")
    image = Image.open(io.BytesIO(bytes(result))).convert("RGBA")
    rgba = np.array(image)
    return (rgba[:, :, 3] > 10).astype(np.uint8)


def mask_from_border_colour(rgba: np.ndarray) -> np.ndarray:
    rgb = rgba[:, :, :3].astype(np.uint8)
    h, w = rgb.shape[:2]
    margin = max(2, min(h, w) // 50)

    border_pixels = np.concatenate(
        [
            rgb[:margin, :, :].reshape(-1, 3),
            rgb[h - margin :, :, :].reshape(-1, 3),
            rgb[:, :margin, :].reshape(-1, 3),
            rgb[:, w - margin :, :].reshape(-1, 3),
        ],
        axis=0,
    )

    lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB).astype(np.float32)
    border_lab = (
        cv2.cvtColor(border_pixels.reshape(-1, 1, 3), cv2.COLOR_RGB2LAB)
        .reshape(-1, 3)
        .astype(np.float32)
    )
    bg_colour = np.median(border_lab, axis=0)

    dist = np.linalg.norm(lab - bg_colour, axis=2)
    border_dist = np.concatenate(
        [
            dist[:margin, :].reshape(-1),
            dist[h - margin :, :].reshape(-1),
            dist[:, :margin].reshape(-1),
            dist[:, w - margin :].reshape(-1),
        ],
        axis=0,
    )

    threshold = max(float(np.percentile(border_dist, 99)) * 2.0, 10.0)
    mask = dist > threshold

    fill_ratio = float(mask.mean())
    if fill_ratio < 0.005 or fill_ratio > 0.95:
        gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
        _, otsu = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
        mask = otsu > 0

    return mask.astype(np.uint8)


def clean_mask(mask: np.ndarray) -> np.ndarray:
    mask_u8 = (mask > 0).astype(np.uint8) * 255
    h, w = mask_u8.shape
    kernel_size = max(3, int(round(min(h, w) * 0.008)))
    if kernel_size % 2 == 0:
        kernel_size += 1
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size))
    mask_u8 = cv2.morphologyEx(mask_u8, cv2.MORPH_CLOSE, kernel)
    mask_u8 = cv2.morphologyEx(mask_u8, cv2.MORPH_OPEN, kernel)

    flood = mask_u8.copy()
    flood_mask = np.zeros((h + 2, w + 2), dtype=np.uint8)
    cv2.floodFill(flood, flood_mask, (0, 0), 255)
    holes = cv2.bitwise_not(flood)
    mask_u8 = cv2.bitwise_or(mask_u8, holes)
    return (mask_u8 > 0).astype(np.uint8)


def sort_row_major(components, y_snap: int = 0):
    # When y_snap > 0, components whose y coordinates fall within y_snap pixels
    # of each other are treated as the same row and then sorted left-to-right
    # within that row.  This corrects the case where two independently-split
    # tall blobs produce row boundaries that land a few pixels apart.
    if y_snap <= 0:
        return sorted(components, key=lambda item: (item["y"], item["x"]))
    def snap_key(item):
        snapped_y = (item["y"] // y_snap) * y_snap
        return (snapped_y, item["x"])
    return sorted(components, key=snap_key)


def contiguous_runs(indices: np.ndarray, max_gap: int):
    if indices.size == 0:
        return []

    runs = []
    start = int(indices[0])
    prev = start

    for value in indices[1:]:
        current = int(value)
        if current - prev <= max_gap + 1:
            prev = current
            continue
        runs.append((start, prev + 1))
        start = current
        prev = current

    runs.append((start, prev + 1))
    return runs


def split_component_rows(labels: np.ndarray, component, min_area: int):
    x, y, w, h = component["x"], component["y"], component["w"], component["h"]
    label_id = component["label"]
    if h <= int(w * 1.35):
        return [component]

    component_mask = (labels[y : y + h, x : x + w] == label_id).astype(np.uint8)
    expected_rows = int(round(h / max(w * 1.6, 1.0)))
    expected_rows = max(1, min(6, expected_rows))
    if expected_rows <= 1:
        return [component]

    foreground_rows = np.where(component_mask > 0)[0].astype(np.float32)
    if foreground_rows.size < expected_rows * 16:
        return [component]

    centers = np.linspace(
        float(foreground_rows.min()), float(foreground_rows.max()), expected_rows
    )
    for _ in range(16):
        distances = np.abs(foreground_rows[:, None] - centers[None, :])
        assignments = np.argmin(distances, axis=1)
        updated = centers.copy()
        for index in range(expected_rows):
            member_rows = foreground_rows[assignments == index]
            if member_rows.size > 0:
                updated[index] = float(member_rows.mean())
        if np.allclose(updated, centers, atol=0.5):
            centers = updated
            break
        centers = updated

    centers = np.sort(centers)
    boundary_points = [0]
    for index in range(expected_rows - 1):
        midpoint = int(round((float(centers[index]) + float(centers[index + 1])) / 2.0))
        boundary_points.append(midpoint)
    boundary_points.append(h)

    normalized_boundaries = [0]
    for value in boundary_points[1:]:
        clamped = max(normalized_boundaries[-1] + 1, min(int(value), h))
        normalized_boundaries.append(clamped)

    min_run_height = max(10, int(round(h * 0.10)))
    row_runs = []
    for index in range(len(normalized_boundaries) - 1):
        start = normalized_boundaries[index]
        end = normalized_boundaries[index + 1]
        if end - start < min_run_height:
            continue
        row_runs.append((start, end))
    if len(row_runs) <= 1:
        return [component]

    split_components = []
    min_split_area = max(min_area, int(component["area"] * 0.08))

    for run_start, run_end in row_runs:
        run_mask = np.zeros_like(component_mask, dtype=np.uint8)
        run_mask[run_start:run_end, :] = component_mask[run_start:run_end, :]

        run_count, run_labels, run_stats, _ = cv2.connectedComponentsWithStats(
            run_mask, connectivity=8
        )
        if run_count <= 1:
            continue

        best_label = 1
        best_area = int(run_stats[1, cv2.CC_STAT_AREA])
        for index in range(2, run_count):
            area = int(run_stats[index, cv2.CC_STAT_AREA])
            if area > best_area:
                best_label = index
                best_area = area

        if best_area < min_split_area:
            continue

        left = int(run_stats[best_label, cv2.CC_STAT_LEFT])
        top = int(run_stats[best_label, cv2.CC_STAT_TOP])
        width = int(run_stats[best_label, cv2.CC_STAT_WIDTH])
        height = int(run_stats[best_label, cv2.CC_STAT_HEIGHT])
        patch = (
            run_labels[top : top + height, left : left + width] == best_label
        ).astype(np.uint8)

        split_components.append(
            {
                "label": label_id,
                "x": x + left,
                "y": y + top,
                "w": width,
                "h": height,
                "area": best_area,
                "mask_patch": patch,
            }
        )

    if len(split_components) <= 1:
        return [component]

    return split_components


def select_components(mask: np.ndarray, mode: str):
    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(
        mask.astype(np.uint8), connectivity=8
    )
    min_area = max(128, int(mask.size * 0.0005))
    components = []

    for label in range(1, num_labels):
        x, y, w, h, area = stats[label].tolist()
        if area < min_area:
            continue
        components.append(
            {
                "label": label,
                "x": int(x),
                "y": int(y),
                "w": int(w),
                "h": int(h),
                "area": int(area),
            }
        )

    if not components:
        raise ValueError("No foreground component survived mask cleanup")

    components = sort_row_major(components)

    if mode == "single":
        components = [max(components, key=lambda item: item["area"])]
    elif mode == "auto" and len(components) > 1:
        total = float(sum(item["area"] for item in components))
        largest = float(max(item["area"] for item in components))
        if largest / max(total, 1.0) > 0.82:
            components = [max(components, key=lambda item: item["area"])]
    elif mode == "split":
        expanded = []
        for component in components:
            expanded.extend(split_component_rows(labels, component, min_area))
        if len(expanded) > len(components):
            # Compute a y-snap tolerance so that components from independently-split
            # tall blobs that belong to the same visual row sort together.
            # Use median component height / 3 as the snap bucket (robust against
            # small boundary offsets that k-means can produce).
            heights = [item["h"] for item in expanded]
            heights.sort()
            median_h = heights[len(heights) // 2] if heights else 0
            y_snap = max(8, median_h // 3)
            components = sort_row_major(expanded, y_snap=y_snap)
        else:
            components = sort_row_major(expanded)
    return components, labels


def extract_component_crop_mask(
    labels: np.ndarray, component, x0: int, y0: int, x1: int, y1: int
) -> np.ndarray:
    if "mask_patch" not in component:
        return (labels[y0:y1, x0:x1] == component["label"]).astype(np.uint8)

    crop_mask = np.zeros((y1 - y0, x1 - x0), dtype=np.uint8)
    patch = component["mask_patch"]
    patch_x = int(component["x"])
    patch_y = int(component["y"])

    overlap_x0 = max(x0, patch_x)
    overlap_y0 = max(y0, patch_y)
    overlap_x1 = min(x1, patch_x + patch.shape[1])
    overlap_y1 = min(y1, patch_y + patch.shape[0])

    if overlap_x1 <= overlap_x0 or overlap_y1 <= overlap_y0:
        return crop_mask

    src_x0 = overlap_x0 - patch_x
    src_y0 = overlap_y0 - patch_y
    src_x1 = src_x0 + (overlap_x1 - overlap_x0)
    src_y1 = src_y0 + (overlap_y1 - overlap_y0)

    dst_x0 = overlap_x0 - x0
    dst_y0 = overlap_y0 - y0
    dst_x1 = dst_x0 + (overlap_x1 - overlap_x0)
    dst_y1 = dst_y0 + (overlap_y1 - overlap_y0)

    crop_mask[dst_y0:dst_y1, dst_x0:dst_x1] = patch[src_y0:src_y1, src_x0:src_x1]
    return crop_mask


def extract_contour(mask: np.ndarray):
    mask_u8 = (mask > 0).astype(np.uint8) * 255
    contours, _ = cv2.findContours(mask_u8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not contours:
        raise ValueError("No contour could be extracted for a component")

    largest = max(contours, key=cv2.contourArea)
    epsilon = max(1.0, 0.004 * cv2.arcLength(largest, True))
    approx = cv2.approxPolyDP(largest, epsilon, True).reshape(-1, 2)

    if len(approx) < 8:
        raw = largest.reshape(-1, 2)
        step = max(1, len(raw) // 64)
        approx = raw[::step]

    return [[int(point[0]), int(point[1])] for point in approx.tolist()]


def unique_points(points):
    result = []
    seen = set()
    for x, y in points:
        key = (round(float(x), 2), round(float(y), 2))
        if key in seen:
            continue
        seen.add(key)
        result.append((float(x), float(y)))
    return result


def generate_mesh(mask: np.ndarray, contour, density: float):
    h, w = mask.shape
    contour_np = np.array(contour, dtype=np.float32).reshape(-1, 1, 2)
    boundary_points = unique_points([(float(x), float(y)) for x, y in contour])

    spacing = max(5, int(round(min(w, h) * density)))
    ys, xs = np.where(mask > 0)
    min_y, max_y = int(ys.min()), int(ys.max())
    min_x, max_x = int(xs.min()), int(xs.max())

    interior_points = []
    for y in range(min_y + spacing, max_y, spacing):
        for x in range(min_x + spacing, max_x, spacing):
            if mask[y, x] == 0:
                continue
            signed_dist = cv2.pointPolygonTest(contour_np, (float(x), float(y)), True)
            if signed_dist > spacing * 0.35:
                interior_points.append((float(x), float(y)))

    all_points = unique_points(boundary_points + interior_points)
    if len(all_points) < 3:
        raise ValueError("Too few mesh points for triangulation")

    point_array = np.array(all_points, dtype=np.float32)
    triangulation = Delaunay(point_array)

    triangles = []
    for simplex in triangulation.simplices:
        cx = int(round(float(np.mean(point_array[simplex, 0]))))
        cy = int(round(float(np.mean(point_array[simplex, 1]))))
        if 0 <= cx < w and 0 <= cy < h and mask[cy, cx] > 0:
            triangles.append([int(simplex[0]), int(simplex[1]), int(simplex[2])])

    vertices = []
    denom_w = max(w - 1, 1)
    denom_h = max(h - 1, 1)
    for x, y in all_points:
        vertices.append(
            {
                "x": round(float(x), 2),
                "y": round(float(y), 2),
                "u": round(float(np.clip(x / denom_w, 0.0, 1.0)), 4),
                "v": round(float(np.clip(y / denom_h, 0.0, 1.0)), 4),
            }
        )

    return {
        "vertices": vertices,
        "triangles": triangles,
        "boundary_count": len(boundary_points),
    }


def sample_region_colours(rgba: np.ndarray):
    h = rgba.shape[0]
    region_h = max(1, h // 5)
    colours = []

    for region_index in range(5):
        y0 = region_index * region_h
        y1 = h if region_index == 4 else min(h, y0 + region_h)
        region = rgba[y0:y1, :, :]
        alpha_mask = region[:, :, 3] > 10
        if np.any(alpha_mask):
            rgb = region[:, :, :3][alpha_mask]
            avg = np.round(rgb.mean(axis=0)).astype(np.uint8).tolist()
            colours.append(f"#{avg[0]:02x}{avg[1]:02x}{avg[2]:02x}")
        else:
            colours.append("#808080")

    return colours


def write_masked_crop(rgba: np.ndarray, mask: np.ndarray, out_path: Path):
    crop = rgba.copy()
    crop[mask == 0] = [0, 0, 0, 0]
    Image.fromarray(crop, "RGBA").save(out_path)


def main():
    parser = argparse.ArgumentParser(
        description="Segment image and generate mesh components"
    )
    parser.add_argument("--input", required=True, help="Input image path")
    parser.add_argument("--output", required=True, help="Output JSON path")
    parser.add_argument(
        "--artifacts-dir", required=True, help="Directory for masked PNG crops"
    )
    parser.add_argument(
        "--mesh-density", type=float, default=0.06, help="Mesh density [0.01, 0.15]"
    )
    parser.add_argument(
        "--sheet-mode", choices=["auto", "single", "split"], default="auto"
    )
    args = parser.parse_args()

    log(f"processing {args.input}")

    try:
        rgba = load_rgba(args.input)

        if has_meaningful_alpha(rgba):
            mask = mask_from_alpha(rgba)
            background_method = "alpha"
        elif rembg_available:
            log("using rembg")
            mask = mask_from_rembg(args.input)
            background_method = "rembg"
        else:
            if rembg_import_error:
                log(f"rembg unavailable: {rembg_import_error}")
            log("using border-colour fallback")
            mask = mask_from_border_colour(rgba)
            background_method = "border_colour"

        mask = clean_mask(mask)
        components, labels = select_components(mask, args.sheet_mode)

        artifacts_dir = Path(args.artifacts_dir)
        artifacts_dir.mkdir(parents=True, exist_ok=True)

        component_entries = []
        label_prefix = "expression" if len(components) > 1 else "subject"

        for index, component in enumerate(components, start=1):
            label_id = component["label"]
            x, y, w, h = component["x"], component["y"], component["w"], component["h"]
            pad = max(4, int(round(min(w, h) * 0.04)))
            x0 = max(0, x - pad)
            y0 = max(0, y - pad)
            x1 = min(mask.shape[1], x + w + pad)
            y1 = min(mask.shape[0], y + h + pad)

            crop_mask = extract_component_crop_mask(labels, component, x0, y0, x1, y1)
            crop_rgba = rgba[y0:y1, x0:x1, :].copy()
            original_alpha = crop_rgba[:, :, 3].copy()
            crop_rgba[crop_mask == 0] = [0, 0, 0, 0]
            if np.any(original_alpha < 250):
                crop_rgba[:, :, 3] = np.where(crop_mask > 0, original_alpha, 0)
            else:
                crop_rgba[:, :, 3] = np.where(crop_mask > 0, 255, 0)

            contour = extract_contour(crop_mask)
            mesh = generate_mesh(crop_mask, contour, args.mesh_density)
            colours = sample_region_colours(crop_rgba)

            component_id = f"{label_prefix}_{index:02d}"
            component_label = f"{label_prefix.replace('_', ' ').title()} {index:02d}"
            masked_path = artifacts_dir / f"{component_id}_masked.png"
            write_masked_crop(crop_rgba, crop_mask, masked_path)

            area = int(crop_mask.sum())
            fill_ratio = float(area / max(crop_mask.shape[0] * crop_mask.shape[1], 1))

            component_entries.append(
                {
                    "id": component_id,
                    "label": component_label,
                    "source_bounds": {
                        "x": int(x0),
                        "y": int(y0),
                        "w": int(x1 - x0),
                        "h": int(y1 - y0),
                    },
                    "image_size": {
                        "w": int(crop_mask.shape[1]),
                        "h": int(crop_mask.shape[0]),
                    },
                    "masked_png_path": str(masked_path),
                    "contour": contour,
                    "mesh": mesh,
                    "region_colors": colours,
                    "mask_stats": {
                        "area": area,
                        "fill_ratio": round(fill_ratio, 4),
                    },
                }
            )

            mesh_vertices_raw = mesh.get("vertices", [])
            mesh_triangles_raw = mesh.get("triangles", [])
            mesh_vertices = (
                mesh_vertices_raw if isinstance(mesh_vertices_raw, list) else []
            )
            mesh_triangles = (
                mesh_triangles_raw if isinstance(mesh_triangles_raw, list) else []
            )

            log(
                f"{component_id}: {crop_mask.shape[1]}x{crop_mask.shape[0]}, "
                f"{len(mesh_vertices)} verts, {len(mesh_triangles)} tris"
            )

        payload = {
            "schema_version": 2,
            "image_size": {"w": int(rgba.shape[1]), "h": int(rgba.shape[0])},
            "background_method": background_method,
            "sheet": {
                "component_count": len(component_entries),
                "sheet_detected": len(component_entries) > 1,
                "ordering": "row-major",
            },
            "components": component_entries,
            "primary_component_index": 0,
        }

        Path(args.output).write_text(json.dumps(payload, indent=2))
        print(
            json.dumps(
                {
                    "status": "ok",
                    "output": args.output,
                    "component_count": len(component_entries),
                }
            )
        )
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
