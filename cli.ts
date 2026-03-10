#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { runPipeline, type PipelineOptions, type PipelineResult } from './pipeline.js';
import type { AnimationPreset } from './animation.js';

const TOOL_VERSION = '0.2.0';
const ANIMATION_PRESETS: AnimationPreset[] = ['idle', 'walk', 'wave', 'jump', 'run', 'death'];
const SHEET_MODES = new Set(['auto', 'single', 'split']);

/**
 * Resolves a user-provided path against a base directory and validates
 * that the resolved path does not escape the base directory.
 * Prevents path traversal attacks (e.g., ../../../etc/passwd).
 */
function safeResolvePath(baseDir: string, userPath: string): string {
  const resolved = path.resolve(baseDir, userPath);
  const normalizedBase = path.normalize(baseDir + path.sep);
  const normalizedResolved = path.normalize(resolved + path.sep);
  
  // Check that resolved path is within base directory
  if (!normalizedResolved.startsWith(normalizedBase)) {
    throw new Error(`Path traversal denied: "${userPath}" escapes base directory`);
  }
  
  return resolved;
}

/* ── Default .rive/config.json ─────────────────────────────────────────── */

const DEFAULT_CONFIG = {
  version: TOOL_VERSION,
  output_dir: '.rive/output',
  default_mesh_density: 0.06,
  default_animations: ['idle'],
  default_sheet_mode: 'auto',
  python_venv: '.rive/.venv',
  auto_install_deps: true,
};

/* ── AGENTS.md section template ────────────────────────────────────────── */

const AGENTS_MD_SECTION = `
## Rive Plugin (image-to-rive v${TOOL_VERSION})

### Available Commands

| Command | Description |
|---------|-------------|
| \`image-to-rive convert <image> [options]\` | Convert a PNG/JPG into a rigged \`.rivebundle\` fallback |
| \`image-to-rive init [--global] [--force]\` | Initialize Rive plugin in the current project |
| \`image-to-rive check-deps\` | Check required and optional Python dependencies |
| \`/Rive-planning [image_path]\` | Guided workflow: brief → image approval → pipeline → bundle |

### Capabilities

The pipeline converts a static image into a rigged \`.rivebundle\` containing:
- Segmented and masked PNG assets (auto-splits expression sheets)
- Silhouette contour extraction
- Deformable Delaunay mesh with configurable density
- Inferred skeleton with skinning weights:
  - **Biped** (14 bones): front-facing creatures, cartoon characters, humanoids (MediaPipe fallback)
  - **Quadruped front** (15-16 bones): dogs, cats, horses facing the camera
  - **Quadruped side** (13-14 bones): side-on animals (auto-detects head direction)
  - **Generic centerline** (4 bones): asymmetric or unrecognized subjects
- Procedural animation presets: idle, walk, wave, jump, run, death
- Rive-style state-machine IR with named states
- Preview SVGs for contour, mesh, and rig

### Limitations (Honest)

- **No validated .riv binary writer.** Output is \`.rivebundle\` fallback only.
- If you pass a \`.riv\` output path, the CLI redirects to a sibling \`.rivebundle\`.
- Non-standard limbs (wings, tentacles, 6+ limbs) are NOT individually rigged.
- Skeleton confidence is \`"heuristic"\` unless MediaPipe detects a real human.
- Expression sheet splitting works best with 2-column grids on white/transparent backgrounds.

### Subject Type Handling

| Subject | Detection | Skeleton | Notes |
|---------|-----------|----------|-------|
| Cartoon biped | High symmetry + dual limbs | 14-bone creature biped | Best supported path |
| Humanoid | MediaPipe pose (if available) | 12-bone humanoid or 14-bone fallback | Cartoon humans → fallback |
| Quadruped (front) | Symmetric + wide + heavy lower body | 15-16 bones (4 legs + optional tail) | Must face camera |
| Quadruped (side) | Wide + low symmetry | 13-14 bones (horizontal spine) | Auto-detects head side |
| Non-standard | Low symmetry or unusual shape | 4-bone generic centerline | Manual re-rig needed |

### Configuration

Project config: \`.rive/config.json\`

\`\`\`json
{
  "version": "${TOOL_VERSION}",
  "output_dir": ".rive/output",
  "default_mesh_density": 0.06,
  "default_animations": ["idle"],
  "default_sheet_mode": "auto",
  "python_venv": ".rive/.venv",
  "auto_install_deps": true
}
\`\`\`

### Pipeline Invocation (for AI models)

\`\`\`bash
# Basic conversion
image-to-rive convert input.png -o output.rivebundle --json

# Expression sheet with 6 poses
image-to-rive convert expressions.png -o character.rivebundle --sheet-mode split --mesh-density 0.08 --animations idle,walk --json

# Dependency check
image-to-rive check-deps
\`\`\`
`.trimEnd();

