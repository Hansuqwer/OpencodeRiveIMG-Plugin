import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolvePathWithinBase } from './cli.js';
import { __test as pipelineInternals, runPipeline } from './pipeline.js';
import { encodeVarint, getRiveWriterStatus } from './rive-writer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bunnyAsset = path.resolve(__dirname, '../tests/assets/ModelExpressions.png');

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
  `.trim().replace("PLACEHOLDER", filePath.replace(/\\/g, "\\\\"));
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', script], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`Failed to create synthetic PNG: ${result.stderr || result.stdout}`);
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

test('segment help remains usable when optional rembg backend is unavailable', { skip: !hasCv2 }, () => {
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

test('pipeline smoke test on synthetic raster asset', { timeout: 120_000, skip: !hasCv2 }, async () => {
  const tempDir = await makeTempDir('image-to-rive-smoke-');
  try {
    const input = path.join(tempDir, 'synthetic.png');
    const output = path.join(tempDir, 'synthetic.rivebundle');
    makeSyntheticPng(input);

    const result = await runPipeline({
      inputImage: input,
      outputBundle: output,
      meshDensity: 0.10,
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
    await fs.access(path.join(output, 'artboards', 'subject_01', 'rig-preview.svg'));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test(
  'bunny sheet regression splits into six expressions',
  { timeout: 180_000, skip: !hasCv2 },
  async () => {
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

    const stateMachine = JSON.parse(await fs.readFile(result.stateMachinePath, 'utf8'));
    assert.equal(stateMachine.states.length, 6);

    for (let index = 1; index <= 6; index += 1) {
      const id = `expression_${String(index).padStart(2, '0')}`;
      await fs.access(path.join(output, 'artboards', id, 'masked.png'));
      await fs.access(path.join(output, 'artboards', id, 'mesh.svg'));
      await fs.access(path.join(output, 'artboards', id, 'rig-preview.svg'));
    }

    // Regression: expression ordering must be row-major (top-to-bottom, left-to-right)
    const artboards = manifest.artboards as Array<{ id: string; sourceBounds: { x: number; y: number } }>;
    for (let i = 0; i < artboards.length - 1; i += 1) {
      const a = artboards[i]!.sourceBounds;
      const b = artboards[i + 1]!.sourceBounds;
      // Next artboard should be on the same row (to the right) or on a later row
      const sameRow = Math.abs(a.y - b.y) < 200;
      if (sameRow) {
        assert.ok(b.x > a.x, `expression_${String(i + 1).padStart(2, '0')} should be left of expression_${String(i + 2).padStart(2, '0')} within the same row`);
      } else {
        assert.ok(b.y > a.y, `expression_${String(i + 2).padStart(2, '0')} should be on a later row than expression_${String(i + 1).padStart(2, '0')}`);
      }
    }

    // Regression: state machine states should have display names
    for (const state of stateMachine.states) {
      assert.ok(typeof state.name === 'string' && state.name.length > 0, `state ${state.id} must have a display name`);
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
  },
);

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
      /not found|does not exist|ENOENT/i
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
      /unsupported|extension|png|jpg|jpeg/i
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('rejects invalid mesh density', { skip: !hasCv2 }, async () => {
  const tempDir = await makeTempDir('image-to-rive-error-');
  try {
    const input = path.join(tempDir, 'test.png');
    makeSyntheticPng(input);
    await assert.rejects(
      runPipeline({
        inputImage: input,
        outputBundle: path.join(tempDir, 'output.rivebundle'),
        meshDensity: 0.5, // Invalid: should be in [0.01, 0.15]
        animations: ['idle'],
        sheetMode: 'single',
      }),
      /meshDensity|range|0\.01|0\.15/i
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('rejects invalid animation preset', { skip: !hasCv2 }, async () => {
  const tempDir = await makeTempDir('image-to-rive-error-');
  try {
    const input = path.join(tempDir, 'test.png');
    makeSyntheticPng(input);
    await assert.rejects(
      runPipeline({
        inputImage: input,
        outputBundle: path.join(tempDir, 'output.rivebundle'),
        meshDensity: 0.06,
        animations: ['invalid_preset' as 'idle'], // Type assertion to bypass TS
        sheetMode: 'single',
      }),
      /unsupported|animation|preset/i
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('generates animations with compatibility warnings for generic skeletons', { skip: !hasCv2 }, async () => {
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
    const normalizedAnimationNames = result.animationNames.map((name) => name.toLowerCase());
    assert.ok(normalizedAnimationNames.includes('idle'), 'should generate idle animation');
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
        resolvePathWithinBase(baseDir, path.join('linked-outside', 'outside.txt'), {
          mustExist: true,
          purpose: 'input',
        }),
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
    const result = spawnSync(process.execPath, [cliPath, 'convert', 'input.png', '--output', '--json'], {
      cwd: tempDir,
      encoding: 'utf8',
    });

    assert.notEqual(result.status, 0);
    const combined = `${result.stdout}\n${result.stderr}`;
    assert.match(combined, /missing value for --output/i);
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
    ['-e', "process.stdout.write('x'.repeat(200000)); setTimeout(() => {}, 2000);"],
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
    () => pipelineInternals.validateComponentConsistency(component, poseComponent),
    /weight rows/i,
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
