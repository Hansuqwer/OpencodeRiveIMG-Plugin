import fs from 'node:fs/promises';
import type {
  LogEntry,
  NormalizedPipelineOptions,
  PipelineOptions,
} from '../contracts.js';
import { MAX_INPUT_FILE_BYTES } from '../contracts.js';
import {
  assertReadableFile,
  createLogger,
  ensureImageExtension,
  normalizeOptions,
} from '../runtime.js';

export async function validateInputStage(
  opts: PipelineOptions,
  logs: LogEntry[],
): Promise<NormalizedPipelineOptions> {
  const normalized = normalizeOptions(opts);
  await assertReadableFile(normalized.inputImage);
  ensureImageExtension(normalized.inputImage);

  const stat = await fs.stat(normalized.inputImage);
  if (stat.size > MAX_INPUT_FILE_BYTES) {
    throw new Error(
      `Input image exceeds maximum allowed size of ${MAX_INPUT_FILE_BYTES} bytes ` +
        `(${(MAX_INPUT_FILE_BYTES / 1024 / 1024).toFixed(0)} MB). ` +
        `File size: ${stat.size} bytes.`,
    );
  }

  const log = createLogger(logs);
  log('info', 'validate', 'Validated input options.', {
    inputImage: normalized.inputImage,
    outputBundle: normalized.outputBundle,
    meshDensity: normalized.meshDensity,
    animations: normalized.animations,
    sheetMode: normalized.sheetMode,
  });

  return normalized;
}
