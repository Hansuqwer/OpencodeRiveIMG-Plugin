import type { RiveAnimationDef } from '../animation.js';
import type {
  BonePoint,
  PoseComponent,
  SegComponent,
  Size,
} from './contracts.js';

function sanitizeId(input: string): string {
  const sanitized = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return sanitized.length > 0 ? sanitized : 'item';
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function shapePathFromContour(contour: [number, number][]): string {
  if (contour.length === 0) {
    return '';
  }
  const [firstX, firstY] = contour[0];
  const segments = contour
    .slice(1)
    .map(([x, y]) => `L ${x.toFixed(2)} ${y.toFixed(2)}`);
  return [`M ${firstX.toFixed(2)} ${firstY.toFixed(2)}`, ...segments, 'Z'].join(
    ' ',
  );
}

export function makeContourSvg(component: SegComponent): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${component.image_size.w}" height="${component.image_size.h}" viewBox="0 0 ${component.image_size.w} ${component.image_size.h}">`,
    '  <rect width="100%" height="100%" fill="white"/>',
    `  <path d="${shapePathFromContour(component.contour)}" fill="#d9e8c6" stroke="#243024" stroke-width="2" fill-opacity="0.7"/>`,
    '</svg>',
    '',
  ].join('\n');
}

export function makeMeshSvg(component: SegComponent): string {
  const trianglePaths = component.mesh.triangles.map(([a, b, c]) => {
    const va = component.mesh.vertices[a]!;
    const vb = component.mesh.vertices[b]!;
    const vc = component.mesh.vertices[c]!;
    return `<path d="M ${va.x.toFixed(2)} ${va.y.toFixed(2)} L ${vb.x.toFixed(2)} ${vb.y.toFixed(2)} L ${vc.x.toFixed(2)} ${vc.y.toFixed(2)} Z" fill="none" stroke="#475569" stroke-width="0.6"/>`;
  });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${component.image_size.w}" height="${component.image_size.h}" viewBox="0 0 ${component.image_size.w} ${component.image_size.h}">`,
    '  <rect width="100%" height="100%" fill="white"/>',
    `  <path d="${shapePathFromContour(component.contour)}" fill="#f8fafc" stroke="#0f172a" stroke-width="1.2"/>`,
    '  <g>',
    ...trianglePaths.map((line) => `    ${line}`),
    '  </g>',
    '</svg>',
    '',
  ].join('\n');
}

function boneDisplayPoint(point: BonePoint, size: Size): BonePoint {
  return {
    x: point.x + size.w / 2,
    y: point.y + size.h / 2,
  };
}

export function makeRigPreviewSvg(
  component: SegComponent,
  pose: PoseComponent,
): string {
  const meshLines = component.mesh.triangles.map(([a, b, c]) => {
    const va = component.mesh.vertices[a]!;
    const vb = component.mesh.vertices[b]!;
    const vc = component.mesh.vertices[c]!;
    return `<path d="M ${va.x.toFixed(2)} ${va.y.toFixed(2)} L ${vb.x.toFixed(2)} ${vb.y.toFixed(2)} L ${vc.x.toFixed(2)} ${vc.y.toFixed(2)} Z" fill="none" stroke="#94a3b8" stroke-width="0.4" opacity="0.55"/>`;
  });

  const boneLines = pose.skeleton.bones.map((bone) => {
    const start = boneDisplayPoint(bone.start, component.image_size);
    const end = boneDisplayPoint(bone.end, component.image_size);
    const labelX = ((start.x + end.x) / 2).toFixed(2);
    const labelY = ((start.y + end.y) / 2 - 4).toFixed(2);
    return [
      `<line x1="${start.x.toFixed(2)}" y1="${start.y.toFixed(2)}" x2="${end.x.toFixed(2)}" y2="${end.y.toFixed(2)}" stroke="#dc2626" stroke-width="2.2" stroke-linecap="round"/>`,
      `<circle cx="${start.x.toFixed(2)}" cy="${start.y.toFixed(2)}" r="2.5" fill="#7f1d1d"/>`,
      `<text x="${labelX}" y="${labelY}" font-size="9" font-family="monospace" text-anchor="middle" fill="#7f1d1d">${escapeXml(bone.name)}</text>`,
    ].join('\n      ');
  });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${component.image_size.w}" height="${component.image_size.h}" viewBox="0 0 ${component.image_size.w} ${component.image_size.h}">`,
    '  <rect width="100%" height="100%" fill="white"/>',
    `  <image href="masked.png" x="0" y="0" width="${component.image_size.w}" height="${component.image_size.h}" preserveAspectRatio="none"/>`,
    '  <g>',
    ...meshLines.map((line) => `    ${line}`),
    '  </g>',
    '  <g>',
    ...boneLines.map((line) => `    ${line}`),
    '  </g>',
    '</svg>',
    '',
  ].join('\n');
}