const AGENTS_MD_MARKER_START = '<!-- RIVE-PLUGIN-START -->';
const AGENTS_MD_MARKER_END = '<!-- RIVE-PLUGIN-END -->';

/* ── Init command implementation ────────────────────────────────────────── */

interface ConvertCliArgs {
  input: string;
  output?: string;
  meshDensity?: number;
  animations?: AnimationPreset[];
  width?: number;
  height?: number;
  json?: boolean;
  embedImage?: boolean;
  keepTemp?: boolean;
  sheetMode?: 'auto' | 'single' | 'split';
}

function printHelp(): void {
  console.log(`
image-to-rive ${TOOL_VERSION}

Usage:
  image-to-rive convert <input.png> [options]
  image-to-rive init [--global] [--force]
  image-to-rive check-deps
  image-to-rive --help

Commands:
  convert          Convert an image to a .rivebundle
  init             Initialize Rive plugin in the current project (writes .rive/config.json,
                   appends to AGENTS.md, verifies Python deps, runs smoke test)
  check-deps       Check required and optional Python dependencies

Options (convert):
  -o, --output <path>         Output .rivebundle path
      --mesh-density <n>      Mesh point spacing in [0.01, 0.15]. Lower values = denser mesh (default 0.06)
      --animations <list>     Comma-separated presets: idle,walk,wave,jump,run,death
      --width <px>            Override artboard width
      --height <px>           Override artboard height
      --sheet-mode <mode>     auto | single | split
      --embed-image           Accepted for compatibility; ignored in bundle mode
      --keep-temp             Keep temporary work directory
      --json                  Print structured JSON
  -h, --help                  Show help

Options (init):
  --global                    Install globally (~/.config/opencode/) instead of current project
  --force                     Overwrite existing .rive/config.json and AGENTS.md section

Notes:
  - The supported output is a .rivebundle fallback, not a validated .riv writer.
  - If you pass a .riv path, the CLI automatically redirects to a sibling .rivebundle.
`.trimStart());
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function parseNumber(value: string | undefined, flag: string): number {
  if (!value) {
    fail(`missing value for ${flag}`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    fail(`invalid numeric value for ${flag}: ${value}`);
  }
  return parsed;
}

function parseAnimationList(value: string | undefined): AnimationPreset[] {
  if (!value) {
    fail('missing value for --animations');
  }
  const names = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean) as AnimationPreset[];

  for (const name of names) {
    if (!ANIMATION_PRESETS.includes(name)) {
      fail(`unsupported animation preset: ${name}`);
    }
  }
  return names;
}

function parseConvertArgs(args: string[]): ConvertCliArgs {
  const result: ConvertCliArgs = { input: '' };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith('-') && !result.input) {
      result.input = arg;
      continue;
    }

    switch (arg) {
      case '-o':
      case '--output':
      case '--output-bundle':
        result.output = args[++index];
        break;
      case '--mesh-density':
        result.meshDensity = parseNumber(args[++index], '--mesh-density');
        break;
      case '--animations':
        result.animations = parseAnimationList(args[++index]);
        break;
      case '--width':
        result.width = parseNumber(args[++index], '--width');
        break;
      case '--height':
        result.height = parseNumber(args[++index], '--height');
        break;
      case '--sheet-mode': {
        const mode = args[++index];
        if (!mode || !SHEET_MODES.has(mode)) {
          fail(`invalid value for --sheet-mode: ${mode ?? '(missing)'}`);
        }
        result.sheetMode = mode as 'auto' | 'single' | 'split';
        break;
      }
      case '--embed-image':
        result.embedImage = true;
        break;
      case '--keep-temp':
        result.keepTemp = true;
        break;
      case '--json':
        result.json = true;
        break;
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
        break;
      default:
        fail(`unknown argument: ${arg}`);
    }
  }

  if (!result.input) {
    fail('missing input image');
  }

  return result;
}

