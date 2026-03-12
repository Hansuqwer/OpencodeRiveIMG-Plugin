import fs from 'node:fs/promises';
import path from 'node:path';

import {
  type PoseComponent,
  type PoseResult,
  type Rect,
  SAFE_COMPONENT_ID_RE,
  type SegComponent,
  type SegResult,
  type Size,
} from './contracts.js';

function assertBoolean(value: unknown, message: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(message);
  }
  return value;
}

function assertString(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(message);
  }
  return value;
}

export function assertFiniteNumber(value: unknown, message: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(message);
  }
  return value;
}

export function assertNonNegativeFiniteNumber(
  value: unknown,
  message: string,
): number {
  const parsed = assertFiniteNumber(value, message);
  if (parsed < 0) {
    throw new Error(message);
  }
  return parsed;
}

export function assertPositiveInt(value: unknown, message: string): number {
  const parsed = assertFiniteNumber(value, message);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(message);
  }
  return parsed;
}

export function assertComponentId(value: unknown, message: string): string {
  if (typeof value !== 'string' || !SAFE_COMPONENT_ID_RE.test(value)) {
    throw new Error(message);
  }
  return value;
}

export function assertRect(value: unknown, messagePrefix: string): Rect {
  if (!value || typeof value !== 'object') {
    throw new Error(`${messagePrefix} must be an object`);
  }
  const rect = value as Record<string, unknown>;
  return {
    x: assertFiniteNumber(rect.x, `${messagePrefix}.x must be a finite number`),
    y: assertFiniteNumber(rect.y, `${messagePrefix}.y must be a finite number`),
    w: assertPositiveInt(
      rect.w,
      `${messagePrefix}.w must be a positive integer`,
    ),
    h: assertPositiveInt(
      rect.h,
      `${messagePrefix}.h must be a positive integer`,
    ),
  };
}

export function assertSize(value: unknown, messagePrefix: string): Size {
  if (!value || typeof value !== 'object') {
    throw new Error(`${messagePrefix} must be an object`);
  }
  const size = value as Record<string, unknown>;
  return {
    w: assertPositiveInt(
      size.w,
      `${messagePrefix}.w must be a positive integer`,
    ),
    h: assertPositiveInt(
      size.h,
      `${messagePrefix}.h must be a positive integer`,
    ),
  };
}