export function makeRiveIr(
  component: SegComponent,
  pose: PoseComponent,
  animations: RiveAnimationDef[],
  artboardWidth: number,
  artboardHeight: number,
): Record<string, unknown> {
  return {
    schema_version: 1,
    kind: 'rive_ir',
    artboard: {
      id: component.id,
      name: component.label,
      width: artboardWidth,
      height: artboardHeight,
      source_bounds: component.source_bounds,
    },
    contour: component.contour,
    mesh: component.mesh,
    skeleton: pose.skeleton,
    vertex_weights: pose.vertex_weights,
    animations,
    assets: {
      masked_png: 'masked.png',
      contour_svg: 'contour.svg',
      mesh_svg: 'mesh.svg',
      rig_preview_svg: 'rig-preview.svg',
    },
  };
}

export function makeStateMachineIr(
  items: Array<{ id: string; label: string; animations: RiveAnimationDef[] }>,
): Record<string, unknown> {
  const animationNames = Array.from(
    new Set(
      items.flatMap((item) =>
        item.animations.map((animation) => animation.name),
      ),
    ),
  );

  const states = items.flatMap((item) =>
    item.animations.map((animation) => ({
      id: `${item.id}::${sanitizeId(animation.name)}`,
      name: `${item.label} — ${animation.name}`,
      artboard: item.id,
      artboard_label: item.label,
      animation: animation.name,
      duration_frames: animation.durationFrames,
      fps: animation.fps,
      loop_type: animation.loopType,
    })),
  );

  return {
    schema_version: 1,
    kind: 'rive_state_machine_ir',
    name: 'ExpressionStateMachine',
    default_state: states.length > 0 ? states[0]?.id : null,
    parameters: [
      {
        name: 'artboard',
        type: 'enum',
        values: items.map((item) => item.id),
        default: items.length > 0 ? items[0]?.id : null,
      },
      {
        name: 'animation',
        type: 'enum',
        values: animationNames,
        default: animationNames.length > 0 ? animationNames[0]! : null,
      },
    ],
    selection_model: {
      artboard_parameter: 'artboard',
      animation_parameter: 'animation',
    },
    states,
  };
}

export function makeImportNotes(): string {
  return [
    '# image-to-rive bundle',
    '',
    'This output is a truthful fallback bundle, not a generated `.riv` file.',
    '',
    'Contents:',
    '- `bundle.json` — top-level manifest',
    '- `state_machine.json` — Rive-style state-machine IR',
    '- `logs.json` — structured pipeline logs',
    '- `artboards/<id>/masked.png` — segmented raster asset',
    '- `artboards/<id>/contour.svg` — contour reference',
    '- `artboards/<id>/mesh.svg` — deformable mesh preview',
    '- `artboards/<id>/rig-preview.svg` — mesh + skeleton overlay',
    '- `artboards/<id>/rive_ir.json` — rig, weights, and animation IR',
    '',
    'Suggested Rive workflow:',
    '1. Import `masked.png` or `contour.svg` into the Rive editor as the visual asset.',
    '2. Use `rig-preview.svg` and `rive_ir.json` as the reference for recreating the mesh and bone layout.',
    '3. Recreate state selections from `state_machine.json`, or consume the IR in a future importer.',
    '',
  ].join('\n');
}