async function runConvertCli(args: string[]): Promise<void> {
  const parsed = parseConvertArgs(args);
  const input = path.resolve(parsed.input);

  if (!existsSync(input)) {
    fail(`input file not found: ${input}`);
  }

  const output =
    parsed.output !== undefined
      ? path.resolve(parsed.output)
      : path.resolve(path.join(path.dirname(input), `${path.parse(input).name}.rivebundle`));

  const options: PipelineOptions = {
    inputImage: input,
    outputBundle: output,
    meshDensity: parsed.meshDensity,
    animations: parsed.animations,
    artboardWidth: parsed.width,
    artboardHeight: parsed.height,
    embedImage: parsed.embedImage,
    keepTemp: parsed.keepTemp,
    sheetMode: parsed.sheetMode,
    onProgress: parsed.json
      ? undefined
      : (stage, pct, message) => {
          const suffix = message ? ` - ${message}` : '';
          console.error(`[${pct}%] ${stage}${suffix}`);
        },
  };

  const result = await runPipeline(options);

  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printResult(result);
}

function printResult(result: PipelineResult): void {
  console.log('');
  console.log('image-to-rive completed');
  console.log('-----------------------');
  console.log(`Output bundle : ${result.bundlePath}`);
  console.log(`Primary rig   : ${result.primaryArtboardId} (${result.skeletonType})`);
  console.log(`Artboards     : ${result.artboardCount}`);
  console.log(`Primary mesh  : ${result.vertexCount} verts / ${result.triangleCount} tris`);
  console.log(`Animations    : ${result.animationNames.join(', ')}`);
  console.log(`Manifest      : ${result.manifestPath}`);
  console.log(`State machine : ${result.stateMachinePath}`);
  if (result.warnings.length > 0) {
    console.log('');
    console.log('Warnings:');
    for (const warning of result.warnings) {
      console.log(`  - ${warning}`);
    }
  }
  console.log('');
}

function runImportCheck(moduleName: string): { ok: boolean; detail?: string } {
  const script = `import sys\ntry:\n import ${moduleName}\nexcept BaseException as exc:\n print(exc)\n sys.exit(1)\nsys.exit(0)`;
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', script], {
    encoding: 'utf8',
  });
  if (result.status === 0) {
    return { ok: true };
  }
  const detail = (result.stderr || result.stdout || '').trim();
  return { ok: false, detail: detail || 'import failed' };
}

function checkDependencies(): number {
  const required = ['numpy', 'cv2', 'PIL', 'scipy', 'skimage'];
  const optional = ['rembg', 'mediapipe'];

  console.log('Dependency check');
  console.log('----------------');

  let allRequired = true;
  for (const name of required) {
    const check = runImportCheck(name);
    allRequired = allRequired && check.ok;
    console.log(`${check.ok ? 'OK ' : 'MISS'} required  ${name}`);
    if (!check.ok && check.detail) {
      console.log(`     detail: ${check.detail}`);
    }
  }
  for (const name of optional) {
    const check = runImportCheck(name);
    console.log(`${check.ok ? 'OK ' : 'MISS'} optional  ${name}`);
    if (!check.ok && check.detail) {
      console.log(`     detail: ${check.detail}`);
    }
  }

  if (!allRequired) {
    console.log('');
    console.log('Install required Python dependencies with:');
    console.log('  pip install -r requirements.txt');
    return 1;
  }

  console.log('');
  console.log('Required dependencies are available.');
  return 0;
}

interface ToolParameter {
  type: string;
  description?: string;
  enum?: string[];
  items?: { type: string; enum?: string[] };
  minimum?: number;
  maximum?: number;
  default?: unknown;
}

interface OpenCodeTool {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParameter>;
    required?: string[];
  };
  execute: (
    params: Record<string, unknown>,
    ctx: OpenCodeContext,
  ) => Promise<Record<string, unknown>>;
}

interface OpenCodeContext {
  cwd: string;
  log: (message: string) => void;
}