export function validateSegResult(data: unknown): SegResult {
  if (!data || typeof data !== 'object') {
    throw new Error('SegResult validation failed: expected object');
  }

  const d = data as Record<string, unknown>;

  if (d.schema_version !== 2) {
    throw new Error(
      `SegResult validation failed: expected schema_version 2, got ${d.schema_version}`,
    );
  }

  assertSize(d.image_size, 'SegResult image_size');
  assertString(
    d.background_method,
    'SegResult validation failed: background_method must be a non-empty string',
  );

  if (!d.sheet || typeof d.sheet !== 'object') {
    throw new Error('SegResult validation failed: sheet must be an object');
  }
  const sheet = d.sheet as Record<string, unknown>;
  const sheetComponentCount = assertPositiveInt(
    sheet.component_count,
    'SegResult validation failed: sheet.component_count must be a positive integer',
  );
  assertBoolean(
    sheet.sheet_detected,
    'SegResult validation failed: sheet.sheet_detected must be a boolean',
  );
  if (sheet.ordering !== 'row-major') {
    throw new Error(
      `SegResult validation failed: expected sheet.ordering to be row-major, got ${String(sheet.ordering)}`,
    );
  }

  if (!Array.isArray(d.components)) {
    throw new Error('SegResult validation failed: components must be an array');
  }

  if (d.components.length === 0) {
    throw new Error(
      'SegResult validation failed: components array must not be empty',
    );
  }

  if (sheetComponentCount !== d.components.length) {
    throw new Error(
      `SegResult validation failed: sheet.component_count ${sheetComponentCount} did not match components length ${d.components.length}`,
    );
  }

  const primaryIndex = assertFiniteNumber(
    d.primary_component_index,
    'SegResult validation failed: primary_component_index must be a number',
  );
  if (
    !Number.isInteger(primaryIndex) ||
    primaryIndex < 0 ||
    primaryIndex >= d.components.length
  ) {
    throw new Error(
      `SegResult validation failed: primary_component_index ${primaryIndex} is out of bounds for components length ${d.components.length}`,
    );
  }

  for (let i = 0; i < d.components.length; i += 1) {
    const comp = d.components[i] as Record<string, unknown>;
    assertComponentId(
      comp.id,
      `SegResult validation failed: component[${i}] has invalid id`,
    );
    assertString(
      comp.label,
      `SegResult validation failed: component[${i}] missing valid label`,
    );
    assertRect(comp.source_bounds, `SegResult component[${i}] source_bounds`);
    assertSize(comp.image_size, `SegResult component[${i}] image_size`);
    assertString(
      comp.masked_png_path,
      `SegResult validation failed: component[${i}] missing valid masked_png_path`,
    );

    if (!Array.isArray(comp.contour)) {
      throw new Error(
        `SegResult validation failed: component[${i}] contour must be an array`,
      );
    }
    for (
      let pointIndex = 0;
      pointIndex < comp.contour.length;
      pointIndex += 1
    ) {
      const point = comp.contour[pointIndex];
      if (!Array.isArray(point) || point.length !== 2) {
        throw new Error(
          `SegResult validation failed: component[${i}] contour[${pointIndex}] must be [x, y]`,
        );
      }
      assertFiniteNumber(
        point[0],
        `SegResult validation failed: component[${i}] contour[${pointIndex}][0] must be finite`,
      );
      assertFiniteNumber(
        point[1],
        `SegResult validation failed: component[${i}] contour[${pointIndex}][1] must be finite`,
      );
    }

    if (!comp.mesh || typeof comp.mesh !== 'object') {
      throw new Error(
        `SegResult validation failed: component[${i}] missing mesh`,
      );
    }

    const mesh = comp.mesh as Record<string, unknown>;
    if (!Array.isArray(mesh.vertices)) {
      throw new Error(
        `SegResult validation failed: component[${i}] mesh missing vertices array`,
      );
    }
    if (mesh.vertices.length === 0) {
      throw new Error(
        `SegResult validation failed: component[${i}] mesh vertices must not be empty`,
      );
    }
    for (
      let vertexIndex = 0;
      vertexIndex < mesh.vertices.length;
      vertexIndex += 1
    ) {
      const vertex = mesh.vertices[vertexIndex] as Record<string, unknown>;
      if (!vertex || typeof vertex !== 'object') {
        throw new Error(
          `SegResult validation failed: component[${i}] mesh vertex[${vertexIndex}] must be an object`,
        );
      }
      assertFiniteNumber(
        vertex.x,
        `SegResult validation failed: component[${i}] mesh vertex[${vertexIndex}] x must be finite`,
      );
      assertFiniteNumber(
        vertex.y,
        `SegResult validation failed: component[${i}] mesh vertex[${vertexIndex}] y must be finite`,
      );
      assertFiniteNumber(
        vertex.u,
        `SegResult validation failed: component[${i}] mesh vertex[${vertexIndex}] u must be finite`,
      );
      assertFiniteNumber(
        vertex.v,
        `SegResult validation failed: component[${i}] mesh vertex[${vertexIndex}] v must be finite`,
      );
    }

    if (!Array.isArray(mesh.triangles)) {
      throw new Error(
        `SegResult validation failed: component[${i}] mesh missing triangles array`,
      );
    }
    for (
      let triangleIndex = 0;
      triangleIndex < mesh.triangles.length;
      triangleIndex += 1
    ) {
      const triangle = mesh.triangles[triangleIndex];
      if (!Array.isArray(triangle) || triangle.length !== 3) {
        throw new Error(
          `SegResult validation failed: component[${i}] triangle[${triangleIndex}] must have exactly 3 indices`,
        );
      }
      for (let corner = 0; corner < 3; corner += 1) {
        const indexValue = triangle[corner];
        if (
          typeof indexValue !== 'number' ||
          !Number.isInteger(indexValue) ||
          indexValue < 0 ||
          indexValue >= mesh.vertices.length
        ) {
          throw new Error(
            `SegResult validation failed: component[${i}] triangle[${triangleIndex}] index ${String(indexValue)} is out of bounds for ${mesh.vertices.length} vertices`,
          );
        }
      }
    }

    const boundaryCount = assertPositiveInt(
      mesh.boundary_count,
      `SegResult validation failed: component[${i}] mesh boundary_count must be a positive integer`,
    );
    if (boundaryCount > mesh.vertices.length) {
      throw new Error(
        `SegResult validation failed: component[${i}] mesh boundary_count ${boundaryCount} exceeds vertex count ${mesh.vertices.length}`,
      );
    }

    if (!Array.isArray(comp.region_colors)) {
      throw new Error(
        `SegResult validation failed: component[${i}] region_colors must be an array`,
      );
    }
    for (
      let colorIndex = 0;
      colorIndex < comp.region_colors.length;
      colorIndex += 1
    ) {
      assertString(
        comp.region_colors[colorIndex],
        `SegResult validation failed: component[${i}] region_colors[${colorIndex}] must be a non-empty string`,
      );
    }

    if (!comp.mask_stats || typeof comp.mask_stats !== 'object') {
      throw new Error(
        `SegResult validation failed: component[${i}] mask_stats must be an object`,
      );
    }
    const maskStats = comp.mask_stats as Record<string, unknown>;
    assertNonNegativeFiniteNumber(
      maskStats.area,
      `SegResult validation failed: component[${i}] mask_stats.area must be a non-negative number`,
    );
    const fillRatio = assertFiniteNumber(
      maskStats.fill_ratio,
      `SegResult validation failed: component[${i}] mask_stats.fill_ratio must be a finite number`,
    );
    if (fillRatio < 0 || fillRatio > 1) {
      throw new Error(
        `SegResult validation failed: component[${i}] mask_stats.fill_ratio must be in [0, 1]`,
      );
    }
  }

  return d as unknown as SegResult;
}

