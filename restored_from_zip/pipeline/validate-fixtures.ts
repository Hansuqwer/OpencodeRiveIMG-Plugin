#!/usr/bin/env node
/**
 * Fixture validation script for CI gate.
 *
 * Scans tests/fixtures/ for:
 *   - golden-*.json  — each must pass all structural invariants
 *   - bad-*.json     — each must be rejected by validateBundleManifest
 *
 * Exit 0 on success, non-zero on failure.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAX_ARTBOARD_DIMENSION,
  MAX_MESH_DENSITY,
  MIN_MESH_DENSITY,
} from './contracts.js';

const REQUIRED_ARTBOARD_PATH_FIELDS = [
  'maskedImagePath',
  'contourSvgPath',
  'meshSvgPath',
  'rigPreviewPath',
  'riveIrPath',
] as const;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, '../../tests/fixtures');

export function validateBundleManifest(manifest: unknown): void {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Manifest must be an object');
  }
  const m = manifest as Record<string, unknown>;

  if (m.schema_version !== 1) {
    throw new Error(
      `Expected schema_version 1, got ${String(m.schema_version)}`,
    );
  }
  if (m.kind !== 'rivebundle') {
    throw new Error(`Expected kind "rivebundle", got ${String(m.kind)}`);
  }

  const exp = m.export as Record<string, unknown> | undefined;
  if (!exp || typeof exp !== 'object') {
    throw new Error('Manifest export field must be an object');
  }
  if (exp.status !== 'fallback') {
    throw new Error(
      `Expected export.status "fallback", got ${String(exp.status)}`,
    );
  }
  if (exp.riv_supported !== false) {
    throw new Error('Expected export.riv_supported to be false');
  }

  // --- config ---
  const config = m.config as Record<string, unknown> | undefined;
  if (!config || typeof config !== 'object') {
    throw new Error('Manifest config field must be an object');
  }
  if (typeof config.mesh_density === 'number') {
    if (
      config.mesh_density < MIN_MESH_DENSITY ||
      config.mesh_density > MAX_MESH_DENSITY
    ) {
      throw new Error(
        `config.mesh_density ${config.mesh_density} is outside the allowed range [${MIN_MESH_DENSITY}, ${MAX_MESH_DENSITY}]`,
      );
    }
  }

  // --- artboards ---
  if (!Array.isArray(m.artboards)) {
    throw new Error('artboards must be an array');
  }

  const seenIds = new Set<string>();

  for (let i = 0; i < (m.artboards as unknown[]).length; i++) {
    const artboard = (m.artboards as unknown[])[i] as Record<string, unknown>;
    if (!artboard || typeof artboard !== 'object') {
      throw new Error(`artboard[${i}] must be an object`);
    }

    // id uniqueness
    if (typeof artboard.id !== 'string' || artboard.id.length === 0) {
      throw new Error(`artboard[${i}].id must be a non-empty string`);
    }
    if (seenIds.has(artboard.id)) {
      throw new Error(`Duplicate artboard id "${artboard.id}" at index ${i}`);
    }
    seenIds.add(artboard.id);

    // counts
    if (typeof artboard.vertexCount !== 'number' || artboard.vertexCount <= 0) {
      throw new Error(`artboard[${i}].vertexCount must be a positive number`);
    }
    if (
      typeof artboard.triangleCount !== 'number' ||
      artboard.triangleCount <= 0
    ) {
      throw new Error(`artboard[${i}].triangleCount must be a positive number`);
    }
    if (typeof artboard.boneCount !== 'number' || artboard.boneCount <= 0) {
      throw new Error(`artboard[${i}].boneCount must be a positive number`);
    }

    // required path fields
    for (const field of REQUIRED_ARTBOARD_PATH_FIELDS) {
      if (
        typeof artboard[field] !== 'string' ||
        (artboard[field] as string).length === 0
      ) {
        throw new Error(`artboard[${i}].${field} must be a non-empty string`);
      }
    }

    // artboardWidth / artboardHeight bounds
    if (
      artboard.artboardWidth !== undefined &&
      artboard.artboardWidth !== null
    ) {
      if (
        typeof artboard.artboardWidth !== 'number' ||
        artboard.artboardWidth < 1 ||
        artboard.artboardWidth > MAX_ARTBOARD_DIMENSION
      ) {
        throw new Error(
          `artboard[${i}].artboardWidth must be between 1 and ${MAX_ARTBOARD_DIMENSION}`,
        );
      }
    }
    if (
      artboard.artboardHeight !== undefined &&
      artboard.artboardHeight !== null
    ) {
      if (
        typeof artboard.artboardHeight !== 'number' ||
        artboard.artboardHeight < 1 ||
        artboard.artboardHeight > MAX_ARTBOARD_DIMENSION
      ) {
        throw new Error(
          `artboard[${i}].artboardHeight must be between 1 and ${MAX_ARTBOARD_DIMENSION}`,
        );
      }
    }
  }

  // --- primary_artboard_id references a real artboard ---
  if (
    m.primary_artboard_id !== null &&
    m.primary_artboard_id !== undefined &&
    typeof m.primary_artboard_id === 'string' &&
    m.primary_artboard_id.length > 0
  ) {
    if (!seenIds.has(m.primary_artboard_id)) {
      throw new Error(
        `primary_artboard_id "${m.primary_artboard_id}" does not reference any artboard id`,
      );
    }
  }
}

async function run(): Promise<void> {
  const entries = await fs.readdir(fixturesDir);

  const goldenFiles = entries
    .filter((name) => name.startsWith('golden-') && name.endsWith('.json'))
    .sort();
  const badFiles = entries
    .filter((name) => name.startsWith('bad-') && name.endsWith('.json'))
    .sort();

  if (goldenFiles.length === 0) {
    throw new Error(
      'No golden-*.json fixture files found in fixtures directory.',
    );
  }
  if (badFiles.length === 0) {
    throw new Error('No bad-*.json fixture files found in fixtures directory.');
  }

  for (const fileName of goldenFiles) {
    const filePath = path.join(fixturesDir, fileName);
    const raw = await fs.readFile(filePath, 'utf8');
    const manifest = JSON.parse(raw) as unknown;
    validateBundleManifest(manifest);
    console.log(`✔ ${fileName} passes all structural invariants`);
  }

  for (const fileName of badFiles) {
    const filePath = path.join(fixturesDir, fileName);
    const raw = await fs.readFile(filePath, 'utf8');
    const manifest = JSON.parse(raw) as unknown;
    let rejected = false;
    try {
      validateBundleManifest(manifest);
    } catch {
      rejected = true;
    }
    assert.equal(
      rejected,
      true,
      `${fileName} should have been rejected by validateBundleManifest`,
    );
    console.log(`✔ ${fileName} is correctly rejected`);
  }

  console.log('\nAll fixture validation checks passed.');
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFixture validation FAILED: ${message}`);
  process.exit(1);
});
