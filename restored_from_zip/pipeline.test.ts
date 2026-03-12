import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolvePathWithinBase } from './cli.js';
import { runPoseStage } from './pipeline/stages/run-pose.js';
import { runSegmentationStage } from './pipeline/stages/run-segmentation.js';
import { validateBundleManifest } from './pipeline/validate-fixtures.js';
import { __test as pipelineInternals, runPipeline } from './pipeline.js';
import {
  RIVE_BINARY_WRITER_VERSION,
  type RiveWriterInput,
  writeRiveFile,
} from './rive-binary-writer.js';
import {
  ALL_PROPERTY_DEFS,
  getPropertiesForType,
  PROPERTY_BY_KEY,
  RIVE_MAGIC,
  RIVE_MAJOR_VERSION,
  RIVE_MINOR_VERSION,
  RiveBlendMode,
  RiveInterpolationType,
  RiveLoopType,
  RivePropertyKey,
  RiveTypeKey,
  RiveTypeParent,
  TocBackingType,
} from './rive-format-defs.js';
import { encodeVarint, getRiveWriterStatus } from './rive-writer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bunnyAsset = path.resolve(
  __dirname,
  '../tests/assets/ModelExpressions.png',
);

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeSyntheticPng(filePath: string): void {
  const script = `
from PIL import Image, ImageDraw
img = Image.new("RGBA", (240, 320), (255, 255, 255, 255))
draw = ImageDraw.Draw(img)
draw.ellipse((40, 40, 200, 220), fill=(140, 180, 120, 255))
draw.rectangle((90, 210, 150, 300), fill=(140, 180, 120, 255))
img.save("PLACEHOLDER")
  `
    .trim()
    .replace('PLACEHOLDER', filePath.replace(/\\/g, '\\\\'));
  const result = spawnSync(
    process.platform === 'win32' ? 'python' : 'python3',
    ['-c', script],
    {
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `Failed to create synthetic PNG: ${result.stderr || result.stdout}`,
    );
  }
}

function getPythonCommand(): string {
  return process.platform === 'win32' ? 'python' : 'python3';
}

function pythonHasModule(moduleName: string): boolean {
  const result = spawnSync(getPythonCommand(), ['-c', `import ${moduleName}`], {
    encoding: 'utf8',
  });
  return result.status === 0;
}

const hasCv2 = pythonHasModule('cv2');

test('segment help remains usable when optional rembg backend is unavailable', {
  skip: !hasCv2,
}, () => {
  const result = spawnSync(getPythonCommand(), ['segment.py', '--help'], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Segment image and generate mesh components/);
});

test('encodeVarint smoke', () => {
  assert.deepEqual(Array.from(encodeVarint(0)), [0x00]);
  assert.deepEqual(Array.from(encodeVarint(127)), [0x7f]);
  assert.deepEqual(Array.from(encodeVarint(128)), [0x80, 0x01]);
  assert.deepEqual(Array.from(encodeVarint(300)), [0xac, 0x02]);
});

test('rive writer is explicitly unsupported', () => {
  const status = getRiveWriterStatus();
  assert.equal(status.supported, false);
  assert.match(status.reason, /Validated `.riv` generation is disabled/);
});