export function validatePoseResult(data: unknown): PoseResult {
  if (!data || typeof data !== 'object') {
    throw new Error('PoseResult validation failed: expected object');
  }

  const d = data as Record<string, unknown>;

  if (d.schema_version !== 2) {
    throw new Error(
      `PoseResult validation failed: expected schema_version 2, got ${d.schema_version}`,
    );
  }

  if (!Array.isArray(d.components)) {
    throw new Error(
      'PoseResult validation failed: components must be an array',
    );
  }

  if (d.components.length === 0) {
    throw new Error(
      'PoseResult validation failed: components array must not be empty',
    );
  }

  for (let i = 0; i < d.components.length; i += 1) {
    const comp = d.components[i] as Record<string, unknown>;
    assertComponentId(
      comp.id,
      `PoseResult validation failed: component[${i}] has invalid id`,
    );

    if (!comp.skeleton || typeof comp.skeleton !== 'object') {
      throw new Error(
        `PoseResult validation failed: component[${i}] missing skeleton`,
      );
    }
    const skeleton = comp.skeleton as Record<string, unknown>;
    assertString(
      skeleton.type,
      `PoseResult validation failed: component[${i}] skeleton missing type`,
    );
    assertString(
      skeleton.confidence,
      `PoseResult validation failed: component[${i}] skeleton missing confidence`,
    );

    if (!Array.isArray(skeleton.bones) || skeleton.bones.length === 0) {
      throw new Error(
        `PoseResult validation failed: component[${i}] skeleton missing bones array`,
      );
    }

    const boneNames = new Set<string>();
    const parentNames: Array<string | null> = [];

    for (let boneIndex = 0; boneIndex < skeleton.bones.length; boneIndex += 1) {
      const bone = skeleton.bones[boneIndex] as Record<string, unknown>;
      if (!bone || typeof bone !== 'object') {
        throw new Error(
          `PoseResult validation failed: component[${i}] skeleton bone[${boneIndex}] must be an object`,
        );
      }

      const boneName = assertString(
        bone.name,
        `PoseResult validation failed: component[${i}] skeleton bone[${boneIndex}] missing name`,
      );
      if (boneNames.has(boneName)) {
        throw new Error(
          `PoseResult validation failed: component[${i}] has duplicate bone name "${boneName}"`,
        );
      }
      boneNames.add(boneName);
      parentNames.push(
        bone.parent === null
          ? null
          : assertString(
              bone.parent,
              `PoseResult validation failed: component[${i}] skeleton bone[${boneIndex}] has invalid parent`,
            ),
      );

      assertString(
        bone.role,
        `PoseResult validation failed: component[${i}] skeleton bone[${boneIndex}] missing role`,
      );
      assertFiniteNumber(
        bone.x,
        `PoseResult validation failed: component[${i}] skeleton bone[${boneIndex}] x must be finite`,
      );
      assertFiniteNumber(
        bone.y,
        `PoseResult validation failed: component[${i}] skeleton bone[${boneIndex}] y must be finite`,
      );
      assertFiniteNumber(
        bone.rotation,
        `PoseResult validation failed: component[${i}] skeleton bone[${boneIndex}] rotation must be finite`,
      );
      assertNonNegativeFiniteNumber(
        bone.length,
        `PoseResult validation failed: component[${i}] skeleton bone[${boneIndex}] length must be non-negative`,
      );

      const start = bone.start as Record<string, unknown>;
      const end = bone.end as Record<string, unknown>;
      if (
        !start ||
        typeof start !== 'object' ||
        !end ||
        typeof end !== 'object'
      ) {
        throw new Error(
          `PoseResult validation failed: component[${i}] skeleton bone[${boneIndex}] start/end must be objects`,
        );
      }
      assertFiniteNumber(
        start.x,
        `PoseResult validation failed: component[${i}] skeleton bone[${boneIndex}] start.x must be finite`,
      );
      assertFiniteNumber(
        start.y,
        `PoseResult validation failed: component[${i}] skeleton bone[${boneIndex}] start.y must be finite`,
      );
      assertFiniteNumber(
        end.x,
        `PoseResult validation failed: component[${i}] skeleton bone[${boneIndex}] end.x must be finite`,
      );
      assertFiniteNumber(
        end.y,
        `PoseResult validation failed: component[${i}] skeleton bone[${boneIndex}] end.y must be finite`,
      );
    }

    for (let boneIndex = 0; boneIndex < parentNames.length; boneIndex += 1) {
      const parentName = parentNames[boneIndex];
      if (!parentName) {
        continue;
      }
      const bone = skeleton.bones[boneIndex] as Record<string, unknown>;
      if (!boneNames.has(parentName)) {
        throw new Error(
          `PoseResult validation failed: component[${i}] skeleton bone[${boneIndex}] references unknown parent "${parentName}"`,
        );
      }
      if (parentName === bone.name) {
        throw new Error(
          `PoseResult validation failed: component[${i}] skeleton bone[${boneIndex}] cannot parent itself`,
        );
      }
    }

    if (!Array.isArray(comp.vertex_weights)) {
      throw new Error(
        `PoseResult validation failed: component[${i}] missing vertex_weights array`,
      );
    }

    for (
      let weightIndex = 0;
      weightIndex < comp.vertex_weights.length;
      weightIndex += 1
    ) {
      const weightMap = comp.vertex_weights[weightIndex];
      if (
        !weightMap ||
        typeof weightMap !== 'object' ||
        Array.isArray(weightMap)
      ) {
        throw new Error(
          `PoseResult validation failed: component[${i}] vertex_weights[${weightIndex}] must be an object`,
        );
      }
      for (const [boneName, weight] of Object.entries(
        weightMap as Record<string, unknown>,
      )) {
        if (!boneNames.has(boneName)) {
          throw new Error(
            `PoseResult validation failed: component[${i}] vertex_weights[${weightIndex}] references unknown bone "${boneName}"`,
          );
        }
        if (
          typeof weight !== 'number' ||
          !Number.isFinite(weight) ||
          weight < 0 ||
          weight > 1
        ) {
          throw new Error(
            `PoseResult validation failed: component[${i}] vertex_weights[${weightIndex}] has invalid weight for bone "${boneName}"`,
          );
        }
      }
    }
  }

  return d as unknown as PoseResult;
}

