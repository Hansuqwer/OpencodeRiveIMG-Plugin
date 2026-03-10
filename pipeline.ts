import { spawn } from 'node:child_process';
import { constants as fsConstants, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  generateAnimations,
  checkAnimationCompatibility,
  type AnimationPreset,
  type RiveAnimationDef,
} from './animation.js';
import { getRiveWriterStatus } from './rive-writer.js';

const TOOL_NAME = 'image-to-rive';
const TOOL_VERSION = '0.2.0';
const DEFAULT_MESH_DENSITY = 0.06;
const DEFAULT_ANIMATIONS: AnimationPreset[] = ['idle', 'walk', 'wave'];
const VALID_ANIMATIONS = new Set<AnimationPreset>([
  'idle',
  'walk',
  'wave',
  'jump',
  'run',
  'death',
]);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  stage: string;
  message: string;
  context?: Record<string, unknown>;
}

export interface PipelineOptions {
  inputImage: string;
  outputBundle?: string;
  /** Deprecated alias retained for compatibility. */
  outputRiv?: string;
  meshDensity?: number;
  animations?: AnimationPreset[];
  artboardWidth?: number;
  artboardHeight?: number;
  /** Accepted for compatibility. `.rivebundle` always includes masked PNG assets. */
  embedImage?: boolean;
  sheetMode?: 'auto' | 'single' | 'split';
  keepTemp?: boolean;
  onProgress?: (stage: string, pct: number, message?: string) => void;
}