test('pipeline smoke test on synthetic raster asset', {
  timeout: 120_000,
  skip: !hasCv2,
}, async () => {
  const tempDir = await makeTempDir('image-to-rive-smoke-');
  try {
    const input = path.join(tempDir, 'synthetic.png');
    const output = path.join(tempDir, 'synthetic.rivebundle');
    makeSyntheticPng(input);

    const result = await runPipeline({
      inputImage: input,
      outputBundle: output,
      meshDensity: 0.1,
      animations: ['idle'],
      sheetMode: 'single',
    });

    assert.equal(result.exportKind, 'rivebundle');
    assert.equal(result.exportStatus, 'fallback');
    assert.equal(result.artboardCount, 1);
    assert.ok(result.vertexCount > 3);
    assert.ok(result.triangleCount > 1);
    assert.ok(result.boneCount >= 4);

    const manifest = JSON.parse(await fs.readFile(result.manifestPath, 'utf8'));
    assert.equal(manifest.kind, 'rivebundle');

    await fs.access(path.join(output, 'artboards', 'subject_01', 'masked.png'));
    await fs.access(
      path.join(output, 'artboards', 'subject_01', 'rig-preview.svg'),
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('bunny sheet regression splits into six expressions', {
  timeout: 180_000,
  skip: !hasCv2,
}, async () => {
  const tempDir = await makeTempDir('image-to-rive-bunny-');
  try {
    const output = path.join(tempDir, 'bunny.rivebundle');

    const result = await runPipeline({
      inputImage: bunnyAsset,
      outputBundle: output,
      meshDensity: 0.08,
      animations: ['idle'],
      sheetMode: 'split',
    });

    assert.equal(result.artboardCount, 6);
    assert.ok(result.components.every((item) => item.vertexCount > 20));
    assert.ok(result.components.every((item) => item.triangleCount > 10));
    assert.ok(result.components.every((item) => item.boneCount >= 4));

    const manifest = JSON.parse(await fs.readFile(result.manifestPath, 'utf8'));
    assert.equal(manifest.input.component_count, 6);

    const stateMachine = JSON.parse(
      await fs.readFile(result.stateMachinePath, 'utf8'),
    );
    assert.equal(stateMachine.states.length, 6);

    for (let index = 1; index <= 6; index += 1) {
      const id = `expression_${String(index).padStart(2, '0')}`;
      await fs.access(path.join(output, 'artboards', id, 'masked.png'));
      await fs.access(path.join(output, 'artboards', id, 'mesh.svg'));
      await fs.access(path.join(output, 'artboards', id, 'rig-preview.svg'));
    }

    // Regression: expression ordering must be row-major (top-to-bottom, left-to-right)
    const artboards = manifest.artboards as Array<{
      id: string;
      sourceBounds: { x: number; y: number };
    }>;
    for (let i = 0; i < artboards.length - 1; i += 1) {
      const a = artboards[i]?.sourceBounds;
      const b = artboards[i + 1]?.sourceBounds;
      // Next artboard should be on the same row (to the right) or on a later row
      const sameRow = Math.abs(a.y - b.y) < 200;
      if (sameRow) {
        assert.ok(
          b.x > a.x,
          `expression_${String(i + 1).padStart(2, '0')} should be left of expression_${String(i + 2).padStart(2, '0')} within the same row`,
        );
      } else {
        assert.ok(
          b.y > a.y,
          `expression_${String(i + 2).padStart(2, '0')} should be on a later row than expression_${String(i + 1).padStart(2, '0')}`,
        );
      }
    }

    // Regression: state machine states should have display names
    for (const state of stateMachine.states) {
      assert.ok(
        typeof state.name === 'string' && state.name.length > 0,
        `state ${state.id} must have a display name`,
      );
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Error Path Tests
// ─────────────────────────────────────────────────────────────────────────────

test('rejects non-existent input file', async () => {
  const tempDir = await makeTempDir('image-to-rive-error-');
  try {
    const nonExistentPath = path.join(tempDir, 'does-not-exist.png');
    await assert.rejects(
      runPipeline({
        inputImage: nonExistentPath,
        outputBundle: path.join(tempDir, 'output.rivebundle'),
        meshDensity: 0.06,
        animations: ['idle'],
        sheetMode: 'single',
      }),
      /not found|does not exist|ENOENT/i,
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('rejects unsupported file extension', async () => {
  const tempDir = await makeTempDir('image-to-rive-error-');
  try {
    const invalidFile = path.join(tempDir, 'test.txt');
    await fs.writeFile(invalidFile, 'not an image');
    await assert.rejects(
      runPipeline({
        inputImage: invalidFile,
        outputBundle: path.join(tempDir, 'output.rivebundle'),
        meshDensity: 0.06,
        animations: ['idle'],
        sheetMode: 'single',
      }),
      /unsupported|extension|png|jpg|jpeg/i,
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('rejects invalid mesh density', () => {
  assert.throws(
    () =>
      pipelineInternals.normalizeOptions({
        inputImage: '/tmp/input.png',
        meshDensity: 0.5,
      }),
    /meshDensity|range|0\.01|0\.15/i,
  );
});

test('rejects invalid animation preset', () => {
  assert.throws(
    () =>
      pipelineInternals.normalizeOptions({
        inputImage: '/tmp/input.png',
        animations: ['invalid_preset' as 'idle'],
      }),
    /unsupported|animation|preset/i,
  );
});

test('generates animations with compatibility warnings for generic skeletons', {
  skip: !hasCv2,
}, async () => {
  const tempDir = await makeTempDir('image-to-rive-compat-');
  try {
    const input = path.join(tempDir, 'test.png');
    makeSyntheticPng(input);

    const result = await runPipeline({
      inputImage: input,
      outputBundle: path.join(tempDir, 'output.rivebundle'),
      meshDensity: 0.06,
      animations: ['walk', 'idle'], // walk requires limbs, generic skeleton may not have them
      sheetMode: 'single',
    });

    // Should complete but may have warnings
    assert.equal(result.exportKind, 'rivebundle');
    // Should still generate at least idle animation
    const normalizedAnimationNames = result.animationNames.map((name) =>
      name.toLowerCase(),
    );
    assert.ok(
      normalizedAnimationNames.includes('idle'),
      'should generate idle animation',
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('resolvePathWithinBase blocks symlink escape and parent traversal', async () => {
  if (process.platform === 'win32') {
    return;
  }

  const baseDir = await makeTempDir('image-to-rive-path-base-');
  const outsideDir = await makeTempDir('image-to-rive-path-outside-');
  try {
    const outsideFile = path.join(outsideDir, 'outside.txt');
    await fs.writeFile(outsideFile, 'outside', 'utf8');

    const symlinkPath = path.join(baseDir, 'linked-outside');
    await fs.symlink(outsideDir, symlinkPath, 'dir');

    assert.throws(
      () =>
        resolvePathWithinBase(
          baseDir,
          path.join('linked-outside', 'outside.txt'),
          {
            mustExist: true,
            purpose: 'input',
          },
        ),
      /Path traversal denied/i,
    );

    assert.throws(
      () =>
        resolvePathWithinBase(baseDir, '../escape.rivebundle', {
          mustExist: false,
          purpose: 'output',
        }),
      /Path traversal denied/i,
    );
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});

test('convert CLI rejects missing value for --output', async () => {
  const tempDir = await makeTempDir('image-to-rive-cli-');
  try {
    const cliPath = path.join(__dirname, 'cli.js');
    const result = spawnSync(
      process.execPath,
      [cliPath, 'convert', 'input.png', '--output', '--json'],
      {
        cwd: tempDir,
        encoding: 'utf8',
      },
    );

    assert.notEqual(result.status, 0);
    const combined = `${result.stdout}\n${result.stderr}`;
    assert.match(combined, /missing value for --output/i);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('convert CLI redirects .riv output request to .rivebundle with JSON contract', {
  timeout: 180_000,
  skip: !hasCv2,
}, async () => {
  const tempDir = await makeTempDir('image-to-rive-cli-riv-redirect-');
  try {
    const input = path.join(tempDir, 'synthetic.png');
    makeSyntheticPng(input);

    const requestedRivPath = path.join(tempDir, 'requested-output.riv');
    const cliPath = path.join(__dirname, 'cli.js');
    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        'convert',
        input,
        '--output',
        requestedRivPath,
        '--sheet-mode',
        'single',
        '--animations',
        'idle',
        '--json',
      ],
      {
        cwd: tempDir,
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;

    assert.equal(payload.exportKind, 'rivebundle');
    assert.equal(payload.exportStatus, 'fallback');

    assert.equal(typeof payload.bundlePath, 'string');
    const bundlePath = payload.bundlePath as string;
    assert.ok(
      bundlePath.endsWith('.rivebundle'),
      `Expected redirected bundle path to end with .rivebundle, got: ${bundlePath}`,
    );
    assert.notEqual(bundlePath, requestedRivPath);

    const warnings = payload.warnings;
    assert.ok(Array.isArray(warnings));
    assert.ok(
      warnings.some(
        (warning) =>
          typeof warning === 'string' && /fallback bundle/i.test(warning),
      ),
      `Expected fallback warning in warnings: ${JSON.stringify(warnings)}`,
    );

    await fs.access(bundlePath);
    await fs.access(path.join(bundlePath, 'bundle.json'));
    await assert.rejects(fs.access(requestedRivPath));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('runPipeline keeps explicit fallback semantics when outputFormat riv is requested', {
  timeout: 180_000,
  skip: !hasCv2,
}, async () => {
  const tempDir = await makeTempDir('image-to-rive-api-riv-fallback-');
  try {
    const input = path.join(tempDir, 'synthetic.png');
    makeSyntheticPng(input);

    const requestedRivPath = path.join(tempDir, 'requested-output.riv');
    const result = await runPipeline({
      inputImage: input,
      outputBundle: requestedRivPath,
      outputFormat: 'riv',
      meshDensity: 0.08,
      animations: ['idle'],
      sheetMode: 'single',
    });

    assert.equal(result.exportKind, 'rivebundle');
    assert.equal(result.exportStatus, 'fallback');
    assert.ok(result.bundlePath.endsWith('.rivebundle'));
    assert.notEqual(result.bundlePath, requestedRivPath);

    assert.ok(
      result.warnings.some(
        (warning) =>
          /outputFormat "riv"/i.test(warning) &&
          /falling back/i.test(warning) &&
          /\.rivebundle/i.test(warning),
      ),
      `Expected explicit outputFormat fallback warning: ${JSON.stringify(result.warnings)}`,
    );
    assert.ok(
      result.warnings.some((warning) => /fallback bundle/i.test(warning)),
      `Expected .riv-path fallback warning: ${JSON.stringify(result.warnings)}`,
    );

    const manifest = JSON.parse(
      await fs.readFile(result.manifestPath, 'utf8'),
    ) as {
      export?: {
        status?: string;
        output_format?: string;
      };
      input?: {
        requested_output_path?: string;
        actual_output_path?: string;
      };
    };

    assert.equal(manifest.export?.status, 'fallback');
    assert.equal(manifest.export?.output_format, 'rivebundle');
    assert.equal(
      manifest.input?.requested_output_path,
      path.resolve(requestedRivPath),
    );
    assert.equal(manifest.input?.actual_output_path, result.bundlePath);

    await fs.access(result.bundlePath);
    await assert.rejects(fs.access(requestedRivPath));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('runCommand enforces timeout and output caps', async () => {
  const timeoutResult = await pipelineInternals.runCommand(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 2000);'],
    {
      timeoutMs: 100,
      killGraceMs: 50,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
    },
  );

  assert.equal(timeoutResult.timedOut, true);
  assert.notEqual(timeoutResult.exitCode, 0);

  const outputCapResult = await pipelineInternals.runCommand(
    process.execPath,
    [
      '-e',
      "process.stdout.write('x'.repeat(200000)); setTimeout(() => {}, 2000);",
    ],
    {
      timeoutMs: 5_000,
      killGraceMs: 100,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
    },
  );

  assert.equal(outputCapResult.outputLimitExceeded, true);
  assert.ok(Buffer.byteLength(outputCapResult.stdout, 'utf8') <= 1024);
});

test('validateSegResult rejects out-of-bounds triangle indices', () => {
  const invalidSegPayload = {
    schema_version: 2,
    image_size: { w: 100, h: 100 },
    background_method: 'alpha',
    sheet: {
      component_count: 1,
      sheet_detected: false,
      ordering: 'row-major' as const,
    },
    components: [
      {
        id: 'subject_01',
        label: 'subject_01',
        source_bounds: { x: 0, y: 0, w: 100, h: 100 },
        image_size: { w: 100, h: 100 },
        masked_png_path: '/tmp/masked.png',
        contour: [
          [0, 0],
          [10, 0],
          [10, 10],
        ],
        mesh: {
          vertices: [
            { x: 0, y: 0, u: 0, v: 0 },
            { x: 10, y: 0, u: 1, v: 0 },
            { x: 0, y: 10, u: 0, v: 1 },
          ],
          triangles: [[0, 1, 3]],
          boundary_count: 3,
        },
        region_colors: ['#ffffff'],
        mask_stats: { area: 10, fill_ratio: 0.1 },
      },
    ],
    primary_component_index: 0,
  };

  assert.throws(
    () => pipelineInternals.validateSegResult(invalidSegPayload),
    /out of bounds/i,
  );
});

test('validateComponentConsistency rejects invalid weight invariants', () => {
  const component = {
    id: 'subject_01',
    label: 'subject_01',
    source_bounds: { x: 0, y: 0, w: 100, h: 100 },
    image_size: { w: 100, h: 100 },
    masked_png_path: '/tmp/masked.png',
    contour: [
      [0, 0],
      [10, 0],
      [10, 10],
    ] as [number, number][],
    mesh: {
      vertices: [
        { x: 0, y: 0, u: 0, v: 0 },
        { x: 10, y: 0, u: 1, v: 0 },
      ],
      triangles: [[0, 1, 1]] as [number, number, number][],
      boundary_count: 2,
    },
    region_colors: ['#ffffff'],
    mask_stats: { area: 10, fill_ratio: 0.1 },
  };

  const poseComponent = {
    id: 'subject_01',
    skeleton: {
      type: 'generic_centerline',
      confidence: 'fallback',
      bones: [
        {
          name: 'root',
          parent: null,
          role: 'root',
          x: 0,
          y: 0,
          rotation: 0,
          length: 0,
          start: { x: 0, y: 0 },
          end: { x: 0, y: 0 },
        },
      ],
    },
    vertex_weights: [{ root: 1 }],
  };

  assert.throws(
    () =>
      pipelineInternals.validateComponentConsistency(component, poseComponent),
    /weight rows/i,
  );
});

test('validateComponentConsistency accepts zero-valued bone weights', () => {
  const component = {
    id: 'subject_01',
    label: 'subject_01',
    source_bounds: { x: 0, y: 0, w: 100, h: 100 },
    image_size: { w: 100, h: 100 },
    masked_png_path: '/tmp/masked.png',
    contour: [
      [0, 0],
      [10, 0],
      [10, 10],
    ] as [number, number][],
    mesh: {
      vertices: [
        { x: 0, y: 0, u: 0, v: 0 },
        { x: 10, y: 0, u: 1, v: 0 },
      ],
      triangles: [[0, 1, 1]] as [number, number, number][],
      boundary_count: 2,
    },
    region_colors: ['#ffffff'],
    mask_stats: { area: 10, fill_ratio: 0.1 },
  };

  const poseComponent = {
    id: 'subject_01',
    skeleton: {
      type: 'generic_centerline',
      confidence: 'fallback',
      bones: [
        {
          name: 'root',
          parent: null,
          role: 'root',
          x: 0,
          y: 0,
          rotation: 0,
          length: 10,
          start: { x: 0, y: 0 },
          end: { x: 0, y: 10 },
        },
        {
          name: 'neck',
          parent: 'root',
          role: 'spine',
          x: 0,
          y: 10,
          rotation: 0,
          length: 5,
          start: { x: 0, y: 10 },
          end: { x: 0, y: 15 },
        },
      ],
    },
    vertex_weights: [
      { root: 1, neck: 0 },
      { root: 0.85, neck: 0.15 },
    ],
  };

  assert.doesNotThrow(() =>
    pipelineInternals.validateComponentConsistency(component, poseComponent),
  );
});

test('pose_estimate landmark guard rejects incomplete landmark payload', () => {
  const posePath = path.resolve(__dirname, '../pose_estimate.py');
  const script = `
import importlib.util
import sys

spec = importlib.util.spec_from_file_location('pose_estimate', ${JSON.stringify(posePath)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

class L:
    def __init__(self):
        self.x = 0.0
        self.y = 0.0

landmarks = [L() for _ in range(5)]

try:
    mod.landmarks_to_humanoid_skeleton(landmarks, (100, 100), {'x': 0, 'y': 0, 'w': 100, 'h': 100})
except ValueError as exc:
    print(str(exc))
    sys.exit(0)

print('expected ValueError for incomplete landmarks')
sys.exit(1)
`.trim();

  const result = spawnSync(getPythonCommand(), ['-c', script], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /incomplete|landmark payload/i);
});

test('generateAnimationPlanStage filters incompatible presets and records warnings', () => {
  const seg = {
    schema_version: 2,
    image_size: { w: 100, h: 100 },
    background_method: 'alpha',
    sheet: {
      component_count: 1,
      sheet_detected: false,
      ordering: 'row-major' as const,
    },
    components: [
      {
        id: 'subject_01',
        label: 'Subject 01',
        source_bounds: { x: 0, y: 0, w: 100, h: 100 },
        image_size: { w: 100, h: 100 },
        masked_png_path: '/tmp/masked.png',
        contour: [
          [0, 0],
          [50, 0],
          [0, 50],
        ] as [number, number][],
        mesh: {
          vertices: [
            { x: 0, y: 0, u: 0, v: 0 },
            { x: 50, y: 0, u: 1, v: 0 },
            { x: 0, y: 50, u: 0, v: 1 },
          ],
          triangles: [[0, 1, 2]] as [number, number, number][],
          boundary_count: 3,
        },
        region_colors: ['#ffffff'],
        mask_stats: { area: 100, fill_ratio: 0.5 },
      },
    ],
    primary_component_index: 0,
  };

  const pose = {
    schema_version: 2,
    components: [
      {
        id: 'subject_01',
        skeleton: {
          type: 'generic_centerline',
          confidence: 'fallback',
          bones: [
            {
              name: 'root',
              parent: null,
              role: 'root',
              x: 0,
              y: 0,
              rotation: 0,
              length: 0,
              start: { x: 0, y: 0 },
              end: { x: 0, y: 0 },
            },
          ],
        },
        vertex_weights: [{ root: 1 }, { root: 1 }, { root: 1 }],
      },
    ],
  };

  const ctx = {
    logs: [] as Array<{
      timestamp: string;
      level: 'info' | 'warn' | 'error';
      stage: string;
      message: string;
    }>,
    warnings: [] as string[],
    progress: () => undefined,
  };

  const plans = pipelineInternals.generateAnimationPlanStage(
    seg,
    pose,
    ['idle', 'walk', 'wave'],
    ctx,
  );
  const plan = plans[0]!;
  const loweredNames = plan.animationNames.map((name) => name.toLowerCase());

  assert.deepEqual(loweredNames, ['idle']);
  assert.ok(
    ctx.warnings.some((warning) =>
      /walk animation requires limb bones/i.test(warning),
    ),
  );
  assert.ok(
    ctx.warnings.some((warning) =>
      /wave animation requires arm bones/i.test(warning),
    ),
  );
});

test('replaceDirectoryAtomically restores the original bundle after a failed swap', async () => {
  const tempDir = await makeTempDir('image-to-rive-atomic-');
  try {
    const finalDir = path.join(tempDir, 'final.rivebundle');
    const preparedDir = path.join(tempDir, 'prepared.rivebundle');

    await fs.mkdir(finalDir, { recursive: true });
    await fs.writeFile(path.join(finalDir, 'old.txt'), 'old', 'utf8');

    await fs.mkdir(preparedDir, { recursive: true });
    await fs.writeFile(path.join(preparedDir, 'new.txt'), 'new', 'utf8');

    await assert.rejects(
      pipelineInternals.replaceDirectoryAtomically(finalDir, preparedDir, {
        moveDirectory: async (fromPath: string, toPath: string) => {
          if (fromPath === preparedDir && toPath === finalDir) {
            throw new Error('simulated final move failure');
          }
          await fs.rename(fromPath, toPath);
        },
      }),
      /simulated final move failure/i,
    );

    assert.equal(
      await fs.readFile(path.join(finalDir, 'old.txt'), 'utf8'),
      'old',
    );
    await assert.rejects(fs.access(path.join(finalDir, 'new.txt')));
    await assert.rejects(fs.access(preparedDir));
    await assert.rejects(fs.access(`${finalDir}.backup`));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('assertPathWithinDirectory rejects symlink escapes for pipeline artifacts', async () => {
  if (process.platform === 'win32') {
    return;
  }

  const baseDir = await makeTempDir('image-to-rive-stage-base-');
  const outsideDir = await makeTempDir('image-to-rive-stage-outside-');
  try {
    const outsideFile = path.join(outsideDir, 'masked.png');
    await fs.writeFile(outsideFile, 'outside', 'utf8');

    const symlinkDir = path.join(baseDir, 'linked');
    await fs.symlink(outsideDir, symlinkDir, 'dir');

    await assert.rejects(
      pipelineInternals.assertPathWithinDirectory(
        baseDir,
        path.join(symlinkDir, 'masked.png'),
        'masked_png_path',
      ),
      /escapes expected directory/i,
    );
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// P1: normalizeOutputBundlePath — output path normalization edge cases
// ─────────────────────────────────────────────────────────────────────────────

test('normalizeOutputBundlePath returns resolved path unchanged for .rivebundle', () => {
  const result = pipelineInternals.normalizeOutputBundlePath(
    '/tmp/input.png',
    '/tmp/out.rivebundle',
  );
  assert.equal(result.resolved, '/tmp/out.rivebundle');
  assert.equal(result.requested, '/tmp/out.rivebundle');
  assert.deepEqual(result.warnings, []);
});

test('normalizeOutputBundlePath redirects .riv to .rivebundle with warning', () => {
  const result = pipelineInternals.normalizeOutputBundlePath(
    '/tmp/input.png',
    '/tmp/out.riv',
  );
  assert.ok(
    result.resolved.endsWith('.rivebundle'),
    `resolved should end with .rivebundle, got ${result.resolved}`,
  );
  assert.ok(
    result.requested.endsWith('.riv'),
    `requested should retain .riv, got ${result.requested}`,
  );
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /fallback bundle/i);
});

test('normalizeOutputBundlePath appends .rivebundle for bare path with warning', () => {
  const result = pipelineInternals.normalizeOutputBundlePath(
    '/tmp/input.png',
    '/tmp/output',
  );
  assert.ok(
    result.resolved.endsWith('.rivebundle'),
    `resolved should end with .rivebundle, got ${result.resolved}`,
  );
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /\.rivebundle/i);
});

test('normalizeOutputBundlePath derives output from input when no outputBundle given', () => {
  const result =
    pipelineInternals.normalizeOutputBundlePath('/tmp/subject.png');
  assert.ok(
    result.resolved.endsWith('subject.rivebundle'),
    `resolved path should be derived from input name, got ${result.resolved}`,
  );
  assert.deepEqual(result.warnings, []);
});

test('normalizeOutputBundlePath treats .RIV (uppercase) as .riv redirect', () => {
  const result = pipelineInternals.normalizeOutputBundlePath(
    '/tmp/input.png',
    '/tmp/out.RIV',
  );
  assert.ok(
    result.resolved.endsWith('.rivebundle'),
    `uppercase .RIV should redirect to .rivebundle, got ${result.resolved}`,
  );
  assert.equal(result.warnings.length, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// P1: parseStatusJson — stdout parsing edge cases
// ─────────────────────────────────────────────────────────────────────────────

test('parseStatusJson returns undefined for empty stdout', () => {
  assert.equal(pipelineInternals.parseStatusJson(''), undefined);
  assert.equal(pipelineInternals.parseStatusJson('   \n  '), undefined);
});

test('parseStatusJson returns undefined for non-JSON stdout', () => {
  assert.equal(pipelineInternals.parseStatusJson('not json at all'), undefined);
  assert.equal(
    pipelineInternals.parseStatusJson(
      'Traceback (most recent call last):\n  File ...',
    ),
    undefined,
  );
});

test('parseStatusJson extracts trailing JSON from mixed stdout', () => {
  const stdout =
    'Loading model...\nProcessing frame 1/10\n{"status":"ok","count":3}';
  const result = pipelineInternals.parseStatusJson(stdout);
  assert.ok(result !== undefined);
  assert.equal(result?.status, 'ok');
  assert.equal(result?.count, 3);
});

test('parseStatusJson returns last valid JSON line when multiple lines are JSON', () => {
  const stdout = '{"status":"progress","pct":50}\n{"status":"ok","count":1}';
  const result = pipelineInternals.parseStatusJson(stdout);
  assert.ok(result !== undefined);
  assert.equal(result?.status, 'ok');
});

test('parseStatusJson handles JSON object at start of stdout', () => {
  const stdout = '{"status":"ok","data":42}';
  const result = pipelineInternals.parseStatusJson(stdout);
  assert.ok(result !== undefined);
  assert.equal(result?.status, 'ok');
});

// ─────────────────────────────────────────────────────────────────────────────
// P1: ensureImageExtension — extension validation edge cases
// ─────────────────────────────────────────────────────────────────────────────

test('ensureImageExtension accepts .png', () => {
  assert.doesNotThrow(() =>
    pipelineInternals.ensureImageExtension('/tmp/image.png'),
  );
});

test('ensureImageExtension accepts .jpg', () => {
  assert.doesNotThrow(() =>
    pipelineInternals.ensureImageExtension('/tmp/image.jpg'),
  );
});

test('ensureImageExtension accepts .jpeg', () => {
  assert.doesNotThrow(() =>
    pipelineInternals.ensureImageExtension('/tmp/image.jpeg'),
  );
});

test('ensureImageExtension accepts .PNG (uppercase)', () => {
  assert.doesNotThrow(() =>
    pipelineInternals.ensureImageExtension('/tmp/image.PNG'),
  );
});

test('ensureImageExtension accepts .JPEG (uppercase)', () => {
  assert.doesNotThrow(() =>
    pipelineInternals.ensureImageExtension('/tmp/image.JPEG'),
  );
});

test('ensureImageExtension rejects .gif', () => {
  assert.throws(
    () => pipelineInternals.ensureImageExtension('/tmp/image.gif'),
    /unsupported.*extension|expected PNG or JPG/i,
  );
});

test('ensureImageExtension rejects file with no extension', () => {
  assert.throws(
    () => pipelineInternals.ensureImageExtension('/tmp/imagefile'),
    /unsupported.*extension|expected PNG or JPG/i,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// P1: appendWithByteCap — byte-cap boundary conditions
// ─────────────────────────────────────────────────────────────────────────────

test('appendWithByteCap appends when under cap', () => {
  const result = pipelineInternals.appendWithByteCap('hello', ' world', 1024);
  assert.equal(result.next, 'hello world');
  assert.equal(result.truncated, false);
});

test('appendWithByteCap truncates when exactly at cap', () => {
  const current = 'a'.repeat(1024);
  const result = pipelineInternals.appendWithByteCap(current, 'overflow', 1024);
  assert.equal(result.truncated, true);
  assert.equal(result.next, current);
});

test('appendWithByteCap returns truncated=true when maxBytes is 0', () => {
  const result = pipelineInternals.appendWithByteCap('', 'anything', 0);
  assert.equal(result.truncated, true);
  assert.equal(result.next, '');
});

test('appendWithByteCap does not exceed cap on multibyte chunk', () => {
  // 'ü' is 2 bytes in UTF-8; cap of 3 bytes fits at most 1 'ü' (2 bytes), so truncation must happen
  const current = '';
  const result = pipelineInternals.appendWithByteCap(current, 'üüüü', 3);
  // The implementation slices at the byte boundary — result must be truncated
  assert.equal(
    result.truncated,
    true,
    'should report truncation for multibyte chunk exceeding cap',
  );
  // The full 4-char string is 8 bytes; output must be shorter
  const fullBytes = Buffer.byteLength('üüüü', 'utf8');
  const resultBytes = Buffer.byteLength(result.next, 'utf8');
  assert.ok(
    resultBytes < fullBytes,
    `Expected output shorter than full chunk (${resultBytes} < ${fullBytes})`,
  );
});

test('appendWithByteCap appends exactly when chunk fits exactly', () => {
  // 'abc' is exactly 3 bytes
  const result = pipelineInternals.appendWithByteCap('', 'abc', 3);
  assert.equal(result.next, 'abc');
  assert.equal(result.truncated, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// P1: normalizeOptions — validation paths not requiring Python
// ─────────────────────────────────────────────────────────────────────────────

test('normalizeOptions rejects meshDensity below minimum without Python', () => {
  assert.throws(
    () =>
      pipelineInternals.normalizeOptions({
        inputImage: '/tmp/input.png',
        meshDensity: 0.001,
      }),
    /meshDensity.*range|0\.01/i,
  );
});

test('normalizeOptions rejects meshDensity above maximum without Python', () => {
  assert.throws(
    () =>
      pipelineInternals.normalizeOptions({
        inputImage: '/tmp/input.png',
        meshDensity: 0.5,
      }),
    /meshDensity.*range|0\.15/i,
  );
});

test('normalizeOptions rejects unsupported animation preset without Python', () => {
  assert.throws(
    () =>
      pipelineInternals.normalizeOptions({
        inputImage: '/tmp/input.png',
        animations: ['invalid_preset' as 'idle'],
      }),
    /unsupported animation preset/i,
  );
});

test('normalizeOptions rejects empty animations array without Python', () => {
  assert.throws(
    () =>
      pipelineInternals.normalizeOptions({
        inputImage: '/tmp/input.png',
        animations: [],
      }),
    /at least one animation/i,
  );
});

test('normalizeOptions records warning for outputRiv compat alias', () => {
  const result = pipelineInternals.normalizeOptions({
    inputImage: '/tmp/input.png',
    outputRiv: '/tmp/out.riv',
  });
  assert.ok(result.warnings.some((w) => /fallback bundle/i.test(w)));
});

test('normalizeOptions records warning for embedImage compat option', () => {
  const result = pipelineInternals.normalizeOptions({
    inputImage: '/tmp/input.png',
    embedImage: true,
  });
  assert.ok(result.warnings.some((w) => /backward compatibility/i.test(w)));
});

// ─────────────────────────────────────────────────────────────────────────────
// P1: validateSegResult — schema validation failure paths
// ─────────────────────────────────────────────────────────────────────────────

test('validateSegResult rejects non-object input', () => {
  assert.throws(
    () => pipelineInternals.validateSegResult(null),
    /expected object/i,
  );
  assert.throws(
    () => pipelineInternals.validateSegResult('string'),
    /expected object/i,
  );
  assert.throws(
    () => pipelineInternals.validateSegResult(42),
    /expected object/i,
  );
});

test('validateSegResult rejects wrong schema_version', () => {
  assert.throws(
    () => pipelineInternals.validateSegResult({ schema_version: 1 }),
    /schema_version/i,
  );
});

test('validateSegResult rejects missing components array', () => {
  assert.throws(
    () =>
      pipelineInternals.validateSegResult({
        schema_version: 2,
        image_size: { w: 100, h: 100 },
        background_method: 'alpha',
        sheet: {
          component_count: 1,
          sheet_detected: false,
          ordering: 'row-major',
        },
        primary_component_index: 0,
      }),
    /components must be an array/i,
  );
});

test('validateSegResult rejects empty components array', () => {
  assert.throws(
    () =>
      pipelineInternals.validateSegResult({
        schema_version: 2,
        image_size: { w: 100, h: 100 },
        background_method: 'alpha',
        sheet: {
          component_count: 1,
          sheet_detected: false,
          ordering: 'row-major',
        },
        components: [],
        primary_component_index: 0,
      }),
    /must not be empty|component_count.*did not match|components array must not be empty/i,
  );
});

test('validateSegResult rejects missing mesh on component', () => {
  assert.throws(
    () =>
      pipelineInternals.validateSegResult({
        schema_version: 2,
        image_size: { w: 100, h: 100 },
        background_method: 'alpha',
        sheet: {
          component_count: 1,
          sheet_detected: false,
          ordering: 'row-major',
        },
        components: [
          {
            id: 'subject_01',
            label: 'subject_01',
            source_bounds: { x: 0, y: 0, w: 100, h: 100 },
            image_size: { w: 100, h: 100 },
            masked_png_path: '/tmp/masked.png',
            contour: [
              [0, 0],
              [10, 0],
              [0, 10],
            ],
            region_colors: ['#ffffff'],
            mask_stats: { area: 10, fill_ratio: 0.1 },
            // mesh intentionally omitted
          },
        ],
        primary_component_index: 0,
      }),
    /missing mesh/i,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// P1: validatePoseResult — schema validation failure paths
// ─────────────────────────────────────────────────────────────────────────────

test('validatePoseResult rejects non-object input', () => {
  assert.throws(
    () => pipelineInternals.validatePoseResult(null),
    /expected object/i,
  );
  assert.throws(
    () => pipelineInternals.validatePoseResult('string'),
    /expected object/i,
  );
});

test('validatePoseResult rejects wrong schema_version', () => {
  assert.throws(
    () => pipelineInternals.validatePoseResult({ schema_version: 1 }),
    /schema_version/i,
  );
});

test('validatePoseResult rejects missing components array', () => {
  assert.throws(
    () => pipelineInternals.validatePoseResult({ schema_version: 2 }),
    /components must be an array/i,
  );
});

test('validatePoseResult rejects component with missing skeleton', () => {
  assert.throws(
    () =>
      pipelineInternals.validatePoseResult({
        schema_version: 2,
        components: [{ id: 'subject_01' }],
      }),
    /missing skeleton/i,
  );
});

test('validatePoseResult rejects bone with duplicate name', () => {
  const makebone = (name: string) => ({
    name,
    parent: null,
    role: 'root',
    x: 0,
    y: 0,
    rotation: 0,
    length: 0,
    start: { x: 0, y: 0 },
    end: { x: 0, y: 0 },
  });
  assert.throws(
    () =>
      pipelineInternals.validatePoseResult({
        schema_version: 2,
        components: [
          {
            id: 'subject_01',
            skeleton: {
              type: 'generic_centerline',
              confidence: 'fallback',
              bones: [makebone('root'), makebone('root')],
            },
            vertex_weights: [],
          },
        ],
      }),
    /duplicate bone name/i,
  );
});

test('validatePoseResult rejects bone referencing unknown parent', () => {
  const makebone = (name: string, parent: string | null) => ({
    name,
    parent,
    role: name === 'root' ? 'root' : 'limb',
    x: 0,
    y: 0,
    rotation: 0,
    length: 0,
    start: { x: 0, y: 0 },
    end: { x: 0, y: 0 },
  });
  assert.throws(
    () =>
      pipelineInternals.validatePoseResult({
        schema_version: 2,
        components: [
          {
            id: 'subject_01',
            skeleton: {
              type: 'generic_centerline',
              confidence: 'fallback',
              bones: [makebone('root', null), makebone('arm', 'nonexistent')],
            },
            vertex_weights: [],
          },
        ],
      }),
    /unknown parent/i,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// P1: finalizeOutputStage — output assembly
// ─────────────────────────────────────────────────────────────────────────────

// Import finalizeOutputStage directly for unit testing without full pipeline
import { finalizeOutputStage } from './pipeline/stages/finalize-output.js';

test('finalizeOutputStage throws when bundle has no components', () => {
  const opts = pipelineInternals.normalizeOptions({
    inputImage: '/tmp/input.png',
  });
  const emptyBundle = {
    manifestPath: '/tmp/bundle/bundle.json',
    stateMachinePath: '/tmp/bundle/state_machine.json',
    importNotesPath: '/tmp/bundle/IMPORT_INTO_RIVE.md',
    logsPath: '/tmp/bundle/logs.json',
    animationPlans: [],
    components: [],
  };
  assert.throws(
    () => finalizeOutputStage(opts, emptyBundle, []),
    /primary artboard/i,
  );
});

test('finalizeOutputStage returns exportKind rivebundle and exportStatus fallback', () => {
  const opts = pipelineInternals.normalizeOptions({
    inputImage: '/tmp/input.png',
  });
  const component = {
    id: 'subject_01',
    name: 'Subject 01',
    bundleDir: 'artboards/subject_01',
    maskedImagePath: 'artboards/subject_01/masked.png',
    contourSvgPath: 'artboards/subject_01/contour.svg',
    meshSvgPath: 'artboards/subject_01/mesh.svg',
    rigPreviewPath: 'artboards/subject_01/rig-preview.svg',
    riveIrPath: 'artboards/subject_01/rive_ir.json',
    sourceBounds: { x: 0, y: 0, w: 100, h: 100 },
    artboardWidth: 100,
    artboardHeight: 100,
    boneCount: 4,
    vertexCount: 10,
    triangleCount: 8,
    skeletonType: 'generic_centerline',
  };
  const bundle = {
    manifestPath: '/tmp/bundle/bundle.json',
    stateMachinePath: '/tmp/bundle/state_machine.json',
    importNotesPath: '/tmp/bundle/IMPORT_INTO_RIVE.md',
    logsPath: '/tmp/bundle/logs.json',
    animationPlans: [
      {
        id: 'subject_01',
        label: 'Subject 01',
        boneNames: ['root'],
        animations: [],
        animationNames: ['idle'],
      },
    ],
    components: [component],
  };
  const result = finalizeOutputStage(opts, bundle, ['a warning']);
  assert.equal(result.exportKind, 'rivebundle');
  assert.equal(result.exportStatus, 'fallback');
  assert.equal(result.artboardCount, 1);
  assert.equal(result.primaryArtboardId, 'subject_01');
  assert.deepEqual(result.animationNames, ['idle']);
  assert.deepEqual(result.warnings, ['a warning']);
});

// ─────────────────────────────────────────────────────────────────────────────
// P2: runSegmentationStage — injectable _runScript unit tests
// ─────────────────────────────────────────────────────────────────────────────

const MINIMAL_SEG_RESULT = {
  schema_version: 2,
  image_size: { w: 100, h: 100 },
  background_method: 'alpha',
  sheet: { component_count: 1, sheet_detected: false, ordering: 'row-major' },
  primary_component_index: 0,
  components: [
    {
      id: 'subject_01',
      label: 'subject_01',
      source_bounds: { x: 0, y: 0, w: 100, h: 100 },
      image_size: { w: 100, h: 100 },
      masked_png_path: '',
      contour: [
        [0, 0],
        [10, 0],
        [0, 10],
      ],
      region_colors: ['#ffffff'],
      mask_stats: { area: 10, fill_ratio: 0.1 },
      mesh: {
        vertices: [
          { x: 0, y: 0, u: 0, v: 0 },
          { x: 10, y: 0, u: 1, v: 0 },
          { x: 0, y: 10, u: 0, v: 1 },
        ],
        triangles: [[0, 1, 2]],
        boundary_count: 3,
        weights: [{ bone_id: 'root', weights: [1, 1, 1] }],
      },
    },
  ],
};

test('runSegmentationStage propagates _runScript error', async () => {
  const tmpDir = await makeTempDir('seg-stage-');
  try {
    const opts = pipelineInternals.normalizeOptions({
      inputImage: '/tmp/input.png',
    });
    const ctx = {
      logs: [] as import('./pipeline/contracts.js').LogEntry[],
      warnings: [] as string[],
      progress: () => {},
    };
    const mockRun = async (): Promise<Record<string, unknown>> => {
      throw new Error('mock segmentation failure');
    };
    await assert.rejects(
      () => runSegmentationStage(opts, tmpDir, ctx, mockRun as never),
      /mock segmentation failure/,
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('runSegmentationStage rejects invalid payload from _runScript', async () => {
  const tmpDir = await makeTempDir('seg-stage-bad-');
  try {
    const opts = pipelineInternals.normalizeOptions({
      inputImage: '/tmp/input.png',
    });
    const ctx = {
      logs: [] as import('./pipeline/contracts.js').LogEntry[],
      warnings: [] as string[],
      progress: () => {},
    };
    // _runScript succeeds but writes invalid JSON to seg.json
    const mockRun = async (): Promise<Record<string, unknown>> => {
      await fs.writeFile(
        path.join(tmpDir, 'seg.json'),
        JSON.stringify({ schema_version: 99 }),
      );
      return {};
    };
    await assert.rejects(
      () => runSegmentationStage(opts, tmpDir, ctx, mockRun as never),
      /schema_version|version mismatch|expected/i,
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('runSegmentationStage validates masked_png_path is within artifactsDir', async () => {
  const tmpDir = await makeTempDir('seg-stage-path-');
  try {
    const opts = pipelineInternals.normalizeOptions({
      inputImage: '/tmp/input.png',
    });
    const ctx = {
      logs: [] as import('./pipeline/contracts.js').LogEntry[],
      warnings: [] as string[],
      progress: () => {},
    };
    const mockRun = async (): Promise<Record<string, unknown>> => {
      const payload = {
        ...MINIMAL_SEG_RESULT,
        components: [
          {
            ...MINIMAL_SEG_RESULT.components[0],
            masked_png_path: '/etc/passwd', // path outside artifactsDir
          },
        ],
      };
      await fs.writeFile(
        path.join(tmpDir, 'seg.json'),
        JSON.stringify(payload),
      );
      return {};
    };
    await assert.rejects(
      () => runSegmentationStage(opts, tmpDir, ctx, mockRun as never),
      /escapes expected directory|outside|path.*traversal/i,
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// P2: runPoseStage — injectable _runScript unit tests
// ─────────────────────────────────────────────────────────────────────────────

const MINIMAL_POSE_RESULT = {
  schema_version: 2,
  components: [
    {
      id: 'subject_01',
      label: 'subject_01',
      skeleton: {
        type: 'generic_centerline',
        confidence: 'high',
        bones: [
          {
            name: 'root',
            parent: null,
            role: 'root',
            x: 50,
            y: 75,
            rotation: 0,
            length: 50,
            start: { x: 50, y: 50 },
            end: { x: 50, y: 100 },
          },
        ],
        root_bone_id: 'root',
      },
      vertex_weights: [{ root: 1 }, { root: 1 }, { root: 1 }],
    },
  ],
};

test('runPoseStage propagates _runScript error', async () => {
  const tmpDir = await makeTempDir('pose-stage-');
  try {
    const opts = pipelineInternals.normalizeOptions({
      inputImage: '/tmp/input.png',
    });
    const ctx = {
      logs: [] as import('./pipeline/contracts.js').LogEntry[],
      warnings: [] as string[],
      progress: () => {},
    };
    const mockRun = async (): Promise<Record<string, unknown>> => {
      throw new Error('mock pose failure');
    };
    await assert.rejects(
      () => runPoseStage(opts, '/tmp/seg.json', tmpDir, ctx, mockRun as never),
      /mock pose failure/,
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('runPoseStage rejects invalid payload from _runScript', async () => {
  const tmpDir = await makeTempDir('pose-stage-bad-');
  try {
    const opts = pipelineInternals.normalizeOptions({
      inputImage: '/tmp/input.png',
    });
    const ctx = {
      logs: [] as import('./pipeline/contracts.js').LogEntry[],
      warnings: [] as string[],
      progress: () => {},
    };
    const mockRun = async (): Promise<Record<string, unknown>> => {
      await fs.writeFile(
        path.join(tmpDir, 'pose.json'),
        JSON.stringify({ schema_version: 99 }),
      );
      return {};
    };
    await assert.rejects(
      () => runPoseStage(opts, '/tmp/seg.json', tmpDir, ctx, mockRun as never),
      /schema_version|version mismatch|expected/i,
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('runPoseStage accepts valid payload and returns PoseResult', async () => {
  const tmpDir = await makeTempDir('pose-stage-ok-');
  try {
    const opts = pipelineInternals.normalizeOptions({
      inputImage: '/tmp/input.png',
    });
    const ctx = {
      logs: [] as import('./pipeline/contracts.js').LogEntry[],
      warnings: [] as string[],
      progress: () => {},
    };
    const mockRun = async (): Promise<Record<string, unknown>> => {
      await fs.writeFile(
        path.join(tmpDir, 'pose.json'),
        JSON.stringify(MINIMAL_POSE_RESULT),
      );
      return {};
    };
    const result = await runPoseStage(
      opts,
      '/tmp/seg.json',
      tmpDir,
      ctx,
      mockRun as never,
    );
    assert.equal(result.schema_version, 2);
    assert.equal(result.components.length, 1);
    assert.equal(result.components[0]?.id, 'subject_01');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Performance Baseline / Input Limit Tests
// ─────────────────────────────────────────────────────────────────────────────

test('rejects artboardWidth above MAX_ARTBOARD_DIMENSION', () => {
  assert.throws(
    () =>
      pipelineInternals.normalizeOptions({
        inputImage: '/tmp/input.png',
        artboardWidth: 9999,
      }),
    /artboardWidth|8192/i,
  );
});

test('rejects artboardHeight above MAX_ARTBOARD_DIMENSION', () => {
  assert.throws(
    () =>
      pipelineInternals.normalizeOptions({
        inputImage: '/tmp/input.png',
        artboardHeight: 9999,
      }),
    /artboardHeight|8192/i,
  );
});

test('accepts artboardWidth and artboardHeight at MAX_ARTBOARD_DIMENSION boundary', () => {
  assert.doesNotThrow(() =>
    pipelineInternals.normalizeOptions({
      inputImage: '/tmp/input.png',
      artboardWidth: 8192,
      artboardHeight: 8192,
    }),
  );
});

test('rejects input image exceeding MAX_INPUT_FILE_BYTES', async () => {
  const tempDir = await makeTempDir('image-to-rive-size-');
  try {
    const bigFile = path.join(tempDir, 'too-big.png');
    // Write a 1-byte-over-limit file (50 MB + 1 byte)
    const MAX = 50 * 1024 * 1024;
    const buf = Buffer.alloc(MAX + 1, 0);
    await fs.writeFile(bigFile, buf);
    // Rename with .png so extension check passes; file access will succeed
    await assert.rejects(
      runPipeline({
        inputImage: bigFile,
        outputBundle: path.join(tempDir, 'out.rivebundle'),
        animations: ['idle'],
      }),
      /exceeds.*maximum|50 MB|MAX_INPUT_FILE_BYTES/i,
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('rejects meshDensity below MIN_MESH_DENSITY', () => {
  assert.throws(
    () =>
      pipelineInternals.normalizeOptions({
        inputImage: '/tmp/input.png',
        meshDensity: 0.001,
      }),
    /meshDensity|range|0\.01/i,
  );
});

test('rejects meshDensity above MAX_MESH_DENSITY', () => {
  assert.throws(
    () =>
      pipelineInternals.normalizeOptions({
        inputImage: '/tmp/input.png',
        meshDensity: 0.2,
      }),
    /meshDensity|range|0\.15/i,
  );
});

// ---------------------------------------------------------------------------
// P4.1 — validateBundleManifest unit tests
// ---------------------------------------------------------------------------

const minimalValidManifest = () => ({
  schema_version: 1,
  kind: 'rivebundle',
  export: {
    status: 'fallback',
    output_format: 'rivebundle',
    riv_supported: false,
  },
  config: { mesh_density: 0.06 },
  primary_artboard_id: 'ab_01',
  artboards: [
    {
      id: 'ab_01',
      vertexCount: 10,
      triangleCount: 8,
      boneCount: 4,
      maskedImagePath: 'bundle/ab_01/masked.png',
      contourSvgPath: 'bundle/ab_01/contour.svg',
      meshSvgPath: 'bundle/ab_01/mesh.svg',
      rigPreviewPath: 'bundle/ab_01/rig-preview.svg',
      riveIrPath: 'bundle/ab_01/rive_ir.json',
      artboardWidth: 100,
      artboardHeight: 100,
    },
  ],
});

test('validateBundleManifest: accepts a minimal valid single-artboard manifest', () => {
  assert.doesNotThrow(() => validateBundleManifest(minimalValidManifest()));
});

test('validateBundleManifest: accepts a 6-artboard sheet manifest', () => {
  const m = {
    ...minimalValidManifest(),
    primary_artboard_id: 'ab_01',
    artboards: Array.from({ length: 6 }, (_, idx) => ({
      id: `ab_0${idx + 1}`,
      vertexCount: 10 + idx,
      triangleCount: 8 + idx,
      boneCount: 4,
      maskedImagePath: `bundle/ab_0${idx + 1}/masked.png`,
      contourSvgPath: `bundle/ab_0${idx + 1}/contour.svg`,
      meshSvgPath: `bundle/ab_0${idx + 1}/mesh.svg`,
      rigPreviewPath: `bundle/ab_0${idx + 1}/rig-preview.svg`,
      riveIrPath: `bundle/ab_0${idx + 1}/rive_ir.json`,
      artboardWidth: 120,
      artboardHeight: 120,
    })),
  };
  assert.doesNotThrow(() => validateBundleManifest(m));
});

test('validateBundleManifest: rejects artboard missing a required path field', () => {
  const m = minimalValidManifest();
  delete (m.artboards[0] as Record<string, unknown>).maskedImagePath;
  assert.throws(
    () => validateBundleManifest(m),
    /maskedImagePath.*non-empty string/i,
  );
});

test('validateBundleManifest: rejects artboard with empty path field', () => {
  const m = minimalValidManifest();
  (m.artboards[0] as Record<string, unknown>).contourSvgPath = '';
  assert.throws(
    () => validateBundleManifest(m),
    /contourSvgPath.*non-empty string/i,
  );
});

test('validateBundleManifest: rejects duplicate artboard ids', () => {
  const m = minimalValidManifest();
  m.artboards.push({
    ...(m.artboards[0] as object),
  } as (typeof m.artboards)[0]);
  assert.throws(() => validateBundleManifest(m), /Duplicate artboard id/i);
});

test('validateBundleManifest: rejects primary_artboard_id referencing unknown artboard', () => {
  const m = {
    ...minimalValidManifest(),
    primary_artboard_id: 'does_not_exist',
  };
  assert.throws(
    () => validateBundleManifest(m),
    /primary_artboard_id.*does not reference/i,
  );
});

test('validateBundleManifest: rejects config.mesh_density below MIN_MESH_DENSITY', () => {
  const m = minimalValidManifest();
  (m.config as Record<string, unknown>).mesh_density = 0.001;
  assert.throws(
    () => validateBundleManifest(m),
    /mesh_density.*outside.*allowed range/i,
  );
});

test('validateBundleManifest: rejects artboard with artboardWidth above MAX_ARTBOARD_DIMENSION', () => {
  const m = minimalValidManifest();
  (m.artboards[0] as Record<string, unknown>).artboardWidth = 99999;
  assert.throws(() => validateBundleManifest(m), /artboardWidth.*between 1/i);
});

// ─── P4.3: SLO / stageTimeoutMs tests ──────────────────────────────────────

test('normalizeOptions accepts stageTimeoutMs and stores in commandLimits', () => {
  const { normalizeOptions } = pipelineInternals;
  const opts = normalizeOptions({
    inputImage: '/fake/image.png',
    stageTimeoutMs: 30_000,
  });
  assert.equal(opts.commandLimits.timeoutMs, 30_000);
});

test('normalizeOptions rejects non-positive stageTimeoutMs', () => {
  const { normalizeOptions } = pipelineInternals;
  assert.throws(
    () =>
      normalizeOptions({ inputImage: '/fake/image.png', stageTimeoutMs: 0 }),
    /stageTimeoutMs must be a positive integer/i,
  );
  assert.throws(
    () =>
      normalizeOptions({ inputImage: '/fake/image.png', stageTimeoutMs: -500 }),
    /stageTimeoutMs must be a positive integer/i,
  );
});

test('runSegmentationStage passes commandLimits timeout to _runScript', async () => {
  const { normalizeOptions } = pipelineInternals;
  const opts = normalizeOptions({
    inputImage: '/fake/image.png',
    stageTimeoutMs: 12_345,
  });
  let capturedLimitsOverride: Record<string, unknown> | undefined;
  const mockScript = async (
    _scriptName: string,
    _args: string[],
    _stage: string,
    _logs: unknown[],
    limitsOverride?: Partial<{ timeoutMs: number }>,
  ): Promise<Record<string, unknown>> => {
    capturedLimitsOverride = limitsOverride as Record<string, unknown>;
    return {
      status: 'ok',
      schema_version: 1,
      image_size: { w: 10, h: 10 },
      background_method: 'test',
      sheet: {
        component_count: 1,
        sheet_detected: false,
        ordering: 'row-major' as const,
      },
      components: [],
      primary_component_index: 0,
    };
  };
  const ctx = { logs: [], warnings: [], progress: () => undefined };
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'slo-test-'));
  try {
    await import('./pipeline/stages/run-segmentation.js').then(
      ({ runSegmentationStage: rs }) =>
        rs(opts, tmpDir, ctx, mockScript as Parameters<typeof rs>[3]).catch(
          () => undefined,
        ),
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
  assert.ok(
    capturedLimitsOverride !== undefined,
    'limitsOverride should be passed',
  );
  assert.equal(
    (capturedLimitsOverride as { timeoutMs: number }).timeoutMs,
    12_345,
  );
});

// ─── P4.2: Cross-platform Python path tests ──────────────────────────────────

test('getPythonCandidates respects PYTHON env var override', () => {
  const { getPythonCandidates } = pipelineInternals;
  const original = process.env.PYTHON;
  try {
    process.env.PYTHON = '/usr/local/bin/my-python';
    const candidates = getPythonCandidates();
    assert.equal(candidates[0], '/usr/local/bin/my-python');
  } finally {
    if (original === undefined) {
      delete process.env.PYTHON;
    } else {
      process.env.PYTHON = original;
    }
  }
});

test('getPythonCandidates omits blank PYTHON env var', () => {
  const { getPythonCandidates } = pipelineInternals;
  const original = process.env.PYTHON;
  try {
    process.env.PYTHON = '   ';
    const candidates = getPythonCandidates();
    assert.ok(
      !candidates.includes('   '),
      'blank env var should be filtered out',
    );
  } finally {
    if (original === undefined) {
      delete process.env.PYTHON;
    } else {
      process.env.PYTHON = original;
    }
  }
});

test('getPythonCandidates always includes python as fallback', () => {
  const { getPythonCandidates } = pipelineInternals;
  const original = process.env.PYTHON;
  try {
    delete process.env.PYTHON;
    const candidates = getPythonCandidates();
    assert.ok(
      candidates.includes('python'),
      'should always include "python" as fallback',
    );
  } finally {
    if (original === undefined) {
      delete process.env.PYTHON;
    } else {
      process.env.PYTHON = original;
    }
  }
});

test('resolvePythonScript throws descriptive error when script not found', () => {
  const { resolvePythonScript } = pipelineInternals;
  assert.throws(
    () => resolvePythonScript('does_not_exist_script.py'),
    /Unable to resolve Python script/i,
  );
});

// ---------------------------------------------------------------------------
// rive-format-defs.ts tests
// ---------------------------------------------------------------------------

test('RIVE_MAGIC is 4-byte ASCII "RIVE"', () => {
  assert.equal(RIVE_MAGIC.length, 4);
  const decoded = new TextDecoder().decode(RIVE_MAGIC);
  assert.equal(decoded, 'RIVE');
  assert.equal(RIVE_MAGIC[0], 0x52);
  assert.equal(RIVE_MAGIC[1], 0x49);
  assert.equal(RIVE_MAGIC[2], 0x56);
  assert.equal(RIVE_MAGIC[3], 0x45);
});

test('RIVE_MAJOR_VERSION is 7', () => {
  assert.equal(RIVE_MAJOR_VERSION, 7);
});

test('TocBackingType has exactly 4 entries with values 0-3', () => {
  assert.equal(TocBackingType.Uint, 0);
  assert.equal(TocBackingType.String, 1);
  assert.equal(TocBackingType.Float, 2);
  assert.equal(TocBackingType.Color, 3);
  assert.equal(Object.keys(TocBackingType).length, 4);
});

test('RiveTypeKey: critical type keys match official core defs', () => {
  // These values are from the official Rive core definition JSON files.
  // Changing them would produce invalid .riv files.
  assert.equal(RiveTypeKey.Artboard, 1);
  assert.equal(RiveTypeKey.Node, 2);
  assert.equal(RiveTypeKey.Shape, 3);
  assert.equal(RiveTypeKey.Component, 10);
  assert.equal(RiveTypeKey.ContainerComponent, 11);
  assert.equal(RiveTypeKey.Drawable, 13);
  assert.equal(RiveTypeKey.Backboard, 23);
  assert.equal(RiveTypeKey.KeyedObject, 25);
  assert.equal(RiveTypeKey.KeyedProperty, 26);
  assert.equal(RiveTypeKey.Animation, 27);
  assert.equal(RiveTypeKey.KeyFrame, 29);
  assert.equal(RiveTypeKey.KeyFrameDouble, 30);
  assert.equal(RiveTypeKey.LinearAnimation, 31);
  assert.equal(RiveTypeKey.TransformComponent, 38);
  assert.equal(RiveTypeKey.SkeletalComponent, 39);
  assert.equal(RiveTypeKey.Bone, 40);
  assert.equal(RiveTypeKey.RootBone, 41);
  assert.equal(RiveTypeKey.Skin, 43);
  assert.equal(RiveTypeKey.Tendon, 44);
  assert.equal(RiveTypeKey.KeyFrameId, 50);
  assert.equal(RiveTypeKey.WorldTransformComponent, 91);
  assert.equal(RiveTypeKey.Asset, 99);
  assert.equal(RiveTypeKey.Image, 100);
  assert.equal(RiveTypeKey.FileAsset, 103);
  assert.equal(RiveTypeKey.DrawableAsset, 104);
  assert.equal(RiveTypeKey.ImageAsset, 105);
  assert.equal(RiveTypeKey.Vertex, 107);
  assert.equal(RiveTypeKey.MeshVertex, 108);
  assert.equal(RiveTypeKey.Mesh, 109);
  assert.equal(RiveTypeKey.CubicInterpolator, 139);
  assert.equal(RiveTypeKey.InterpolatingKeyFrame, 170);
  assert.equal(RiveTypeKey.KeyFrameInterpolator, 175);
  assert.equal(RiveTypeKey.LayoutComponent, 409);
});

test('RiveTypeKey: all values are unique positive integers', () => {
  const values = Object.values(RiveTypeKey);
  const unique = new Set(values);
  assert.equal(values.length, unique.size, 'type key values must be unique');
  for (const v of values) {
    assert.ok(
      Number.isInteger(v) && v > 0,
      `expected positive integer, got ${v}`,
    );
  }
});

test('RivePropertyKey: critical property keys match official core defs', () => {
  assert.equal(RivePropertyKey.name.key, 4);
  assert.equal(RivePropertyKey.parentId.key, 5);
  assert.equal(RivePropertyKey.width.key, 7);
  assert.equal(RivePropertyKey.height.key, 8);
  assert.equal(RivePropertyKey.node_x.key, 13);
  assert.equal(RivePropertyKey.node_y.key, 14);
  assert.equal(RivePropertyKey.rotation.key, 15);
  assert.equal(RivePropertyKey.scaleX.key, 16);
  assert.equal(RivePropertyKey.scaleY.key, 17);
  assert.equal(RivePropertyKey.opacity.key, 18);
  assert.equal(RivePropertyKey.fps.key, 56);
  assert.equal(RivePropertyKey.duration.key, 57);
  assert.equal(RivePropertyKey.frame.key, 67);
  assert.equal(RivePropertyKey.keyFrameDouble_value.key, 70);
  assert.equal(RivePropertyKey.bone_length.key, 89);
  assert.equal(RivePropertyKey.rootBone_x.key, 90);
  assert.equal(RivePropertyKey.rootBone_y.key, 91);
  assert.equal(RivePropertyKey.tendon_boneId.key, 95);
  assert.equal(RivePropertyKey.meshVertex_u.key, 215);
  assert.equal(RivePropertyKey.meshVertex_v.key, 216);
  assert.equal(RivePropertyKey.triangleIndexBytes.key, 223);
  assert.equal(RivePropertyKey.image_assetId.key, 206);
  assert.equal(RivePropertyKey.image_originX.key, 380);
  assert.equal(RivePropertyKey.image_originY.key, 381);
});

test('RivePropertyKey: all property key values are unique positive integers', () => {
  const keys = ALL_PROPERTY_DEFS.map((d) => d.key);
  const unique = new Set(keys);
  assert.equal(keys.length, unique.size, 'property key values must be unique');
  for (const k of keys) {
    assert.ok(
      Number.isInteger(k) && k > 0,
      `expected positive integer, got ${k}`,
    );
  }
});

test('RivePropertyKey: every backingType is a valid ToC code (0-3)', () => {
  const validCodes = new Set([0, 1, 2, 3]);
  for (const def of ALL_PROPERTY_DEFS) {
    assert.ok(
      validCodes.has(def.backingType),
      `property ${def.field} (key ${def.key}) has invalid backingType ${def.backingType}`,
    );
  }
});

test('RivePropertyKey: every owner references a valid RiveTypeKey', () => {
  for (const def of ALL_PROPERTY_DEFS) {
    assert.ok(
      def.owner in RiveTypeKey,
      `property ${def.field} (key ${def.key}) has unknown owner "${def.owner}"`,
    );
  }
});

test('RiveTypeParent: every parent references a valid RiveTypeKey or is null', () => {
  for (const [typeName, parent] of Object.entries(RiveTypeParent)) {
    assert.ok(
      typeName in RiveTypeKey,
      `RiveTypeParent has unknown type "${typeName}"`,
    );
    if (parent !== null) {
      assert.ok(
        parent in RiveTypeKey,
        `type "${typeName}" has unknown parent "${parent}"`,
      );
    }
  }
});

test('RiveTypeParent: no circular inheritance chains', () => {
  for (const startType of Object.keys(RiveTypeParent) as Array<
    keyof typeof RiveTypeKey
  >) {
    const visited = new Set<string>();
    let current: keyof typeof RiveTypeKey | null = startType;
    while (current !== null) {
      assert.ok(
        !visited.has(current),
        `circular inheritance detected at "${current}" starting from "${startType}"`,
      );
      visited.add(current);
      current = RiveTypeParent[current];
    }
  }
});

test('RiveTypeParent: animation inheritance matches runtime defs', () => {
  assert.equal(RiveTypeParent.LinearAnimation, 'Animation');
  assert.equal(RiveTypeParent.CubicInterpolator, 'KeyFrameInterpolator');
  assert.equal(RiveTypeParent.KeyFrameInterpolator, null);
});

test('PROPERTY_BY_KEY maps are consistent with ALL_PROPERTY_DEFS', () => {
  assert.equal(PROPERTY_BY_KEY.size, ALL_PROPERTY_DEFS.length);
  for (const def of ALL_PROPERTY_DEFS) {
    assert.equal(PROPERTY_BY_KEY.get(def.key), def);
  }
});

test('getPropertiesForType returns own + inherited properties for Bone', () => {
  const boneProps = getPropertiesForType('Bone');
  const boneFields = boneProps.map((d) => `${d.owner}.${d.field}`);
  // Bone own property
  assert.ok(
    boneFields.includes('Bone.length'),
    'Bone should have own "length" property',
  );
  // Inherited from TransformComponent (via SkeletalComponent)
  assert.ok(
    boneFields.includes('TransformComponent.rotation'),
    'Bone should inherit rotation',
  );
  assert.ok(
    boneFields.includes('TransformComponent.scaleX'),
    'Bone should inherit scaleX',
  );
  // Inherited from Component (via WorldTransformComponent -> ContainerComponent -> Component)
  assert.ok(boneFields.includes('Component.name'), 'Bone should inherit name');
  assert.ok(
    boneFields.includes('Component.parentId'),
    'Bone should inherit parentId',
  );
});

test('getPropertiesForType returns own + inherited properties for MeshVertex', () => {
  const mvProps = getPropertiesForType('MeshVertex');
  const mvFields = mvProps.map((d) => `${d.owner}.${d.field}`);
  // MeshVertex own
  assert.ok(
    mvFields.includes('MeshVertex.u'),
    'MeshVertex should have own "u"',
  );
  assert.ok(
    mvFields.includes('MeshVertex.v'),
    'MeshVertex should have own "v"',
  );
  // Inherited from Vertex
  assert.ok(
    mvFields.includes('Vertex.x'),
    'MeshVertex should inherit vertex x',
  );
  assert.ok(
    mvFields.includes('Vertex.y'),
    'MeshVertex should inherit vertex y',
  );
  // Inherited from Component (via ContainerComponent)
  assert.ok(
    mvFields.includes('Component.name'),
    'MeshVertex should inherit name',
  );
  assert.ok(
    mvFields.includes('Component.parentId'),
    'MeshVertex should inherit parentId',
  );
});

test('RiveInterpolationType has Hold=0, Linear=1, Cubic=2', () => {
  assert.equal(RiveInterpolationType.Hold, 0);
  assert.equal(RiveInterpolationType.Linear, 1);
  assert.equal(RiveInterpolationType.Cubic, 2);
});

test('RiveLoopType has OneShot=0, Loop=1, PingPong=2', () => {
  assert.equal(RiveLoopType.OneShot, 0);
  assert.equal(RiveLoopType.Loop, 1);
  assert.equal(RiveLoopType.PingPong, 2);
});

test('RiveBlendMode.SrcOver is 3 (default normal blend)', () => {
  assert.equal(RiveBlendMode.SrcOver, 3);
});

function readVarUint(
  bytes: Uint8Array,
  offset: number,
): { value: number; nextOffset: number } {
  let value = 0;
  let shift = 0;
  let cursor = offset;

  while (true) {
    if (cursor >= bytes.length) {
      throw new Error('Varuint read overflow.');
    }

    const byte = bytes[cursor]!;
    cursor += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: value >>> 0, nextOffset: cursor };
    }

    shift += 7;
    if (shift > 35) {
      throw new Error('Invalid varuint sequence.');
    }
  }
}

interface ParsedRuntimeHeader {
  major: number;
  minor: number;
  fileId: number;
  propertyKeys: number[];
  backingByKey: Map<number, number>;
  objectStreamOffset: number;
}

function parseRuntimeHeader(bytes: Uint8Array): ParsedRuntimeHeader {
  assert.deepEqual(Array.from(bytes.slice(0, 4)), Array.from(RIVE_MAGIC));

  let offset = 4;
  const major = readVarUint(bytes, offset);
  offset = major.nextOffset;
  const minor = readVarUint(bytes, offset);
  offset = minor.nextOffset;
  const fileId = readVarUint(bytes, offset);
  offset = fileId.nextOffset;

  const propertyKeys: number[] = [];
  while (true) {
    const key = readVarUint(bytes, offset);
    offset = key.nextOffset;
    if (key.value === 0) {
      break;
    }
    propertyKeys.push(key.value);
  }

  const backingByKey = new Map<number, number>();
  let bitOffset = 8;
  let packedWord = 0;
  for (const propertyKey of propertyKeys) {
    if (bitOffset === 8) {
      if (offset + 4 > bytes.length) {
        throw new Error('ToC backing map overflow.');
      }

      packedWord = new DataView(
        bytes.buffer,
        bytes.byteOffset + offset,
        4,
      ).getUint32(0, true);
      offset += 4;
      bitOffset = 0;
    }

    const backingType = (packedWord >> bitOffset) & 0b11;
    backingByKey.set(propertyKey, backingType);
    bitOffset += 2;
  }

  return {
    major: major.value,
    minor: minor.value,
    fileId: fileId.value,
    propertyKeys,
    backingByKey,
    objectStreamOffset: offset,
  };
}

interface ParsedRiveObject {
  typeKey: number;
  properties: Map<number, unknown>;
}

function parseObjectStream(
  bytes: Uint8Array,
  offset: number,
  backingByKey: Map<number, number>,
): ParsedRiveObject[] {
  const objects: ParsedRiveObject[] = [];
  let cursor = offset;

  while (cursor < bytes.length) {
    if (cursor === bytes.length - 1 && bytes[cursor] === 0) {
      break;
    }

    const type = readVarUint(bytes, cursor);
    cursor = type.nextOffset;

    const properties = new Map<number, unknown>();
    while (true) {
      const key = readVarUint(bytes, cursor);
      cursor = key.nextOffset;

      if (key.value === 0) {
        break;
      }

      const backingType = backingByKey.get(key.value);
      if (backingType === undefined) {
        throw new Error(
          `Missing ToC backing type for property key ${key.value}.`,
        );
      }

      if (backingType === TocBackingType.Uint) {
        const value = readVarUint(bytes, cursor);
        cursor = value.nextOffset;
        properties.set(key.value, value.value);
      } else if (backingType === TocBackingType.String) {
        const length = readVarUint(bytes, cursor);
        cursor = length.nextOffset;
        const end = cursor + length.value;
        if (end > bytes.length) {
          throw new Error(
            'String payload overflow while parsing object stream.',
          );
        }
        properties.set(key.value, bytes.slice(cursor, end));
        cursor = end;
      } else if (backingType === TocBackingType.Float) {
        if (cursor + 4 > bytes.length) {
          throw new Error(
            'Float payload overflow while parsing object stream.',
          );
        }
        const value = new DataView(
          bytes.buffer,
          bytes.byteOffset + cursor,
          4,
        ).getFloat32(0, true);
        cursor += 4;
        properties.set(key.value, value);
      } else if (backingType === TocBackingType.Color) {
        if (cursor + 4 > bytes.length) {
          throw new Error(
            'Color payload overflow while parsing object stream.',
          );
        }
        const value = new DataView(
          bytes.buffer,
          bytes.byteOffset + cursor,
          4,
        ).getUint32(0, true);
        cursor += 4;
        properties.set(key.value, value);
      } else {
        throw new Error(`Unsupported backing type ${backingType}.`);
      }
    }

    objects.push({ typeKey: type.value, properties });
  }

  return objects;
}

function decodeVarUintSequence(payload: Uint8Array): number[] {
  const values: number[] = [];
  let offset = 0;

  while (offset < payload.length) {
    const next = readVarUint(payload, offset);
    values.push(next.value);
    offset = next.nextOffset;
  }

  return values;
}

function decodeUtf8(value: unknown): string {
  assert.ok(value instanceof Uint8Array, 'Expected Uint8Array string payload.');
  return new TextDecoder().decode(value);
}

async function loadRiveRuntimeForHarness(): Promise<{
  load: (bytes: Uint8Array) => Promise<unknown>;
}> {
  (globalThis as Record<string, unknown>).document = {
    currentScript: { src: '' },
    createElement: () => ({
      style: {},
      getContext: () => null,
    }),
    body: {
      appendChild: () => undefined,
      remove: () => undefined,
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };

  const runtimeModule = (await import('@rive-app/canvas-lite')) as {
    RuntimeLoader?: {
      awaitInstance: () => Promise<{
        load: (bytes: Uint8Array) => Promise<unknown>;
      }>;
    };
    default?: {
      RuntimeLoader?: {
        awaitInstance: () => Promise<{
          load: (bytes: Uint8Array) => Promise<unknown>;
        }>;
      };
    };
  };

  const runtimeLoader =
    runtimeModule.RuntimeLoader ?? runtimeModule.default?.RuntimeLoader;

  if (!runtimeLoader) {
    throw new Error(
      'Unable to resolve RuntimeLoader from @rive-app/canvas-lite.',
    );
  }

  return runtimeLoader.awaitInstance();
}

function cloneWithTrailingByte(bytes: Uint8Array, byte: number): Uint8Array {
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes);
  out[bytes.length] = byte;
  return out;
}

const gate2RepresentativeFixtures: Array<{
  name: string;
  input: RiveWriterInput;
}> = [
  {
    name: 'single-component-mesh',
    input: {
      segResult: {
        schema_version: 2,
        image_size: { w: 100, h: 100 },
        background_method: 'rembg',
        sheet: {
          component_count: 1,
          sheet_detected: false,
          ordering: 'row-major',
        },
        components: [
          {
            id: 'subject_01',
            label: 'Subject 01',
            source_bounds: { x: 0, y: 0, w: 100, h: 100 },
            image_size: { w: 100, h: 100 },
            masked_png_path: '/tmp/subject_01.png',
            contour: [],
            mesh: {
              vertices: [
                { x: 0, y: 0, u: 0, v: 0 },
                { x: 100, y: 0, u: 1, v: 0 },
                { x: 0, y: 100, u: 0, v: 1 },
              ],
              triangles: [[0, 1, 2]],
              boundary_count: 3,
            },
            region_colors: ['#ff0000'],
            mask_stats: { area: 10000, fill_ratio: 1.0 },
          },
        ],
        primary_component_index: 0,
      },
      poseResult: {
        schema_version: 2,
        components: [],
      },
      animationPlans: [],
    },
  },
  {
    name: 'sheet-two-components-with-bones',
    input: {
      segResult: {
        schema_version: 2,
        image_size: { w: 160, h: 80 },
        background_method: 'alpha',
        sheet: {
          component_count: 2,
          sheet_detected: true,
          ordering: 'row-major',
        },
        components: [
          {
            id: 'subject_01',
            label: 'Subject 01',
            source_bounds: { x: 0, y: 0, w: 80, h: 80 },
            image_size: { w: 80, h: 80 },
            masked_png_path: '/tmp/subject_01.png',
            contour: [],
            mesh: {
              vertices: [
                { x: 0, y: 0, u: 0, v: 0 },
                { x: 80, y: 0, u: 1, v: 0 },
                { x: 0, y: 80, u: 0, v: 1 },
              ],
              triangles: [[0, 1, 2]],
              boundary_count: 3,
            },
            region_colors: ['#00ff00'],
            mask_stats: { area: 6400, fill_ratio: 1.0 },
          },
          {
            id: 'subject_02',
            label: 'Subject 02',
            source_bounds: { x: 80, y: 0, w: 80, h: 80 },
            image_size: { w: 80, h: 80 },
            masked_png_path: '/tmp/subject_02.png',
            contour: [],
            mesh: {
              vertices: [
                { x: 0, y: 0, u: 0, v: 0 },
                { x: 80, y: 0, u: 1, v: 0 },
                { x: 0, y: 80, u: 0, v: 1 },
              ],
              triangles: [[0, 1, 2]],
              boundary_count: 3,
            },
            region_colors: ['#0000ff'],
            mask_stats: { area: 6400, fill_ratio: 1.0 },
          },
        ],
        primary_component_index: 0,
      },
      poseResult: {
        schema_version: 2,
        components: [
          {
            id: 'subject_01',
            skeleton: {
              type: 'generic_centerline',
              confidence: 'fallback',
              bones: [
                {
                  name: 'root_01',
                  parent: null,
                  role: 'root',
                  x: 40,
                  y: 20,
                  rotation: 0,
                  length: 40,
                  start: { x: 40, y: 20 },
                  end: { x: 40, y: 60 },
                },
              ],
            },
            vertex_weights: [],
          },
          {
            id: 'subject_02',
            skeleton: {
              type: 'generic_centerline',
              confidence: 'fallback',
              bones: [
                {
                  name: 'root_02',
                  parent: null,
                  role: 'root',
                  x: 40,
                  y: 20,
                  rotation: 0,
                  length: 40,
                  start: { x: 40, y: 20 },
                  end: { x: 40, y: 60 },
                },
              ],
            },
            vertex_weights: [],
          },
        ],
      },
      animationPlans: [],
    },
  },
  {
    name: 'humanoid-style-skeleton',
    input: {
      segResult: {
        schema_version: 2,
        image_size: { w: 512, h: 768 },
        background_method: 'rembg',
        sheet: {
          component_count: 1,
          sheet_detected: false,
          ordering: 'row-major',
        },
        components: [
          {
            id: 'character_01',
            label: 'Character 01',
            source_bounds: { x: 0, y: 0, w: 512, h: 768 },
            image_size: { w: 512, h: 768 },
            masked_png_path: '/tmp/character_01.png',
            contour: [],
            mesh: {
              vertices: [
                { x: 120, y: 120, u: 0.2, v: 0.15 },
                { x: 380, y: 120, u: 0.8, v: 0.15 },
                { x: 120, y: 640, u: 0.2, v: 0.85 },
                { x: 380, y: 640, u: 0.8, v: 0.85 },
              ],
              triangles: [
                [0, 1, 2],
                [1, 3, 2],
              ],
              boundary_count: 4,
            },
            region_colors: ['#c0a080'],
            mask_stats: { area: 393216, fill_ratio: 1.0 },
          },
        ],
        primary_component_index: 0,
      },
      poseResult: {
        schema_version: 2,
        components: [
          {
            id: 'character_01',
            skeleton: {
              type: 'humanoid',
              confidence: 'mediapipe',
              bones: [
                {
                  name: 'root',
                  parent: null,
                  role: 'root',
                  x: 256,
                  y: 680,
                  rotation: 0,
                  length: 120,
                  start: { x: 256, y: 680 },
                  end: { x: 256, y: 560 },
                },
                {
                  name: 'spine',
                  parent: 'root',
                  role: 'torso',
                  x: 256,
                  y: 560,
                  rotation: 0,
                  length: 180,
                  start: { x: 256, y: 560 },
                  end: { x: 256, y: 380 },
                },
                {
                  name: 'head',
                  parent: 'spine',
                  role: 'head',
                  x: 256,
                  y: 300,
                  rotation: 0,
                  length: 80,
                  start: { x: 256, y: 340 },
                  end: { x: 256, y: 260 },
                },
                {
                  name: 'arm_l',
                  parent: 'spine',
                  role: 'limb',
                  x: 192,
                  y: 420,
                  rotation: 0,
                  length: 110,
                  start: { x: 256, y: 420 },
                  end: { x: 146, y: 420 },
                },
                {
                  name: 'arm_r',
                  parent: 'spine',
                  role: 'limb',
                  x: 320,
                  y: 420,
                  rotation: 0,
                  length: 110,
                  start: { x: 256, y: 420 },
                  end: { x: 366, y: 420 },
                },
              ],
            },
            vertex_weights: [],
          },
        ],
      },
      animationPlans: [],
      artboardWidth: 512,
      artboardHeight: 768,
    },
  },
  {
    name: 'animated-bone-tracks',
    input: {
      segResult: {
        schema_version: 2,
        image_size: { w: 120, h: 120 },
        background_method: 'alpha',
        sheet: {
          component_count: 1,
          sheet_detected: false,
          ordering: 'row-major',
        },
        components: [
          {
            id: 'anim_01',
            label: 'Anim 01',
            source_bounds: { x: 0, y: 0, w: 120, h: 120 },
            image_size: { w: 120, h: 120 },
            masked_png_path: '/tmp/anim_01.png',
            contour: [],
            mesh: {
              vertices: [
                { x: 0, y: 0, u: 0, v: 0 },
                { x: 120, y: 0, u: 1, v: 0 },
                { x: 0, y: 120, u: 0, v: 1 },
              ],
              triangles: [[0, 1, 2]],
              boundary_count: 3,
            },
            region_colors: ['#ff8800'],
            mask_stats: { area: 14400, fill_ratio: 1.0 },
          },
        ],
        primary_component_index: 0,
      },
      poseResult: {
        schema_version: 2,
        components: [
          {
            id: 'anim_01',
            skeleton: {
              type: 'generic_centerline',
              confidence: 'fallback',
              bones: [
                {
                  name: 'root',
                  parent: null,
                  role: 'root',
                  x: 60,
                  y: 80,
                  rotation: 0,
                  length: 40,
                  start: { x: 60, y: 80 },
                  end: { x: 60, y: 40 },
                },
                {
                  name: 'hand',
                  parent: 'root',
                  role: 'limb',
                  x: 80,
                  y: 40,
                  rotation: 0,
                  length: 20,
                  start: { x: 60, y: 40 },
                  end: { x: 80, y: 40 },
                },
              ],
            },
            vertex_weights: [],
          },
        ],
      },
      animationPlans: [
        {
          id: 'anim_01',
          label: 'Anim 01',
          boneNames: ['root', 'hand'],
          animationNames: ['Idle', 'Wave'],
          animations: [
            {
              name: 'Idle',
              fps: 24,
              durationFrames: 24,
              loopType: 1,
              tracks: [
                {
                  boneName: 'root',
                  property: 'rotation',
                  keyframes: [
                    { frame: 0, value: 0, interp: 1 },
                    { frame: 12, value: 0.2, interp: 2 },
                    { frame: 24, value: 0, interp: 1 },
                  ],
                },
              ],
            },
            {
              name: 'Wave',
              fps: 24,
              durationFrames: 24,
              loopType: 1,
              tracks: [
                {
                  boneName: 'hand',
                  property: 'y',
                  keyframes: [
                    { frame: 0, value: 40, interp: 1 },
                    { frame: 12, value: 32, interp: 2 },
                    { frame: 24, value: 40, interp: 1 },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  },
  {
    name: 'dense-mesh-static',
    input: {
      segResult: {
        schema_version: 2,
        image_size: { w: 200, h: 160 },
        background_method: 'rembg',
        sheet: {
          component_count: 1,
          sheet_detected: false,
          ordering: 'row-major',
        },
        components: [
          {
            id: 'dense_01',
            label: 'Dense 01',
            source_bounds: { x: 0, y: 0, w: 200, h: 160 },
            image_size: { w: 200, h: 160 },
            masked_png_path: '/tmp/dense_01.png',
            contour: [],
            mesh: {
              vertices: [
                { x: 0, y: 0, u: 0, v: 0 },
                { x: 200, y: 0, u: 1, v: 0 },
                { x: 200, y: 160, u: 1, v: 1 },
                { x: 0, y: 160, u: 0, v: 1 },
                { x: 100, y: 80, u: 0.5, v: 0.5 },
              ],
              triangles: [
                [0, 1, 4],
                [1, 2, 4],
                [2, 3, 4],
                [3, 0, 4],
              ],
              boundary_count: 4,
            },
            region_colors: ['#55ccaa'],
            mask_stats: { area: 32000, fill_ratio: 1.0 },
          },
        ],
        primary_component_index: 0,
      },
      poseResult: {
        schema_version: 2,
        components: [],
      },
      animationPlans: [],
    },
  },
];

// Phase 1: Rive Binary Writer — Exporter Isolation (Gate 1)
// ─────────────────────────────────────────────────────────────────────────────

// Phase 3: Rive Binary Writer — Animation Encoding (Gate 2 in progress)
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

test('RIVE_BINARY_WRITER_VERSION is 0.4.0', () => {
  assert.equal(RIVE_BINARY_WRITER_VERSION, '0.4.0');
});

test('writeRiveFile encodes animation data when animationPlans are provided', () => {
  const baseInput: RiveWriterInput = {
    segResult: {
      schema_version: 2,
      image_size: { w: 100, h: 100 },
      background_method: 'rembg',
      sheet: {
        component_count: 1,
        sheet_detected: false,
        ordering: 'row-major',
      },
      components: [
        {
          id: 'subject_01',
          label: 'Subject',
          source_bounds: { x: 0, y: 0, w: 100, h: 100 },
          image_size: { w: 100, h: 100 },
          masked_png_path: '/tmp/masked.png',
          contour: [],
          mesh: {
            vertices: [{ x: 0, y: 0, u: 0, v: 0 }],
            triangles: [[0, 0, 0]],
            boundary_count: 1,
          },
          region_colors: ['#ff0000'],
          mask_stats: { area: 10000, fill_ratio: 1.0 },
        },
      ],
      primary_component_index: 0,
    },
    poseResult: {
      schema_version: 2,
      components: [
        {
          id: 'subject_01',
          skeleton: {
            type: 'generic_centerline',
            confidence: 'fallback',
            bones: [
              {
                name: 'root',
                parent: null,
                role: 'root',
                x: 50,
                y: 50,
                rotation: 0,
                length: 50,
                start: { x: 50, y: 50 },
                end: { x: 50, y: 100 },
              },
            ],
          },
          vertex_weights: [],
        },
      ],
    },
    animationPlans: [],
  };

  const withAnimation: RiveWriterInput = {
    ...baseInput,
    animationPlans: [
      {
        id: 'subject_01',
        label: 'Subject',
        boneNames: ['root'],
        animationNames: ['Idle'],
        animations: [
          {
            name: 'Idle',
            fps: 24,
            durationFrames: 24,
            loopType: 1,
            tracks: [
              {
                boneName: 'root',
                property: 'rotation',
                keyframes: [
                  { frame: 0, value: 0, interp: 1 },
                  { frame: 12, value: 0.2, interp: 2 },
                  { frame: 24, value: 0, interp: 1 },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  const staticResult = writeRiveFile(baseInput);
  const animatedResult = writeRiveFile(withAnimation);

  assert.ok(
    animatedResult.bytes.length > staticResult.bytes.length,
    'Animation encoding should produce more object data than static output',
  );
  assert.equal(
    animatedResult.warnings.length,
    0,
    'Animation should encode without warnings',
  );
});

test('writeRiveFile writes valid file header', () => {
  const input: RiveWriterInput = {
    segResult: {
      schema_version: 2,
      image_size: { w: 100, h: 100 },
      background_method: 'rembg',
      sheet: {
        component_count: 1,
        sheet_detected: false,
        ordering: 'row-major',
      },
      components: [
        {
          id: 'subject_01',
          label: 'Subject',
          source_bounds: { x: 0, y: 0, w: 100, h: 100 },
          image_size: { w: 100, h: 100 },
          masked_png_path: '/tmp/masked.png',
          contour: [
            [0, 0],
            [100, 0],
            [100, 100],
            [0, 100],
          ],
          mesh: {
            vertices: [{ x: 0, y: 0, u: 0, v: 0 }],
            triangles: [[0, 0, 0]],
            boundary_count: 4,
          },
          region_colors: ['#ff0000'],
          mask_stats: { area: 10000, fill_ratio: 1.0 },
        },
      ],
      primary_component_index: 0,
    },
    poseResult: {
      schema_version: 2,
      components: [
        {
          id: 'subject_01',
          skeleton: {
            type: 'generic_centerline',
            confidence: 'fallback',
            bones: [
              {
                name: 'root',
                parent: null,
                role: 'root',
                x: 50,
                y: 50,
                rotation: 0,
                length: 100,
                start: { x: 50, y: 50 },
                end: { x: 50, y: 150 },
              },
            ],
          },
          vertex_weights: [],
        },
      ],
    },
    animationPlans: [],
  };

  const result = writeRiveFile(input);

  assert.ok(
    result.bytes.length > 9,
    'Output should contain object data beyond header',
  );

  const header = parseRuntimeHeader(result.bytes);
  assert.equal(header.major, RIVE_MAJOR_VERSION);
  assert.equal(header.minor, RIVE_MINOR_VERSION);
  assert.equal(header.fileId, 0);
  assert.ok(header.propertyKeys.length > 0, 'ToC should include property keys');

  const objects = parseObjectStream(
    result.bytes,
    header.objectStreamOffset,
    header.backingByKey,
  );
  assert.ok(objects.length > 0, 'Object stream should contain encoded objects');
  assert.equal(objects[0]?.typeKey, RiveTypeKey.Backboard);

  assert.equal(
    result.bytes[result.bytes.length - 1],
    0x00,
    'Block terminator should be 0x00',
  );
});

test('writeRiveFile encodes mesh triangleIndexBytes as raw varuint bytes', () => {
  const input: RiveWriterInput = {
    segResult: {
      schema_version: 2,
      image_size: { w: 100, h: 100 },
      background_method: 'rembg',
      sheet: {
        component_count: 1,
        sheet_detected: false,
        ordering: 'row-major',
      },
      components: [
        {
          id: 'subject_01',
          label: 'Subject',
          source_bounds: { x: 0, y: 0, w: 100, h: 100 },
          image_size: { w: 100, h: 100 },
          masked_png_path: '/tmp/masked.png',
          contour: [],
          mesh: {
            vertices: [
              { x: 0, y: 0, u: 0, v: 0 },
              { x: 100, y: 0, u: 1, v: 0 },
              { x: 0, y: 100, u: 0, v: 1 },
            ],
            triangles: [
              [0, 1, 2],
              [2, 1, 0],
            ],
            boundary_count: 3,
          },
          region_colors: ['#ff0000'],
          mask_stats: { area: 10000, fill_ratio: 1.0 },
        },
      ],
      primary_component_index: 0,
    },
    poseResult: {
      schema_version: 2,
      components: [],
    },
    animationPlans: [],
  };

  const result = writeRiveFile(input);
  const header = parseRuntimeHeader(result.bytes);
  const objects = parseObjectStream(
    result.bytes,
    header.objectStreamOffset,
    header.backingByKey,
  );

  const meshObject = objects.find((obj) => obj.typeKey === RiveTypeKey.Mesh);
  assert.ok(meshObject, 'Expected mesh object in object stream.');

  const trianglePayload = meshObject?.properties.get(
    RivePropertyKey.triangleIndexBytes.key,
  );
  assert.ok(
    trianglePayload instanceof Uint8Array,
    'triangleIndexBytes should be encoded as raw bytes.',
  );
  assert.deepEqual(decodeVarUintSequence(trianglePayload), [0, 1, 2, 2, 1, 0]);
  assert.equal(
    meshObject?.properties.get(RivePropertyKey.parentId.key),
    1,
    'Mesh should parent to image local id 1.',
  );

  const meshVertices = objects.filter(
    (obj) => obj.typeKey === RiveTypeKey.MeshVertex,
  );
  assert.ok(
    meshVertices.length >= 3,
    'Expected mesh vertices in object stream.',
  );
  for (const vertex of meshVertices) {
    assert.equal(
      vertex.properties.get(RivePropertyKey.parentId.key),
      2,
      'MeshVertex should parent to mesh local id 2.',
    );
  }
});

test('writeRiveFile encodes animation name with key 55 and local object references', () => {
  const input: RiveWriterInput = {
    segResult: {
      schema_version: 2,
      image_size: { w: 100, h: 100 },
      background_method: 'rembg',
      sheet: {
        component_count: 1,
        sheet_detected: false,
        ordering: 'row-major',
      },
      components: [
        {
          id: 'subject_01',
          label: 'Subject',
          source_bounds: { x: 0, y: 0, w: 100, h: 100 },
          image_size: { w: 100, h: 100 },
          masked_png_path: '/tmp/masked.png',
          contour: [],
          mesh: {
            vertices: [{ x: 0, y: 0, u: 0, v: 0 }],
            triangles: [[0, 0, 0]],
            boundary_count: 1,
          },
          region_colors: ['#ff0000'],
          mask_stats: { area: 10000, fill_ratio: 1.0 },
        },
      ],
      primary_component_index: 0,
    },
    poseResult: {
      schema_version: 2,
      components: [
        {
          id: 'subject_01',
          skeleton: {
            type: 'generic_centerline',
            confidence: 'fallback',
            bones: [
              {
                name: 'root',
                parent: null,
                role: 'root',
                x: 50,
                y: 50,
                rotation: 0,
                length: 50,
                start: { x: 50, y: 50 },
                end: { x: 50, y: 100 },
              },
            ],
          },
          vertex_weights: [],
        },
      ],
    },
    animationPlans: [
      {
        id: 'subject_01',
        label: 'Subject',
        boneNames: ['root'],
        animationNames: ['Idle'],
        animations: [
          {
            name: 'Idle',
            fps: 24,
            durationFrames: 24,
            loopType: 1,
            tracks: [
              {
                boneName: 'root',
                property: 'rotation',
                keyframes: [
                  { frame: 0, value: 0, interp: 1 },
                  { frame: 24, value: 0.25, interp: 1 },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  const result = writeRiveFile(input);
  const header = parseRuntimeHeader(result.bytes);
  const objects = parseObjectStream(
    result.bytes,
    header.objectStreamOffset,
    header.backingByKey,
  );

  const linearAnimation = objects.find(
    (obj) => obj.typeKey === RiveTypeKey.LinearAnimation,
  );
  assert.ok(linearAnimation, 'Expected LinearAnimation object.');
  assert.equal(
    decodeUtf8(
      linearAnimation?.properties.get(RivePropertyKey.animation_name.key),
    ),
    'Idle',
  );
  assert.ok(
    !linearAnimation?.properties.has(RivePropertyKey.name.key),
    'LinearAnimation should not use Component.name property key.',
  );
  assert.ok(
    !linearAnimation?.properties.has(RivePropertyKey.parentId.key),
    'LinearAnimation should not use Component.parentId property key.',
  );

  const keyedObject = objects.find(
    (obj) => obj.typeKey === RiveTypeKey.KeyedObject,
  );
  assert.ok(keyedObject, 'Expected KeyedObject in animation graph.');
  assert.equal(
    keyedObject?.properties.get(RivePropertyKey.objectId.key),
    5,
    'KeyedObject should target the root bone local id allocated for this fixture.',
  );
});

test('Gate 2 harness: known-bad trailing-byte fixture is rejected by official runtime', {
  skip: !process.env.RUN_RIVE_GATE2,
}, async () => {
  const runtime = await loadRiveRuntimeForHarness();
  const baseBytes = writeRiveFile(gate2RepresentativeFixtures[0]!.input).bytes;
  const malformed = cloneWithTrailingByte(baseBytes, 0x00);
  const file = await runtime.load(malformed);
  assert.equal(file, null);
});

test('Gate 2 harness: 5 representative generated fixtures load in official runtime', {
  skip: !process.env.RUN_RIVE_GATE2_EXPECT_PASS,
}, async () => {
  const runtime = await loadRiveRuntimeForHarness();
  assert.equal(gate2RepresentativeFixtures.length, 5);

  for (const fixture of gate2RepresentativeFixtures) {
    const bytes = writeRiveFile(fixture.input).bytes;
    const file = await runtime.load(bytes);
    assert.notEqual(file, null, `Fixture ${fixture.name} should load.`);
  }
});

test('writeRiveFile counts artboards from segResult', () => {
  const input: RiveWriterInput = {
    segResult: {
      schema_version: 2,
      image_size: { w: 100, h: 100 },
      background_method: 'rembg',
      sheet: {
        component_count: 3,
        sheet_detected: true,
        ordering: 'row-major',
      },
      components: [
        {
          id: 'subject_01',
          label: 'Subject 1',
          source_bounds: { x: 0, y: 0, w: 50, h: 50 },
          image_size: { w: 100, h: 100 },
          masked_png_path: '/tmp/masked1.png',
          contour: [
            [0, 0],
            [50, 0],
            [50, 50],
            [0, 50],
          ],
          mesh: { vertices: [], triangles: [], boundary_count: 0 },
          region_colors: [],
          mask_stats: { area: 2500, fill_ratio: 0.5 },
        },
        {
          id: 'subject_02',
          label: 'Subject 2',
          source_bounds: { x: 50, y: 0, w: 50, h: 50 },
          image_size: { w: 100, h: 100 },
          masked_png_path: '/tmp/masked2.png',
          contour: [
            [50, 0],
            [100, 0],
            [100, 50],
            [50, 50],
          ],
          mesh: { vertices: [], triangles: [], boundary_count: 0 },
          region_colors: [],
          mask_stats: { area: 2500, fill_ratio: 0.5 },
        },
        {
          id: 'subject_03',
          label: 'Subject 3',
          source_bounds: { x: 0, y: 50, w: 50, h: 50 },
          image_size: { w: 100, h: 100 },
          masked_png_path: '/tmp/masked3.png',
          contour: [
            [0, 50],
            [50, 50],
            [50, 100],
            [0, 100],
          ],
          mesh: { vertices: [], triangles: [], boundary_count: 0 },
          region_colors: [],
          mask_stats: { area: 2500, fill_ratio: 0.5 },
        },
      ],
      primary_component_index: 0,
    },
    poseResult: {
      schema_version: 2,
      components: [],
    },
    animationPlans: [],
  };

  const result = writeRiveFile(input);
  assert.equal(result.artboardCount, 3, 'Should report 3 artboards');
});

test('writeRiveFile counts bones across all pose components', () => {
  const input: RiveWriterInput = {
    segResult: {
      schema_version: 2,
      image_size: { w: 100, h: 100 },
      background_method: 'rembg',
      sheet: {
        component_count: 1,
        sheet_detected: false,
        ordering: 'row-major',
      },
      components: [
        {
          id: 'subject_01',
          label: 'Subject',
          source_bounds: { x: 0, y: 0, w: 100, h: 100 },
          image_size: { w: 100, h: 100 },
          masked_png_path: '/tmp/masked.png',
          contour: [],
          mesh: { vertices: [], triangles: [], boundary_count: 0 },
          region_colors: [],
          mask_stats: { area: 10000, fill_ratio: 1.0 },
        },
      ],
      primary_component_index: 0,
    },
    poseResult: {
      schema_version: 2,
      components: [
        {
          id: 'subject_01',
          skeleton: {
            type: 'generic_centerline',
            confidence: 'fallback',
            bones: [
              {
                name: 'root',
                parent: null,
                role: 'root',
                x: 0,
                y: 0,
                rotation: 0,
                length: 10,
                start: { x: 0, y: 0 },
                end: { x: 0, y: 10 },
              },
              {
                name: 'child1',
                parent: 'root',
                role: 'limb',
                x: 0,
                y: 10,
                rotation: 0,
                length: 10,
                start: { x: 0, y: 10 },
                end: { x: 0, y: 20 },
              },
              {
                name: 'child2',
                parent: 'root',
                role: 'limb',
                x: 0,
                y: 10,
                rotation: 0,
                length: 10,
                start: { x: 0, y: 10 },
                end: { x: 0, y: 20 },
              },
            ],
          },
          vertex_weights: [],
        },
        {
          id: 'subject_02',
          skeleton: {
            type: 'generic_centerline',
            confidence: 'fallback',
            bones: [
              {
                name: 'root2',
                parent: null,
                role: 'root',
                x: 0,
                y: 0,
                rotation: 0,
                length: 10,
                start: { x: 0, y: 0 },
                end: { x: 0, y: 10 },
              },
              {
                name: 'child3',
                parent: 'root2',
                role: 'limb',
                x: 0,
                y: 10,
                rotation: 0,
                length: 10,
                start: { x: 0, y: 10 },
                end: { x: 0, y: 20 },
              },
            ],
          },
          vertex_weights: [],
        },
      ],
    },
    animationPlans: [],
  };

  const result = writeRiveFile(input);
  assert.equal(result.boneCount, 5, 'Should count 5 bones total (3 + 2)');
});

test('writeRiveFile writes complete object graph', () => {
  const input: RiveWriterInput = {
    segResult: {
      schema_version: 2,
      image_size: { w: 100, h: 100 },
      background_method: 'rembg',
      sheet: {
        component_count: 1,
        sheet_detected: false,
        ordering: 'row-major',
      },
      components: [
        {
          id: 'subject_01',
          label: 'Subject',
          source_bounds: { x: 0, y: 0, w: 100, h: 100 },
          image_size: { w: 100, h: 100 },
          masked_png_path: '/tmp/masked.png',
          contour: [],
          mesh: { vertices: [], triangles: [], boundary_count: 0 },
          region_colors: [],
          mask_stats: { area: 10000, fill_ratio: 1.0 },
        },
      ],
      primary_component_index: 0,
    },
    poseResult: {
      schema_version: 2,
      components: [],
    },
    animationPlans: [],
  };

  const result = writeRiveFile(input);
  // Phase 2 should write Backboard + Artboard + Image objects (even without mesh/bones)
  assert.ok(
    result.bytes.length > 9,
    'Phase 2 output should contain Backboard, Artboard, and Image objects',
  );
  // No Phase 1 stub warning anymore
  const hasStubWarning = result.warnings.some((w) =>
    w.includes('Phase 1 stub'),
  );
  assert.ok(!hasStubWarning, 'Should not have Phase 1 stub warning in Phase 2');
});

test('writeRiveFile accepts optional artboard dimensions', () => {
  const input: RiveWriterInput = {
    segResult: {
      schema_version: 2,
      image_size: { w: 200, h: 200 },
      background_method: 'rembg',
      sheet: {
        component_count: 1,
        sheet_detected: false,
        ordering: 'row-major',
      },
      components: [
        {
          id: 'subject_01',
          label: 'Subject',
          source_bounds: { x: 0, y: 0, w: 200, h: 200 },
          image_size: { w: 200, h: 200 },
          masked_png_path: '/tmp/masked.png',
          contour: [],
          mesh: { vertices: [], triangles: [], boundary_count: 0 },
          region_colors: [],
          mask_stats: { area: 40000, fill_ratio: 1.0 },
        },
      ],
      primary_component_index: 0,
    },
    poseResult: {
      schema_version: 2,
      components: [],
    },
    animationPlans: [],
    artboardWidth: 800,
    artboardHeight: 600,
  };

  const result = writeRiveFile(input);
  assert.ok(
    result.bytes.length > 9,
    'Should write full object graph including artboard dimensions',
  );
});

test('writeRiveFile handles empty segResult components', () => {
  const input: RiveWriterInput = {
    segResult: {
      schema_version: 2,
      image_size: { w: 100, h: 100 },
      background_method: 'rembg',
      sheet: {
        component_count: 0,
        sheet_detected: false,
        ordering: 'row-major',
      },
      components: [],
      primary_component_index: 0,
    },
    poseResult: {
      schema_version: 2,
      components: [],
    },
    animationPlans: [],
  };

  const result = writeRiveFile(input);
  assert.equal(
    result.artboardCount,
    0,
    'Should report 0 artboards for empty input',
  );
  assert.equal(result.boneCount, 0, 'Should report 0 bones for empty input');
  // Phase 2: Even empty input writes Backboard (id 0) + header + ToC
  assert.ok(
    result.bytes.length > 9,
    'Should write Backboard even for empty input',
  );
});

test('normalizeOptions defaults outputFormat to rivebundle', () => {
  const result = pipelineInternals.normalizeOptions({
    inputImage: 'input.png',
  });
  assert.equal(result.outputFormat, 'rivebundle');
});

test('normalizeOptions accepts outputFormat riv', () => {
  const result = pipelineInternals.normalizeOptions({
    inputImage: 'input.png',
    outputFormat: 'riv',
  });
  assert.equal(result.outputFormat, 'riv');
});

test('normalizeOptions warns explicitly about fallback when outputFormat is riv', () => {
  const result = pipelineInternals.normalizeOptions({
    inputImage: 'input.png',
    outputFormat: 'riv',
  });
  const rivWarning = result.warnings.find(
    (w) =>
      w.includes('outputFormat "riv"') &&
      w.toLowerCase().includes('falling back') &&
      w.includes('.rivebundle'),
  );
  assert.ok(
    rivWarning,
    'Should include an explicit fallback warning for outputFormat riv requests',
  );
});

test('normalizeOptions does not warn when outputFormat is rivebundle', () => {
  const result = pipelineInternals.normalizeOptions({
    inputImage: 'input.png',
    outputFormat: 'rivebundle',
  });
  const rivWarning = result.warnings.find(
    (w) => w.includes('outputFormat "riv"') && w.includes('.rivebundle'),
  );
  assert.ok(
    !rivWarning,
    'Should not include riv warning when format is rivebundle',
  );
});
