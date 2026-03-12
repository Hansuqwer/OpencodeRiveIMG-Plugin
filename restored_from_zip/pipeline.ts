import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_COMMAND_LIMITS,
  type LogEntry,
  type PipelineOptions,
  type PipelineResult,
  type StageContext,
} from './pipeline/contracts.js';
import {
  appendWithByteCap,
  createLogger,
  ensureImageExtension,
  getPythonCandidates,
  normalizeOptions,
  normalizeOutputBundlePath,
  parseStatusJson,
  replaceDirectoryAtomically,
  resolvePythonScript,
  runCommand,
  runStage,
} from './pipeline/runtime.js';
import { assembleBundleStage } from './pipeline/stages/assemble-bundle.js';
import { finalizeOutputStage } from './pipeline/stages/finalize-output.js';
import { generateAnimationPlanStage } from './pipeline/stages/generate-animation.js';
import { runPoseStage } from './pipeline/stages/run-pose.js';
import { runSegmentationStage } from './pipeline/stages/run-segmentation.js';
import { validateInputStage } from './pipeline/stages/validate-input.js';
import {
  assertPathWithinDirectory,
  validateComponentConsistency,
  validatePoseResult,
  validateSegResult,
} from './pipeline/validation.js';

export type {
  LogEntry,
  PipelineArtboardSummary,
  PipelineOptions,
  PipelineResult,
} from './pipeline/contracts.js';

export async function runPipeline(
  opts: PipelineOptions,
): Promise<PipelineResult> {
  const logs: LogEntry[] = [];
  const log = createLogger(logs);
  const normalized = await validateInputStage(opts, logs);
  const warnings = [...normalized.warnings];

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'image-to-rive-'));
  const ctx: StageContext = {
    logs,
    warnings,
    progress: normalized.onProgress,
  };

  try {
    normalized.onProgress(
      'segmentation',
      15,
      'Running segmentation and mesh generation',
    );
    const seg = await runStage('segmentation', logs, () =>
      runSegmentationStage(normalized, tmpDir, ctx),
    );

    if (seg.components.length > 1) {
      warnings.push(
        `Input was treated as a sheet and split into ${seg.components.length} components.`,
      );
    }

    normalized.onProgress(
      'pose',
      45,
      'Running skeleton inference and skinning',
    );
    const pose = await runStage('pose', logs, () =>
      runPoseStage(normalized, path.join(tmpDir, 'seg.json'), tmpDir, ctx),
    );

    normalized.onProgress(
      'animation',
      60,
      'Evaluating animation compatibility',
    );
    const animationPlans = await runStage('animation', logs, async () =>
      generateAnimationPlanStage(seg, pose, normalized.animations, ctx),
    );

    normalized.onProgress(
      'bundle',
      75,
      'Writing `.rivebundle` fallback artifacts',
    );
    const bundle = await runStage('bundle', logs, () =>
      assembleBundleStage(normalized, seg, pose, animationPlans, ctx),
    );

    normalized.onProgress('done', 100, 'Pipeline completed');

    log('info', 'done', 'Pipeline completed successfully.', {
      outputBundle: normalized.outputBundle,
      artboardCount: bundle.components.length,
    });

    return finalizeOutputStage(normalized, bundle, warnings);
  } finally {
    if (!normalized.keepTemp) {
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        log(
          'warn',
          'cleanup',
          `Failed to remove temporary directory: ${errorMessage}`,
          { tmpDir },
        );
      }
    } else {
      log(
        'warn',
        'cleanup',
        'Temporary directory retained because keepTemp=true.',
        { tmpDir },
      );
    }
  }
}

export const __test = {
  runCommand,
  validateSegResult,
  validatePoseResult,
  validateComponentConsistency,
  DEFAULT_COMMAND_LIMITS,
  normalizeOptions,
  normalizeOutputBundlePath,
  appendWithByteCap,
  parseStatusJson,
  ensureImageExtension,
  assertPathWithinDirectory,
  replaceDirectoryAtomically,
  generateAnimationPlanStage,
  getPythonCandidates,
  resolvePythonScript,
};
