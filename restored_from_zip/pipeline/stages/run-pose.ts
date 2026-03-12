import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  NormalizedPipelineOptions,
  PoseResult,
  StageContext,
} from '../contracts.js';
import { runPythonJsonScript, writeJson } from '../runtime.js';
import { validatePoseResult } from '../validation.js';

import type { RunPythonJsonScriptFn } from './run-segmentation.js';

export async function runPoseStage(
  opts: NormalizedPipelineOptions,
  segJsonPath: string,
  tmpDir: string,
  ctx: StageContext,
  _runScript: RunPythonJsonScriptFn = runPythonJsonScript,
): Promise<PoseResult> {
  const outputJson = path.join(tmpDir, 'pose.json');

  await _runScript(
    'pose_estimate.py',
    ['--input', opts.inputImage, '--seg', segJsonPath, '--output', outputJson],
    'pose',
    ctx.logs,
    { timeoutMs: opts.commandLimits.timeoutMs },
  );

  const rawPayload = JSON.parse(await fs.readFile(outputJson, 'utf8'));
  const payload = validatePoseResult(rawPayload);
  await writeJson(outputJson, payload);
  return payload;
}