export async function assertPathWithinDirectory(
  baseDir: string,
  candidatePath: string,
  label: string,
): Promise<void> {
  const [baseRealPath, candidateRealPath] = await Promise.all([
    fs.realpath(baseDir),
    fs.realpath(candidatePath),
  ]);
  const relative = path.relative(baseRealPath, candidateRealPath);
  if (
    relative.startsWith(`..${path.sep}`) ||
    relative === '..' ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `${label} path escapes expected directory: ${candidatePath}`,
    );
  }
}

export function validateComponentConsistency(
  component: SegComponent,
  poseComponent: PoseComponent,
): void {
  const vertexCount = component.mesh.vertices.length;
  if (poseComponent.vertex_weights.length !== vertexCount) {
    throw new Error(
      `Pose component "${poseComponent.id}" returned ${poseComponent.vertex_weights.length} weight rows for ${vertexCount} vertices.`,
    );
  }

  const knownBones = new Set(
    poseComponent.skeleton.bones.map((bone) => bone.name),
  );
  for (let index = 0; index < poseComponent.vertex_weights.length; index += 1) {
    const weightMap = poseComponent.vertex_weights[index];
    if (!weightMap || typeof weightMap !== 'object') {
      throw new Error(
        `Pose component "${poseComponent.id}" has invalid weight map at vertex index ${index}.`,
      );
    }

    const entries = Object.entries(weightMap);
    if (entries.length === 0) {
      throw new Error(
        `Pose component "${poseComponent.id}" has empty weight map at vertex index ${index}.`,
      );
    }

    let total = 0;
    for (const [boneName, weight] of entries) {
      if (!knownBones.has(boneName)) {
        throw new Error(
          `Pose component "${poseComponent.id}" references unknown bone "${boneName}" at vertex index ${index}.`,
        );
      }
      if (
        typeof weight !== 'number' ||
        !Number.isFinite(weight) ||
        weight < 0 ||
        weight > 1
      ) {
        throw new Error(
          `Pose component "${poseComponent.id}" has invalid weight ${String(weight)} for bone "${boneName}" at vertex index ${index}.`,
        );
      }
      total += weight;
    }

    if (!Number.isFinite(total) || total <= 0 || total > 1.01) {
      throw new Error(
        `Pose component "${poseComponent.id}" has invalid weight sum ${total.toFixed(4)} at vertex index ${index}.`,
      );
    }
  }
}
