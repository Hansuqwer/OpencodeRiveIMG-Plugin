import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runPipeline } from './pipeline.js';
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

test('segment help remains usable when optional rembg backend is unavailable', () => {
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

test('pipeline smoke test on synthetic raster asset', { timeout: 120_000 }, async () => {
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

test('bunny sheet regression splits into six expressions', { timeout: 180_000 }, async () => {
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
});
