import type { AnimationPreset, RiveAnimationDef } from '../animation.js';

export const TOOL_NAME = 'image-to-rive';
export const TOOL_VERSION = '0.2.0';
export const DEFAULT_MESH_DENSITY = 0.06;
export const MIN_MESH_DENSITY = 0.01;
export const MAX_MESH_DENSITY = 0.15;
export const MAX_INPUT_FILE_BYTES = 50 * 1024 * 1024; // 50 MB
export const MAX_ARTBOARD_DIMENSION = 8192;
export const DEFAULT_ANIMATIONS: AnimationPreset[] = ['idle', 'walk', 'wave'];
export const VALID_ANIMATIONS = new Set<AnimationPreset>([
  'idle',
  'walk',
  'wave',
  'jump',
  'run',
  'death',
]);
export const SAFE_COMPONENT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
export const DEFAULT_STAGE_TIMEOUT_MS = 60_000;
export const DEFAULT_STAGE_KILL_GRACE_MS = 2_000;
export const DEFAULT_STAGE_OUTPUT_CAP_BYTES = 1_000_000;

export interface CommandExecutionLimits {
  timeoutMs: number;
  killGraceMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
}

export const DEFAULT_COMMAND_LIMITS: CommandExecutionLimits = {
  timeoutMs: DEFAULT_STAGE_TIMEOUT_MS,
  killGraceMs: DEFAULT_STAGE_KILL_GRACE_MS,
  maxStdoutBytes: DEFAULT_STAGE_OUTPUT_CAP_BYTES,
  maxStderrBytes: DEFAULT_STAGE_OUTPUT_CAP_BYTES,
};

export interface RunCommandResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  stage: string;
  message: string;
  durationMs?: number;
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
  /**
   * Per-stage timeout in milliseconds. Overrides the default 60 s timeout for
   * all Python subprocess calls. Must be a positive integer.
   */
  stageTimeoutMs?: number;
  /**
   * Requested output format.
   * - `'rivebundle'` (default): always-supported JSON intermediate bundle.
   * - `'riv'`: binary `.riv` file. Emits a warning and falls back to
   *   `.rivebundle` until the remaining `.riv` gates are complete.
   */
  outputFormat?: 'rivebundle' | 'riv';
  keepTemp?: boolean;
  onProgress?: (stage: string, pct: number, message?: string) => void;
}

export interface Size {
  w: number;
  h: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SegMeshVertex {
  x: number;
  y: number;
  u: number;
  v: number;
}

export interface SegMesh {
  vertices: SegMeshVertex[];
  triangles: [number, number, number][];
  boundary_count: number;
}

export interface SegComponent {
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

export interface SegResult {
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

export interface BonePoint {
  x: number;
  y: number;
}

export interface PoseBone {
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

export interface PoseComponent {
  id: string;
  skeleton: {
    type: string;
    confidence: string;
    symmetry_score?: number;
    bones: PoseBone[];
  };
  vertex_weights: Array<Record<string, number>>;
}

export interface PoseResult {
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

export interface NormalizedPipelineOptions {
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
  commandLimits: CommandExecutionLimits;
  /**
   * Normalized output format. Always set to `'rivebundle'` or `'riv'`.
   * Defaults to `'rivebundle'` when PipelineOptions.outputFormat is omitted.
   * When `'riv'`, the pipeline emits an explicit fallback warning while
   * `.riv` output remains gated.
   */
  outputFormat: 'rivebundle' | 'riv';
}

export interface StageContext {
  logs: LogEntry[];
  warnings: string[];
  progress: (stage: string, pct: number, message?: string) => void;
}

export interface ComponentAnimationPlan {
  id: string;
  label: string;
  boneNames: string[];
  animations: RiveAnimationDef[];
  animationNames: string[];
}

export interface BundleAssemblyResult {
  manifestPath: string;
  stateMachinePath: string;
  importNotesPath: string;
  logsPath: string;
  components: PipelineArtboardSummary[];
  animationPlans: ComponentAnimationPlan[];
}