const imageToRiveTool: OpenCodeTool = {
  name: 'image_to_rive',
  description:
    'Convert a PNG or JPG into a rigged `.rivebundle` fallback containing segmented assets, mesh, skeleton, weights, procedural animations, and a Rive-style state-machine IR. This tool does not claim validated `.riv` binary generation.',
  parameters: {
    type: 'object',
    required: ['input_image'],
    properties: {
      input_image: {
        type: 'string',
        description: 'Path to the input PNG or JPG image.',
      },
      output_bundle: {
        type: 'string',
        description: 'Output path for the `.rivebundle` directory.',
      },
      output_riv: {
        type: 'string',
        description:
          'Deprecated alias. If supplied, the tool writes a sibling `.rivebundle` instead.',
      },
      mesh_density: {
        type: 'number',
        description: 'Mesh density in [0.01, 0.15]. Lower is denser.',
        minimum: 0.01,
        maximum: 0.15,
        default: 0.06,
      },
      animations: {
        type: 'array',
        description: 'Animation presets to generate.',
        items: {
          type: 'string',
          enum: ANIMATION_PRESETS,
        },
      },
      artboard_width: {
        type: 'number',
        description: 'Optional artboard width override.',
      },
      artboard_height: {
        type: 'number',
        description: 'Optional artboard height override.',
      },
      sheet_mode: {
        type: 'string',
        description: 'How to treat multi-subject sheets.',
        enum: ['auto', 'single', 'split'],
        default: 'auto',
      },
      keep_temp: {
        type: 'string',
        description: 'Set to "true" to keep the temporary working directory.',
        enum: ['true', 'false'],
        default: 'false',
      },
    },
  },
  async execute(params, ctx) {
    // Validate and resolve input/output paths to prevent path traversal
    const inputImage = safeResolvePath(ctx.cwd, String(params.input_image));
    const outputBundleRaw =
      typeof params.output_bundle === 'string'
        ? params.output_bundle
        : typeof params.output_riv === 'string'
          ? params.output_riv
          : `${path.parse(inputImage).name}.rivebundle`;
    const outputBundle = safeResolvePath(ctx.cwd, outputBundleRaw);


    ctx.log(`image-to-rive: processing ${inputImage}`);

    const options: PipelineOptions = {
      inputImage,
      outputBundle,
      meshDensity: typeof params.mesh_density === 'number' ? params.mesh_density : undefined,
      animations: Array.isArray(params.animations)
        ? (params.animations.filter((item): item is AnimationPreset => ANIMATION_PRESETS.includes(item as AnimationPreset)))
        : undefined,
      artboardWidth: typeof params.artboard_width === 'number' ? params.artboard_width : undefined,
      artboardHeight:
        typeof params.artboard_height === 'number' ? params.artboard_height : undefined,
      sheetMode:
        typeof params.sheet_mode === 'string' && SHEET_MODES.has(params.sheet_mode)
          ? (params.sheet_mode as 'auto' | 'single' | 'split')
          : undefined,
      keepTemp: params.keep_temp === 'true',
      onProgress: (stage, pct, message) => {
        const suffix = message ? ` - ${message}` : '';
        ctx.log(`[${pct}%] ${stage}${suffix}`);
      },
    };

    try {
      const result = await runPipeline(options);
      return {
        success: true,
        export_kind: result.exportKind,
        export_status: result.exportStatus,
        bundle_path: result.bundlePath,
        manifest_path: result.manifestPath,
        state_machine_path: result.stateMachinePath,
        primary_artboard_id: result.primaryArtboardId,
        artboard_count: result.artboardCount,
        primary_skeleton_type: result.skeletonType,
        primary_bone_count: result.boneCount,
        primary_vertex_count: result.vertexCount,
        primary_triangle_count: result.triangleCount,
        animations: result.animationNames,
        warnings: result.warnings,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.log(`image-to-rive: error - ${message}`);
      return { success: false, error: message };
    }
  },
};

const initTool: OpenCodeTool = {
  name: 'rive_init',
  description:
    'Initialize the Rive plugin in a project: creates `.rive/config.json`, appends a capabilities section to `AGENTS.md`, checks Python dependencies, and verifies pipeline readiness.',
  parameters: {
    type: 'object',
    properties: {
      global: {
        type: 'string',
        description: 'Set to "true" to install globally in ~/.config/opencode/ instead of the current project.',
        enum: ['true', 'false'],
        default: 'false',
      },
      force: {
        type: 'string',
        description: 'Set to "true" to overwrite existing config and AGENTS.md section.',
        enum: ['true', 'false'],
        default: 'false',
      },
    },
  },
  async execute(params, ctx) {
    const args: string[] = [];
    if (params.global === 'true') args.push('--global');
    if (params.force === 'true') args.push('--force');
    try {
      await runInit(args);
      return { success: true, message: 'Rive plugin initialized. See AGENTS.md for capabilities.' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.log(`rive-init: error - ${message}`);
      return { success: false, error: message };
    }
  },
};

const plugin = {
  name: 'image-to-rive',
  version: TOOL_VERSION,
  description:
    'Convert static images into rigged `.rivebundle` fallbacks for Rive authoring and runtime preparation.',
  tools: [imageToRiveTool, initTool],
};

export default plugin;


async function runInit(args: string[]): Promise<void> {
  const isGlobal = args.includes('--global');
  const isForce = args.includes('--force');

  // Determine target directory
  const globalDir = path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? '.',
    '.config',
    'opencode',
  );
  const targetDir = isGlobal ? globalDir : process.cwd();

  console.log(`image-to-rive init v${TOOL_VERSION}`);
  console.log(`Target: ${targetDir}${isGlobal ? ' (global)' : ''}`);
  console.log('');

  // ── Step 1: Create .rive/ directory ──────────────────────────────────
  const riveDir = path.join(targetDir, '.rive');
  mkdirSync(riveDir, { recursive: true });
  console.log(`✔ Created ${riveDir}`);

  // ── Step 2: Write .rive/config.json ─────────────────────────────────
  const configPath = path.join(riveDir, 'config.json');
  if (existsSync(configPath) && !isForce) {
    console.log(`⊘ ${configPath} already exists (use --force to overwrite)`);
  } else {
    writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf8');
    console.log(`✔ Wrote ${configPath}`);
  }

  // ── Step 3: Append to AGENTS.md ─────────────────────────────────────
  const agentsPath = path.join(targetDir, 'AGENTS.md');
  const markedSection = `${AGENTS_MD_MARKER_START}\n${AGENTS_MD_SECTION}\n${AGENTS_MD_MARKER_END}`;

  if (existsSync(agentsPath)) {
    const existing = readFileSync(agentsPath, 'utf8');
    if (existing.includes(AGENTS_MD_MARKER_START)) {
      if (isForce) {
        // Replace existing section
        const re = new RegExp(
          `${escapeRegExp(AGENTS_MD_MARKER_START)}[\\s\\S]*?${escapeRegExp(AGENTS_MD_MARKER_END)}`,
        );
        const updated = existing.replace(re, markedSection);
        writeFileSync(agentsPath, updated, 'utf8');
        console.log(`✔ Updated Rive section in ${agentsPath}`);
      } else {
        console.log(`⊘ Rive section already exists in ${agentsPath} (use --force to replace)`);
      }
    } else {
      // Append new section
      const separator = existing.endsWith('\n') ? '\n' : '\n\n';
      writeFileSync(agentsPath, existing + separator + markedSection + '\n', 'utf8');
      console.log(`✔ Appended Rive section to ${agentsPath}`);
    }
  } else {
    // Create new AGENTS.md with only the Rive section
    writeFileSync(agentsPath, `# PROJECT KNOWLEDGE BASE\n\n${markedSection}\n`, 'utf8');
    console.log(`✔ Created ${agentsPath} with Rive section`);
  }

  // ── Step 4: Create output directory ─────────────────────────────────
  const outputDir = path.join(targetDir, DEFAULT_CONFIG.output_dir);
  mkdirSync(outputDir, { recursive: true });
  console.log(`✔ Created ${outputDir}`);

  // ── Step 5: Python dependency check ─────────────────────────────────
  console.log('');
  console.log('Checking Python dependencies...');
  const depResult = checkDependencies();
  const depsOk = depResult === 0;

  // ── Step 6: Locate plugin scripts ───────────────────────────────────
  // Find where segment.py and pose_estimate.py live relative to this CLI
  const cliDir = path.dirname(new URL(import.meta.url).pathname);
  const segmentPy = path.join(cliDir, '..', 'segment.py');
  const poseEstimatePy = path.join(cliDir, '..', 'pose_estimate.py');
  const scriptsFound = existsSync(segmentPy) && existsSync(poseEstimatePy);

  // ── Summary ─────────────────────────────────────────────────────────
  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log('  image-to-rive init — Summary');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Config       : ${configPath}`);
  console.log(`  AGENTS.md    : ${agentsPath}`);
  console.log(`  Output dir   : ${outputDir}`);
  console.log(`  Python deps  : ${depsOk ? 'OK' : 'MISSING — run: pip install -r requirements.txt'}`);
  console.log(`  Pipeline     : ${scriptsFound ? 'ready' : 'scripts not found at expected path'}`);
  console.log('═══════════════════════════════════════════════════');

  if (!depsOk) {
    console.log('');
    console.log('To install Python dependencies:');
    console.log('  pip install -r requirements.txt');
    console.log('  pip install -r requirements.optional.txt');
  }

  if (!scriptsFound) {
    console.log('');
    console.log('Python scripts (segment.py, pose_estimate.py) were not found next to the CLI.');
    console.log('If installed globally via npm, ensure the package includes these files.');
  }

  console.log('');
  console.log('Done. Your AI model can now see the Rive plugin capabilities in AGENTS.md.');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function main(argv: string[]): Promise<void> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printHelp();
    return;
  }

  if (argv[0] === 'check-deps') {
    process.exit(checkDependencies());
  }

  if (argv[0] === 'init') {
    await runInit(argv.slice(1));
    return;
  }

  if (argv[0] === 'convert') {
    await runConvertCli(argv.slice(1));
    return;
  }

  await runConvertCli(argv);
}

const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('cli.js') || process.argv[1].endsWith('cli.ts'));

if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
