import { spawn } from 'node:child_process';
import { existsSync, constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type CommandExecutionLimits,
  DEFAULT_ANIMATIONS,
  DEFAULT_COMMAND_LIMITS,
  DEFAULT_MESH_DENSITY,
  type LogEntry,
  MAX_ARTBOARD_DIMENSION,
  MAX_MESH_DENSITY,
  MIN_MESH_DENSITY,
  type NormalizedPipelineOptions,
  type PipelineOptions,
  type RunCommandResult,
  VALID_ANIMATIONS,
} from './contracts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}

export function timestamp(): string {
  return new Date().toISOString();
}

export function createLogger(logs: LogEntry[]) {
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

export function normalizeOutputBundlePath(
  inputImage: string,
  outputBundle?: string,
  outputRiv?: string,
): {
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

function buildCommandLimits(
  stageTimeoutMs: number | undefined,
): CommandExecutionLimits {
  if (stageTimeoutMs !== undefined) {
    if (!Number.isInteger(stageTimeoutMs) || stageTimeoutMs <= 0) {
      throw new Error(
        `stageTimeoutMs must be a positive integer. Received ${stageTimeoutMs}.`,
      );
    }
    return { ...DEFAULT_COMMAND_LIMITS, timeoutMs: stageTimeoutMs };
  }
  return DEFAULT_COMMAND_LIMITS;
}

export function normalizeOptions(
  opts: PipelineOptions,
): NormalizedPipelineOptions {
  const inputImage = path.resolve(opts.inputImage);
  const output = normalizeOutputBundlePath(
    inputImage,
    opts.outputBundle,
    opts.outputRiv,
  );
  const meshDensity = opts.meshDensity ?? DEFAULT_MESH_DENSITY;

  if (
    !Number.isFinite(meshDensity) ||
    meshDensity < MIN_MESH_DENSITY ||
    meshDensity > MAX_MESH_DENSITY
  ) {
    throw new Error(
      `meshDensity must be in the range [${MIN_MESH_DENSITY}, ${MAX_MESH_DENSITY}]. Received ${meshDensity}.`,
    );
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

  if (
    opts.artboardWidth !== undefined &&
    (opts.artboardWidth < 1 || opts.artboardWidth > MAX_ARTBOARD_DIMENSION)
  ) {
    throw new Error(
      `artboardWidth must be between 1 and ${MAX_ARTBOARD_DIMENSION}. Received ${opts.artboardWidth}.`,
    );
  }
  if (
    opts.artboardHeight !== undefined &&
    (opts.artboardHeight < 1 || opts.artboardHeight > MAX_ARTBOARD_DIMENSION)
  ) {
    throw new Error(
      `artboardHeight must be between 1 and ${MAX_ARTBOARD_DIMENSION}. Received ${opts.artboardHeight}.`,
    );
  }
  const outputFormat = opts.outputFormat ?? 'rivebundle';

  if (outputFormat === 'riv') {
    warnings.push(
      'Requested outputFormat "riv", but `.riv` export is still gated. ' +
        'Falling back to `.rivebundle` output until the remaining `.riv` gates are complete.',
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
    commandLimits: buildCommandLimits(opts.stageTimeoutMs),
    outputFormat,
  };
}

export async function assertReadableFile(filePath: string): Promise<void> {
  await fs.access(filePath, fsConstants.R_OK);
}

export function ensureImageExtension(filePath: string): void {
  const ext = path.extname(filePath).toLowerCase();
  if (!['.png', '.jpg', '.jpeg'].includes(ext)) {
    throw new Error(
      `Unsupported input extension "${ext || '(none)'}". Expected PNG or JPG.`,
    );
  }
}

export function resolvePythonScript(scriptName: string): string {
  const candidates = [
    path.resolve(__dirname, '..', scriptName),
    path.resolve(__dirname, '..', '..', scriptName),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Unable to resolve Python script "${scriptName}".`);
}

export function getPythonCandidates(): string[] {
  const envChoice = process.env.PYTHON?.trim();
  const candidates = [
    envChoice,
    process.platform === 'win32' ? 'python' : 'python3',
    'python',
  ];
  return candidates.filter((value): value is string => Boolean(value));
}

export function appendWithByteCap(
  current: string,
  chunk: string,
  maxBytes: number,
): {
  next: string;
  truncated: boolean;
} {
  if (maxBytes <= 0) {
    return { next: current, truncated: true };
  }

  const currentBytes = Buffer.byteLength(current, 'utf8');
  if (currentBytes >= maxBytes) {
    return { next: current, truncated: true };
  }

  const remaining = maxBytes - currentBytes;
  const chunkBytes = Buffer.byteLength(chunk, 'utf8');
  if (chunkBytes <= remaining) {
    return { next: `${current}${chunk}`, truncated: false };
  }

  const truncatedChunk = Buffer.from(chunk, 'utf8')
    .subarray(0, remaining)
    .toString('utf8');
  return { next: `${current}${truncatedChunk}`, truncated: true };
}

export async function runCommand(
  command: string,
  args: string[],
  limits: CommandExecutionLimits,
): Promise<RunCommandResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let outputLimitExceeded = false;
    let finished = false;
    let killTimer: NodeJS.Timeout | undefined;

    const finish = (result: RunCommandResult): void => {
      if (finished) {
        return;
      }
      finished = true;
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      if (killTimer) {
        clearTimeout(killTimer);
      }
      resolve(result);
    };

    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const requestTermination = (): void => {
      if (finished) {
        return;
      }
      child.kill('SIGTERM');
      if (!killTimer) {
        killTimer = setTimeout(() => {
          if (!finished) {
            child.kill('SIGKILL');
          }
        }, limits.killGraceMs);
      }
    };

    const timeoutTimer =
      limits.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            requestTermination();
          }, limits.timeoutMs)
        : undefined;

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    child.stdout?.on('data', (chunk: string) => {
      const updated = appendWithByteCap(stdout, chunk, limits.maxStdoutBytes);
      stdout = updated.next;
      if (updated.truncated) {
        stdoutTruncated = true;
        outputLimitExceeded = true;
        requestTermination();
      }
    });

    child.stderr?.on('data', (chunk: string) => {
      const updated = appendWithByteCap(stderr, chunk, limits.maxStderrBytes);
      stderr = updated.next;
      if (updated.truncated) {
        stderrTruncated = true;
        outputLimitExceeded = true;
        requestTermination();
      }
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({
        exitCode: -1,
        signal: null,
        stdout,
        stderr,
        error,
        timedOut,
        outputLimitExceeded,
        stdoutTruncated,
        stderrTruncated,
      });
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      finish({
        exitCode: code ?? -1,
        signal,
        stdout,
        stderr,
        timedOut,
        outputLimitExceeded,
        stdoutTruncated,
        stderrTruncated,
      });
    });
  });
}

export function parseStatusJson(
  stdout: string,
): Record<string, unknown> | undefined {
  const lines = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]) as Record<string, unknown>;
    } catch {}
  }

  return undefined;
}

export async function runPythonJsonScript(
  scriptName: string,
  scriptArgs: string[],
  stage: string,
  logs: LogEntry[],
  limitsOverride?: Partial<CommandExecutionLimits>,
): Promise<Record<string, unknown>> {
  const scriptPath = resolvePythonScript(scriptName);
  const limits: CommandExecutionLimits = {
    ...DEFAULT_COMMAND_LIMITS,
    ...limitsOverride,
  };
  const log = createLogger(logs);
  let lastFailure: string | undefined;

  for (const pythonCommand of getPythonCandidates()) {
    const result = await runCommand(
      pythonCommand,
      [scriptPath, ...scriptArgs],
      limits,
    );

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
    const statusError =
      typeof status?.error === 'string' ? status.error : undefined;

    if (result.timedOut) {
      lastFailure = `Python ${stage} timed out after ${limits.timeoutMs}ms.`;
      continue;
    }

    if (result.outputLimitExceeded) {
      lastFailure =
        `Python ${stage} exceeded output limits ` +
        `(stdout cap ${limits.maxStdoutBytes} bytes, ` +
        `stderr cap ${limits.maxStderrBytes} bytes).`;
      continue;
    }

    if (result.exitCode !== 0 || statusError) {
      const stderrPreview = result.stderr.slice(0, 2000);
      lastFailure =
        statusError ??
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

export async function writeJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function copyFileIntoBundle(
  sourcePath: string,
  targetPath: string,
): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.copyFile(sourcePath, targetPath);
}

export interface ReplaceDirectoryAtomicallyOptions {
  pathExists?: (targetPath: string) => boolean;
  moveDirectory?: (fromPath: string, toPath: string) => Promise<void>;
  removeDirectory?: (targetPath: string) => Promise<void>;
}

export async function replaceDirectoryAtomically(
  finalDirectory: string,
  preparedDirectory: string,
  options: ReplaceDirectoryAtomicallyOptions = {},
): Promise<void> {
  const pathExists =
    options.pathExists ?? ((targetPath: string) => existsSync(targetPath));
  const moveDirectory =
    options.moveDirectory ??
    ((fromPath: string, toPath: string) => fs.rename(fromPath, toPath));
  const removeDirectory =
    options.removeDirectory ??
    ((targetPath: string) =>
      fs.rm(targetPath, { recursive: true, force: true }));

  const backupDirectory = `${finalDirectory}.backup`;
  let createdBackup = false;

  if (pathExists(backupDirectory)) {
    await removeDirectory(backupDirectory);
  }

  try {
    if (pathExists(finalDirectory)) {
      await moveDirectory(finalDirectory, backupDirectory);
      createdBackup = true;
    }

    await moveDirectory(preparedDirectory, finalDirectory);

    if (createdBackup && pathExists(backupDirectory)) {
      await removeDirectory(backupDirectory);
    }
  } catch (error) {
    if (
      createdBackup &&
      !pathExists(finalDirectory) &&
      pathExists(backupDirectory)
    ) {
      try {
        await moveDirectory(backupDirectory, finalDirectory);
      } catch {
        // Best-effort recovery only.
      }
    }

    if (pathExists(preparedDirectory)) {
      try {
        await removeDirectory(preparedDirectory);
      } catch {
        // Best-effort cleanup only.
      }
    }

    throw error;
  }
}

export async function runStage<T>(
  stageId: string,
  logs: LogEntry[],
  fn: () => Promise<T>,
): Promise<T> {
  const log = createLogger(logs);
  const startMs = Date.now();
  log('info', stageId, `stage:start`);
  try {
    const result = await fn();
    const durationMs = Date.now() - startMs;
    logs.push({
      timestamp: timestamp(),
      level: 'info',
      stage: stageId,
      message: 'stage:end',
      durationMs,
    });
    return result;
  } catch (error: unknown) {
    const durationMs = Date.now() - startMs;
    const message = error instanceof Error ? error.message : String(error);
    logs.push({
      timestamp: timestamp(),
      level: 'error',
      stage: stageId,
      message: 'stage:error',
      durationMs,
      context: { error: message },
    });
    throw error;
  }
}