interface Size {
  w: number;
  h: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface SegMeshVertex {
  x: number;
  y: number;
  u: number;
  v: number;
}

interface SegMesh {
  vertices: SegMeshVertex[];
  triangles: [number, number, number][];
  boundary_count: number;
}

interface SegComponent {
  id: string;
  label: string;
  source_bounds: Rect;
  image_size: Size;
  masked_png_path: string;
  contour: [number, number][];
  mesh: SegMesh;
  region_colors: string[];
  mask_stats: {
    area: number;
    fill_ratio: number;
  };
}

interface SegResult {
  schema_version: number;
  image_size: Size;
  background_method: string;
  sheet: {
    component_count: number;
    sheet_detected: boolean;
    ordering: 'row-major';
  };
  components: SegComponent[];
  primary_component_index: number;
}

interface BonePoint {
  x: number;
  y: number;
}

interface PoseBone {
  name: string;
  parent: string | null;
  role: string;
  x: number;
  y: number;
  rotation: number;
  length: number;
  start: BonePoint;
  end: BonePoint;
}

interface PoseComponent {
  id: string;
  skeleton: {
    type: string;
    confidence: string;
    symmetry_score?: number;
    bones: PoseBone[];
  };
  vertex_weights: Array<Record<string, number>>;
}

interface PoseResult {
  schema_version: number;
  components: PoseComponent[];
}

export interface PipelineArtboardSummary {
  id: string;
  name: string;
  bundleDir: string;
  maskedImagePath: string;
  contourSvgPath: string;
  meshSvgPath: string;
  rigPreviewPath: string;
  riveIrPath: string;
  sourceBounds: Rect;
  artboardWidth: number;
  artboardHeight: number;
  boneCount: number;
  vertexCount: number;
  triangleCount: number;
  skeletonType: string;
}

export interface PipelineResult {
  outputPath: string;
  bundlePath: string;
  /** Deprecated alias. Points at the `.rivebundle` directory. */
  rivPath: string;
  manifestPath: string;
  stateMachinePath: string;
  importNotesPath: string;
  logsPath: string;
  exportKind: 'rivebundle';
  exportStatus: 'fallback';
  primaryArtboardId: string;
  artboardCount: number;
  artboardWidth: number;
  artboardHeight: number;
  boneCount: number;
  vertexCount: number;
  triangleCount: number;
  animationNames: string[];
  skeletonType: string;
  warnings: string[];
  components: PipelineArtboardSummary[];
}

interface NormalizedPipelineOptions {
  inputImage: string;
  outputBundle: string;
  requestedOutputPath: string;
  meshDensity: number;
  animations: AnimationPreset[];
  artboardWidth?: number;
  artboardHeight?: number;
  embedImage: boolean;
  sheetMode: 'auto' | 'single' | 'split';
  keepTemp: boolean;
  warnings: string[];
  onProgress: (stage: string, pct: number, message?: string) => void;
}

interface StageContext {
  logs: LogEntry[];
  warnings: string[];
  progress: (stage: string, pct: number, message?: string) => void;
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}

function timestamp(): string {
  return new Date().toISOString();
}

function createLogger(logs: LogEntry[]) {
  return (
    level: LogEntry['level'],
    stage: string,
    message: string,
    context?: Record<string, unknown>,
  ): void => {
    logs.push({
      timestamp: timestamp(),
      level,
      stage,
      message,
      context,
    });
  };
}

function sanitizeId(input: string): string {
  const sanitized = input.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
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
  const segments = contour.slice(1).map(([x, y]) => `L ${x.toFixed(2)} ${y.toFixed(2)}`);
  return [`M ${firstX.toFixed(2)} ${firstY.toFixed(2)}`, ...segments, 'Z'].join(' ');
}

function normalizeOutputBundlePath(inputImage: string, outputBundle?: string, outputRiv?: string): {
  requested: string;
  resolved: string;
  warnings: string[];
} {
  const warnings: string[] = [];
  const initial =
    outputBundle ??
    outputRiv ??
    `${path.join(path.dirname(inputImage), path.parse(inputImage).name)}.rivebundle`;
  const resolvedInitial = path.resolve(initial);
  const lower = resolvedInitial.toLowerCase();

  if (lower.endsWith('.rivebundle')) {
    return { requested: resolvedInitial, resolved: resolvedInitial, warnings };
  }

  if (lower.endsWith('.riv')) {
    const parsed = path.parse(resolvedInitial);
    const converted = path.join(parsed.dir, `${parsed.name}.rivebundle`);
    warnings.push(
      `Requested output "${resolvedInitial}" ended with .riv. Using fallback bundle "${converted}".`,
    );
    return { requested: resolvedInitial, resolved: converted, warnings };
  }

  const converted = `${resolvedInitial}.rivebundle`;
  warnings.push(
    `Requested output "${resolvedInitial}" did not end with .rivebundle. Using "${converted}" instead.`,
  );
  return { requested: resolvedInitial, resolved: converted, warnings };
}

function normalizeOptions(opts: PipelineOptions): NormalizedPipelineOptions {
  const inputImage = path.resolve(opts.inputImage);
  const output = normalizeOutputBundlePath(inputImage, opts.outputBundle, opts.outputRiv);
  const meshDensity = opts.meshDensity ?? DEFAULT_MESH_DENSITY;

  if (!Number.isFinite(meshDensity) || meshDensity < 0.01 || meshDensity > 0.15) {
    throw new Error(`meshDensity must be in the range [0.01, 0.15]. Received ${meshDensity}.`);
  }

  const animations = (opts.animations ?? DEFAULT_ANIMATIONS).map((name) => {
    if (!VALID_ANIMATIONS.has(name)) {
      throw new Error(`Unsupported animation preset "${name}".`);
    }
    return name;
  });

  if (animations.length === 0) {
    throw new Error('At least one animation preset is required.');
  }

  const warnings = [...output.warnings];
  if (opts.embedImage) {
    warnings.push(
      'embedImage is accepted for backward compatibility but does not change `.rivebundle` output.',
    );
  }

  return {
    inputImage,
    outputBundle: output.resolved,
    requestedOutputPath: output.requested,
    meshDensity,
    animations,
    artboardWidth: opts.artboardWidth,
    artboardHeight: opts.artboardHeight,
    embedImage: Boolean(opts.embedImage),
    sheetMode: opts.sheetMode ?? 'auto',
    keepTemp: Boolean(opts.keepTemp),
    warnings,
    onProgress: opts.onProgress ?? (() => undefined),
  };
}

async function assertReadableFile(filePath: string): Promise<void> {
  await fs.access(filePath, fsConstants.R_OK);
}

function ensureImageExtension(filePath: string): void {
  const ext = path.extname(filePath).toLowerCase();
  if (!['.png', '.jpg', '.jpeg'].includes(ext)) {
    throw new Error(`Unsupported input extension "${ext || '(none)'}". Expected PNG or JPG.`);
  }
}

function resolvePythonScript(scriptName: string): string {
  const candidates = [
    path.resolve(__dirname, scriptName),
    path.resolve(__dirname, '..', scriptName),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Unable to resolve Python script "${scriptName}".`);
}

function getPythonCandidates(): string[] {
  const envChoice = process.env.PYTHON?.trim();
  const candidates = [envChoice, process.platform === 'win32' ? 'python' : 'python3', 'python'];
  return candidates.filter((value): value is string => Boolean(value));
}

async function runCommand(
  command: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string; error?: NodeJS.ErrnoException }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      resolve({ exitCode: -1, stdout, stderr, error });
    });

    child.on('close', (code: number | null) => {
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

function parseStatusJson(stdout: string): Record<string, unknown> | undefined {
  const lines = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]) as Record<string, unknown>;
    } catch {
      continue;
    }
  }
  return undefined;
}

async function runPythonJsonScript(
  scriptName: string,
  scriptArgs: string[],
  stage: string,
  ctx: StageContext,
): Promise<Record<string, unknown>> {
  const scriptPath = resolvePythonScript(scriptName);
  const log = createLogger(ctx.logs);
  let lastFailure: string | undefined;

  for (const pythonCommand of getPythonCandidates()) {
    const result = await runCommand(pythonCommand, [scriptPath, ...scriptArgs]);

    if (result.error?.code === 'ENOENT') {
      lastFailure = `Python interpreter "${pythonCommand}" was not found.`;
      continue;
    }

    const stderrLines = result.stderr
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of stderrLines) {
      log('info', stage, line);
    }

    const status = parseStatusJson(result.stdout);
    const statusError = typeof status?.error === 'string' ? status.error : undefined;

    if (result.exitCode !== 0 || statusError) {
      // Include stderr in error message for better debugging context
      const stderrPreview = result.stderr.slice(0, 2000);
      lastFailure = statusError ?? 
        `Python ${stage} failed (exit ${result.exitCode}):\n${stderrPreview || '(no stderr)'}`;
      continue;
    }


    if (!status || status.status !== 'ok') {
      lastFailure = `Python stage ${stage} returned an invalid status payload.`;
      continue;
    }

    return status;
  }

  throw new Error(lastFailure ?? `Unable to execute Python stage ${stage}.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON Schema Validation for Python IPC Results
// ─────────────────────────────────────────────────────────────────────────────

function validateSegResult(data: unknown): SegResult {
  if (!data || typeof data !== 'object') {
    throw new Error('SegResult validation failed: expected object');
  }
  
  const d = data as Record<string, unknown>;
  
  if (d.schema_version !== 2) {
    throw new Error(`SegResult validation failed: expected schema_version 2, got ${d.schema_version}`);
  }
  
  if (!Array.isArray(d.components)) {
    throw new Error('SegResult validation failed: components must be an array');
  }
  
  if (d.components.length === 0) {
    throw new Error('SegResult validation failed: components array must not be empty');
  }
  
  // Validate each component
  for (let i = 0; i < d.components.length; i++) {
    const comp = d.components[i] as Record<string, unknown>;
    if (!comp.id || typeof comp.id !== 'string') {
      throw new Error(`SegResult validation failed: component[${i}] missing valid 'id'`);
    }
    if (!comp.mesh || typeof comp.mesh !== 'object') {
      throw new Error(`SegResult validation failed: component[${i}] missing 'mesh'`);
    }
    const mesh = comp.mesh as Record<string, unknown>;
    if (!Array.isArray(mesh.vertices)) {
      throw new Error(`SegResult validation failed: component[${i}] mesh missing 'vertices' array`);
    }
    if (!Array.isArray(mesh.triangles)) {
      throw new Error(`SegResult validation failed: component[${i}] mesh missing 'triangles' array`);
    }
  }
  
  return d as unknown as SegResult;
}

function validatePoseResult(data: unknown): PoseResult {
  if (!data || typeof data !== 'object') {
    throw new Error('PoseResult validation failed: expected object');
  }
  
  const d = data as Record<string, unknown>;
  
  if (d.schema_version !== 2) {
    throw new Error(`PoseResult validation failed: expected schema_version 2, got ${d.schema_version}`);
  }
  
  if (!Array.isArray(d.components)) {
    throw new Error('PoseResult validation failed: components must be an array');
  }
  
  if (d.components.length === 0) {
    throw new Error('PoseResult validation failed: components array must not be empty');
  }
  
  // Validate each component
  for (let i = 0; i < d.components.length; i++) {
    const comp = d.components[i] as Record<string, unknown>;
    if (!comp.id || typeof comp.id !== 'string') {
      throw new Error(`PoseResult validation failed: component[${i}] missing valid 'id'`);
    }
    if (!comp.skeleton || typeof comp.skeleton !== 'object') {
      throw new Error(`PoseResult validation failed: component[${i}] missing 'skeleton'`);
    }
    const skeleton = comp.skeleton as Record<string, unknown>;
    if (!Array.isArray(skeleton.bones)) {
      throw new Error(`PoseResult validation failed: component[${i}] skeleton missing 'bones' array`);
    }
    if (!Array.isArray(comp.vertex_weights)) {
      throw new Error(`PoseResult validation failed: component[${i}] missing 'vertex_weights' array`);
    }
  }
  
  return d as unknown as PoseResult;
}

async function runSegmentation(
  opts: NormalizedPipelineOptions,
  tmpDir: string,
  ctx: StageContext,
): Promise<SegResult> {
  const outputJson = path.join(tmpDir, 'seg.json');
  const artifactsDir = path.join(tmpDir, 'segmentation_artifacts');
  await fs.mkdir(artifactsDir, { recursive: true });

  await runPythonJsonScript(
    'segment.py',
    [
      '--input',
      opts.inputImage,
      '--output',
      outputJson,
      '--artifacts-dir',
      artifactsDir,
      '--mesh-density',
      String(opts.meshDensity),
      '--sheet-mode',
      opts.sheetMode,
    ],
    'segmentation',
    ctx,
  );

  const rawPayload = JSON.parse(await fs.readFile(outputJson, 'utf8'));
  const payload = validateSegResult(rawPayload);
  return payload;
}

async function runPoseEstimation(
  opts: NormalizedPipelineOptions,
  segJsonPath: string,
  tmpDir: string,
  ctx: StageContext,
): Promise<PoseResult> {
  const outputJson = path.join(tmpDir, 'pose.json');

  await runPythonJsonScript(
    'pose_estimate.py',
    ['--input', opts.inputImage, '--seg', segJsonPath, '--output', outputJson],
    'pose',
    ctx,
  );

  const rawPayload = JSON.parse(await fs.readFile(outputJson, 'utf8'));
  const payload = validatePoseResult(rawPayload);
  return payload;
}

function makeContourSvg(component: SegComponent): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${component.image_size.w}" height="${component.image_size.h}" viewBox="0 0 ${component.image_size.w} ${component.image_size.h}">`,
    '  <rect width="100%" height="100%" fill="white"/>',
    `  <path d="${shapePathFromContour(component.contour)}" fill="#d9e8c6" stroke="#243024" stroke-width="2" fill-opacity="0.7"/>`,
    '</svg>',
    '',
  ].join('\n');
}

function makeMeshSvg(component: SegComponent): string {
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

function makeRigPreviewSvg(component: SegComponent, pose: PoseComponent): string {
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

function makeRiveIr(
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

function makeStateMachineIr(
  items: Array<{ id: string; label: string; animations: RiveAnimationDef[] }>,
): Record<string, unknown> {
  const animationNames = Array.from(
    new Set(items.flatMap((item) => item.animations.map((animation) => animation.name))),
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
    default_state: states.length > 0 ? states[0]!.id : null,
    parameters: [
      {
        name: 'artboard',
        type: 'enum',
        values: items.map((item) => item.id),
        default: items.length > 0 ? items[0]!.id : null,
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

function makeImportNotes(): string {
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

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function copyFileIntoBundle(sourcePath: string, targetPath: string): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.copyFile(sourcePath, targetPath);
}

async function writeBundle(
  opts: NormalizedPipelineOptions,
  seg: SegResult,
  pose: PoseResult,
  logs: LogEntry[],
  ctx: StageContext,
): Promise<{
  manifestPath: string;
  stateMachinePath: string;
  importNotesPath: string;
  logsPath: string;
  components: PipelineArtboardSummary[];
}> {
  const finalBundleDir = opts.outputBundle;
  await fs.mkdir(path.dirname(finalBundleDir), { recursive: true });

  const tempBundleDir = await fs.mkdtemp(
    path.join(path.dirname(finalBundleDir), `${path.basename(finalBundleDir)}.tmp-`),
  );

  try {
    const artboardsDir = path.join(tempBundleDir, 'artboards');
    await fs.mkdir(artboardsDir, { recursive: true });

    const componentSummaries: PipelineArtboardSummary[] = [];
    const stateItems: Array<{ id: string; label: string; animations: RiveAnimationDef[] }> = [];

    for (const component of seg.components) {
      const poseComponent = pose.components.find((item) => item.id === component.id);
      if (!poseComponent) {
        throw new Error(`Pose result did not contain component "${component.id}".`);
      }

      const artboardWidth = opts.artboardWidth ?? component.image_size.w;
      const artboardHeight = opts.artboardHeight ?? component.image_size.h;
      const artboardDir = path.join(artboardsDir, component.id);
      await fs.mkdir(artboardDir, { recursive: true });

      const boneNames = poseComponent.skeleton.bones.map((bone) => bone.name);
      
      // Check animation compatibility and add warnings
      const compatibility = checkAnimationCompatibility(boneNames, opts.animations);
      if (!compatibility.compatible) {
        ctx.warnings.push(...compatibility.warnings);
      }
      
      // Generate only compatible animations
      const animations = generateAnimations(boneNames, compatibility.supportedPresets);
      stateItems.push({ id: component.id, label: component.label, animations });


      const maskedTarget = path.join(artboardDir, 'masked.png');
      await copyFileIntoBundle(component.masked_png_path, maskedTarget);

      await writeJson(path.join(artboardDir, 'segmentation.json'), component);
      await writeJson(path.join(artboardDir, 'pose.json'), poseComponent);
      await writeJson(path.join(artboardDir, 'animations.json'), animations);
      await writeJson(
        path.join(artboardDir, 'rive_ir.json'),
        makeRiveIr(component, poseComponent, animations, artboardWidth, artboardHeight),
      );
      await fs.writeFile(path.join(artboardDir, 'contour.svg'), makeContourSvg(component), 'utf8');
      await fs.writeFile(path.join(artboardDir, 'mesh.svg'), makeMeshSvg(component), 'utf8');
      await fs.writeFile(
        path.join(artboardDir, 'rig-preview.svg'),
        makeRigPreviewSvg(component, poseComponent),
        'utf8',
      );

      const relativeDir = toPosixPath(path.relative(tempBundleDir, artboardDir));
      componentSummaries.push({
        id: component.id,
        name: component.label,
        bundleDir: relativeDir,
        maskedImagePath: `${relativeDir}/masked.png`,
        contourSvgPath: `${relativeDir}/contour.svg`,
        meshSvgPath: `${relativeDir}/mesh.svg`,
        rigPreviewPath: `${relativeDir}/rig-preview.svg`,
        riveIrPath: `${relativeDir}/rive_ir.json`,
        sourceBounds: component.source_bounds,
        artboardWidth,
        artboardHeight,
        boneCount: poseComponent.skeleton.bones.length,
        vertexCount: component.mesh.vertices.length,
        triangleCount: component.mesh.triangles.length,
        skeletonType: poseComponent.skeleton.type,
      });
    }

    const stateMachine = makeStateMachineIr(stateItems);
    const stateMachinePath = path.join(tempBundleDir, 'state_machine.json');
    const logsPath = path.join(tempBundleDir, 'logs.json');
    const importNotesPath = path.join(tempBundleDir, 'IMPORT_INTO_RIVE.md');
    const manifestPath = path.join(tempBundleDir, 'bundle.json');

    await writeJson(stateMachinePath, stateMachine);
    await writeJson(logsPath, logs);
    await fs.writeFile(importNotesPath, makeImportNotes(), 'utf8');

    const manifest = {
      schema_version: 1,
      kind: 'rivebundle',
      export: {
        status: 'fallback',
        output_format: 'rivebundle',
        riv_supported: false,
        writer_status: getRiveWriterStatus(),
      },
      tool: {
        name: TOOL_NAME,
        version: TOOL_VERSION,
      },
      input: {
        source_image: opts.inputImage,
        requested_output_path: opts.requestedOutputPath,
        actual_output_path: opts.outputBundle,
        sheet_detected: seg.sheet.sheet_detected,
        component_count: seg.components.length,
        background_method: seg.background_method,
      },
      config: {
        mesh_density: opts.meshDensity,
        animations: opts.animations,
        artboard_width_override: opts.artboardWidth ?? null,
        artboard_height_override: opts.artboardHeight ?? null,
        sheet_mode: opts.sheetMode,
      },
      primary_artboard_id: componentSummaries.length > 0 ? componentSummaries[0]!.id : null,
      artboards: componentSummaries,
      state_machine_path: 'state_machine.json',
      logs_path: 'logs.json',
      import_notes_path: 'IMPORT_INTO_RIVE.md',
    };
    await writeJson(manifestPath, manifest);

    // Atomic bundle write with backup-swap pattern
    // This prevents data loss if the rename operation fails
    const backupDir = `${finalBundleDir}.backup`;
    let hasBackup = false;
    
    try {
      // Step 1: If existing bundle, move to backup
      if (existsSync(finalBundleDir)) {
        await fs.rename(finalBundleDir, backupDir);
        hasBackup = true;
      }
      
      // Step 2: Move temp to final
      await fs.rename(tempBundleDir, finalBundleDir);
      
      // Step 3: Clean up backup (success!)
      if (hasBackup) {
        await fs.rm(backupDir, { recursive: true, force: true });
      }
    } catch (error) {
      // Recovery: restore from backup if something went wrong
      if (hasBackup && !existsSync(finalBundleDir)) {
        try {
          await fs.rename(backupDir, finalBundleDir);
        } catch {
          // Ignore recovery errors - we've done our best
        }
      }
      throw error;
    }

    return {
      manifestPath: path.join(finalBundleDir, 'bundle.json'),
      stateMachinePath: path.join(finalBundleDir, 'state_machine.json'),
      importNotesPath: path.join(finalBundleDir, 'IMPORT_INTO_RIVE.md'),
      logsPath: path.join(finalBundleDir, 'logs.json'),
      components: componentSummaries.map((component) => ({
        ...component,
        bundleDir: toPosixPath(path.join(path.basename(finalBundleDir), component.bundleDir)),
        maskedImagePath: toPosixPath(path.join(path.basename(finalBundleDir), component.maskedImagePath)),
        contourSvgPath: toPosixPath(path.join(path.basename(finalBundleDir), component.contourSvgPath)),
        meshSvgPath: toPosixPath(path.join(path.basename(finalBundleDir), component.meshSvgPath)),
        rigPreviewPath: toPosixPath(path.join(path.basename(finalBundleDir), component.rigPreviewPath)),
        riveIrPath: toPosixPath(path.join(path.basename(finalBundleDir), component.riveIrPath)),
      })),
    };
  } catch (error) {
    await fs.rm(tempBundleDir, { recursive: true, force: true });
    throw error;
  }
}

export async function runPipeline(opts: PipelineOptions): Promise<PipelineResult> {
  const normalized = normalizeOptions(opts);
  const logs: LogEntry[] = [];
  const log = createLogger(logs);
  const warnings = [...normalized.warnings];

  await assertReadableFile(normalized.inputImage);
  ensureImageExtension(normalized.inputImage);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'image-to-rive-'));
  const ctx: StageContext = {
    logs,
    warnings,
    progress: normalized.onProgress,
  };

  log('info', 'validate', 'Validated input options.', {
    inputImage: normalized.inputImage,
    outputBundle: normalized.outputBundle,
    meshDensity: normalized.meshDensity,
    animations: normalized.animations,
    sheetMode: normalized.sheetMode,
  });

  try {
    normalized.onProgress('segmentation', 15, 'Running segmentation and mesh generation');
    const seg = await runSegmentation(normalized, tmpDir, ctx);
    const segJsonPath = path.join(tmpDir, 'seg.json');
    await writeJson(segJsonPath, seg);

    if (seg.components.length > 1) {
      warnings.push(`Input was treated as a sheet and split into ${seg.components.length} components.`);
    }

    normalized.onProgress('pose', 45, 'Running skeleton inference and skinning');
    const pose = await runPoseEstimation(normalized, segJsonPath, tmpDir, ctx);

    normalized.onProgress('bundle', 75, 'Writing `.rivebundle` fallback artifacts');
    const bundle = await writeBundle(normalized, seg, pose, logs, ctx);

    normalized.onProgress('done', 100, 'Pipeline completed');

    const primaryComponent = bundle.components[0];
    if (!primaryComponent) {
      throw new Error('Bundle did not contain a primary artboard.');
    }

    log('info', 'done', 'Pipeline completed successfully.', {
      outputBundle: normalized.outputBundle,
      artboardCount: bundle.components.length,
    });

    return {
      outputPath: normalized.outputBundle,
      bundlePath: normalized.outputBundle,
      rivPath: normalized.outputBundle,
      manifestPath: bundle.manifestPath,
      stateMachinePath: bundle.stateMachinePath,
      importNotesPath: bundle.importNotesPath,
      logsPath: bundle.logsPath,
      exportKind: 'rivebundle',
      exportStatus: 'fallback',
      primaryArtboardId: primaryComponent.id,
      artboardCount: bundle.components.length,
      artboardWidth: primaryComponent.artboardWidth,
      artboardHeight: primaryComponent.artboardHeight,
      boneCount: primaryComponent.boneCount,
      vertexCount: primaryComponent.vertexCount,
      triangleCount: primaryComponent.triangleCount,
      animationNames: generateAnimations(
        pose.components.find((item) => item.id === primaryComponent.id)!.skeleton.bones.map((bone) => bone.name),
        normalized.animations,
      ).map((animation) => animation.name),
      skeletonType: primaryComponent.skeletonType,
      warnings,
      components: bundle.components,
    };
  } finally {
    if (!normalized.keepTemp) {
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log('warn', 'cleanup', `Failed to remove temporary directory: ${errorMessage}`, { tmpDir });
      }
    } else {
      log('warn', 'cleanup', 'Temporary directory retained because keepTemp=true.', { tmpDir });
    }

}
}
