import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  NormalizedPipelineOptions,
  SegResult,
  StageContext,
} from '../contracts.js';
import { runPythonJsonScript, writeJson } from '../runtime.js';
import { assertPathWithinDirectory, validateSegResult } from '../validation.js';

export type RunPythonJsonScriptFn =
  typeof import('../runtime.js').runPythonJsonScript;

export async function runSegmentationStage(
  opts: NormalizedPipelineOptions,
  tmpDir: string,
  ctx: StageContext,
  _runScript: RunPythonJsonScriptFn = runPythonJsonScript,
): Promise<SegResult> {
  const outputJson = path.join(tmpDir, 'seg.json');
  const artifactsDir = path.join(tmpDir, 'segmentation_artifacts');
  await fs.mkdir(artifactsDir, { recursive: true });

  await _runScript(
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
    ctx.logs,
    { timeoutMs: opts.commandLimits.timeoutMs },
  );

  const rawPayload = JSON.parse(await fs.readFile(outputJson, 'utf8'));
  const payload = validateSegResult(rawPayload);

  for (let index = 0; index < payload.components.length; index += 1) {
    const component = payload.components[index]!;
    await fs.access(component.masked_png_path);
    await assertPathWithinDirectory(
      artifactsDir,
      component.masked_png_path,
      `SegResult component[${index}] masked_png_path`,
    );
  }

  await writeJson(outputJson, payload);
  return payload;
}
