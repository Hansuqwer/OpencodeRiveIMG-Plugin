# OpenCodeRivePlugin Handover

## 1) Executive Summary

This repository is an artifact-first workspace with active runnable source under `restored_from_zip/`.

- Current status: image-to-rig pipeline is operational for `.rivebundle` export; refactored into stage modules (P0 complete); OpenCode plugin wired.
- Current limitation: validated `.riv` generation is explicitly unsupported by design in this codebase.
- Latest important work: P0 pipeline split, OpenCode plugin wired via `.opencode/plugins.ts` + `.opencode/opencode.json`. P1 complete: failure-path tests (54 pass / 6 skip), fixture infrastructure, CI fixture gate. P2 complete: Biome lint gate, Node 22 CI matrix, Python deps in CI (6 previously-skipped tests now pass), DI refactor for run-segmentation/run-pose (6 new unit tests), structured logging (`runStage` wrapper with `durationMs`). P3 complete: performance baselines (4 new constants + artboard/file-size guards), API contract docs (README §§ Node.js API, Input Constraints, Output Bundle Structure), 6 new tests (68 pass / 0 fail / 4 skip). P4 complete: deterministic fixture validation (3 golden: single-artboard, 6-artboard sheet, humanoid; 1 bad; `validateBundleManifest` exported and unit-tested), stageTimeoutMs SLO (exposed in `PipelineOptions`, wired through `commandLimits` to segmentation+pose subprocess calls), cross-platform Python path tests (PYTHON env var, blank env var, fallback), ESM `__dirname` fix in `runtime.ts`, CI pip-audit split (required hard-fail / optional warn-only), SECURITY.md (severity thresholds, response SLAs, lockfile hygiene, reporting process). Final: 83 pass / 0 fail / 4 skip.
- Primary goal for next phase: P5 — see §6 for remaining gaps.

## 2) Repository Reality and Ground Truth

Root (`OpenCodeRivePlugin/`) contains research artifacts, reviews, and snapshots.

- Canonical workspace guidance: `AGENTS.md`
- Capability/fallback metadata: `bundle.json`
- Historical patch snapshot: `OpenCodeRivePlugin_changes.patch`
- Consensus and review docs: `review_*.md`
- Active implementation: `restored_from_zip/`

Do not treat root-level archives (`*.zip`) as editable source. Use `restored_from_zip/` for implementation work.

## 3) Active Codebase Map (`restored_from_zip/`)

- `cli.ts`
  - CLI entrypoint and plugin tool wiring.
  - `init`, `convert`, `check-deps` behaviors.
  - Path traversal hardening via `resolvePathWithinBase` and argument value guarding.
- `cli.ts`
  - CLI entrypoint and legacy `OpenCodeTool`-format plugin stubs.
  - `init`, `convert`, `check-deps` behaviors.
  - Path traversal hardening via `resolvePathWithinBase` and argument value guarding.
- `pipeline.ts`
  - Thin orchestrator (~95 lines); delegates all work to `pipeline/` stage modules.
- `pipeline/contracts.ts`
  - All types, interfaces, and constants shared across stages.
- `pipeline/runtime.ts`
  - Subprocess execution, logger, path normalization, atomic directory replacement.
- `pipeline/validation.ts`
  - Runtime schema validation for `SegResult` and `PoseResult` payloads.
- `pipeline/render.ts`
  - SVG / IR generation.
- `pipeline/stages/validate-input.ts`
  - Input normalization and path safety.
- `pipeline/stages/run-segmentation.ts`
  - Python segmentation subprocess.
- `pipeline/stages/run-pose.ts`
  - Python pose-estimation subprocess.
- `pipeline/stages/generate-animation.ts`
  - Animation plan with compatibility checks.
- `pipeline/stages/assemble-bundle.ts`
  - `.rivebundle` assembly with atomic write.
- `pipeline/stages/finalize-output.ts`
  - `PipelineResult` construction.
- `segment.py`
  - Segmentation / sheet split / contour / mesh extraction stage.
- `pose_estimate.py`
  - Skeleton inference + skinning weights.
  - Guardrails for MediaPipe landmark completeness and optional dependency loading.
- `animation.ts`
  - Procedural animation preset generation.
- `rive-writer.ts`
  - Explicitly marks `.riv` writer unsupported; only preserves low-level byte utilities.
- `pipeline.test.ts`
  - Failure-path tests + fixture-based validation + DI unit tests + performance-baseline tests + SLO tests + cross-platform Python path tests; 87 tests total (83 pass, 0 fail, 4 skip — Python-dependent).
  - Failure-path tests + fixture-based validation + DI unit tests + performance-baseline tests; 72 tests total (68 pass, 0 fail, 4 skip — Python-dependent).
## 4) What We Expect Right Now (Current Contract)

Expected behavior today:

1. Input image (`png`/`jpg`) runs through segmentation, mesh, pose, and animation assembly.
2. Output is `.rivebundle` fallback artifacts with JSON IR + previews + masked assets.
3. If user asks for `.riv` path, flow redirects/communicates fallback semantics; no claim of validated `.riv` support.
4. Pipeline degrades gracefully when optional dependencies are missing (where designed), while reporting constraints clearly.
5. Errors should fail fast and produce actionable diagnostics rather than silently producing unusable output.

Non-goals currently:

- No promise that generated `.riv` files are valid or runtime-loadable.
- No claim of complete skeleton correctness for all non-standard creatures/poses.

## 5) Recent Improvements Already Landed

Recent hardening and refactoring includes:

- Safer path resolution and traversal protection in CLI/plugin path handling.
- Better CLI argument handling for missing value cases.
- Subprocess execution limits in pipeline: timeout, output caps, kill grace behavior.
- Stronger runtime validation for Python IPC payload structures and bounds checks.
- Additional consistency checks for mesh/weights and component invariants.
- Test coverage expanded for path safety, subprocess timeout/output caps, validation failures, and landmark guard behavior.
- Pipeline refactored from monolith to thin orchestrator + 10 stage modules (P0 complete).
- OpenCode plugin wired: `.opencode/plugins.ts` (SDK `tool()` + Zod schemas) + `.opencode/opencode.json`.
- CI workflow added: `.github/workflows/ci.yml`.
- P1 complete: 41 new failure-path tests added (60 total: 54 pass, 0 fail, 6 skip); `tests/fixtures/` created with golden + bad manifests; `pipeline/validate-fixtures.ts` script; `validate:fixtures` npm script; CI fixture validation step.
- P2 complete:
  - **Biome lint gate**: `@biomejs/biome@2.4.6` installed, `biome.json` configured, `npm run lint` CI step added; exits 0.
  - **Node 22 in CI matrix**: `.github/workflows/ci.yml` now tests Node 20 + 22 with `cache-dependency-path`.
  - **Python deps in CI**: `requirements.optional.txt` install step added; 4 previously-skipped Python-dependent tests now pass (total after P2: 62 pass, 0 fail, 4 skip).
  - **DI refactor**: `run-segmentation.ts` and `run-pose.ts` accept an optional `_runScript` injection parameter; 6 new unit tests cover propagate-error, invalid-payload, and path/payload-valid paths.
  - **Structured logging**: `LogEntry.durationMs` added to `pipeline/contracts.ts`; `runStage<T>()` helper in `pipeline/runtime.ts` emits `stage:start`, `stage:end`, and `stage:error` log entries with duration; `pipeline.ts` wraps all 4 stage calls.
- P3 complete:
  - **Performance baselines**: `MIN_MESH_DENSITY`, `MAX_MESH_DENSITY`, `MAX_INPUT_FILE_BYTES`, `MAX_ARTBOARD_DIMENSION` constants added to `pipeline/contracts.ts`; artboard width/height guards and file-size check wired into `normalizeOptions` and `validateInputStage`; 6 new tests (68 pass, 0 fail, 4 skip).
  - **API contract docs**: `restored_from_zip/README.md` extended with `## Node.js API` (full `PipelineOptions`/`PipelineResult` tables + code example), `## Input Constraints` (enforced-limits table), `## Output Bundle Structure` (annotated directory tree).

## 6) What Is Still Missing

### Architecture and Maintainability

- `pipeline.ts` is now a thin orchestrator; stage modules are isolated in `pipeline/`.
- Stage contracts are versioned via `pipeline/contracts.ts`.
- Stage failure-path coverage is now comprehensive for all TypeScript stages; Python-dependent stages remain mocked-only (run-segmentation, run-pose).

### Production Reliability

- Need deterministic artifact validation across representative fixtures.
- Need stronger cross-platform guarantees in CI (Linux/macOS/Windows matrix as applicable).
- Need formal SLO-like behavior for timeouts/retries/exit codes under adverse conditions.

### Security and Supply Chain

- Need CI-enforced dependency audits (`npm audit`, Python tooling equivalents) with clear policy.
- Need explicit release gating for dependency drift and lockfile hygiene.

### Product Contract and Capability Integrity

- Must continue to enforce honest capability reporting (`.rivebundle` is supported; `.riv` is not yet validated).
- Must avoid introducing hidden or ambiguous behavior that implies `.riv` is production-ready.

## 7) What Could Make This Production Ready

## Phase P0 (Immediate, high impact)

1. ~~Split pipeline into stage modules with a thin orchestrator.~~ **Done.**
   - Suggested modules: `validate-input`, `run-segmentation`, `run-pose`, `generate-animation`, `assemble-bundle`, `finalize-output`.
2. ~~Standardize runtime schemas at every stage boundary.~~ **Done (`pipeline/validation.ts`).**
   - Reject malformed payloads early.
3. ~~Centralize command execution policy.~~ **Done (`pipeline/runtime.ts`).**
   - One hardened subprocess helper used by all stage invocations.
4. ~~Make all output writes atomic and recoverable.~~ **Done (`replaceDirectoryAtomically` in `pipeline/runtime.ts`).**
   - Write-temp + rename patterns; cleanup guarantees on interruption.

## Phase P1 (Short-term)

1. ~~Expand test strategy to include failure-path-first suites.~~ **Done.**
   - ~~Timeouts, malformed stage output, partial write failures, cleanup guarantees.~~ **Done (41 new tests, 54 pass total).**
2. ~~Add deterministic fixture-based validation.~~ **Done.**
   - ~~Golden bundle structure checks, invariant checks (weights sum, triangle bounds, bone references).~~ **Done (`tests/fixtures/` + `validate-fixtures.ts`).**
3. ~~Add CI quality gates.~~ **Done (fixture validation step in CI).**
   - ~~Typecheck, lint, tests, dependency audit, and artifact validation checks.~~ **Done (typecheck + tests + fixture validation in CI; lint gate is P2).**

## Phase P2 (Medium-term) — **Complete**

1. ~~Establish observability and release telemetry conventions.~~ **Done.**
   - ~~Structured logs with stable fields and stage IDs.~~ **Done (`runStage` wrapper, `durationMs` in `LogEntry`).**
2. ~~Define performance and scalability baselines.~~ **Done (P3).**
   - ~~Input size constraints, timeout tuning, memory guardrails.~~ **Done (`MAX_INPUT_FILE_BYTES`, `MAX_ARTBOARD_DIMENSION`, `MIN/MAX_MESH_DENSITY` in `contracts.ts`; guards in `runtime.ts` + `validate-input.ts`).**
3. ~~Stabilize API contract for external consumers (CLI + plugin interface docs).~~ **Done (P3: README §§ Node.js API, Input Constraints, Output Bundle Structure).**

## Phase P4 (Current) — **Complete**

1. ~~Deterministic artifact validation across representative fixtures.~~ **Done** — 3 golden fixtures (single, sheet, humanoid) + 1 bad; `validateBundleManifest` exported + 8 unit tests.
2. ~~Formal SLO behavior for timeouts.~~ **Done** — `stageTimeoutMs` in `PipelineOptions`; `commandLimits: CommandExecutionLimits` in `NormalizedPipelineOptions`; wired through `runPythonJsonScript` 5th arg to segmentation + pose stages; 3 SLO tests.
3. ~~Cross-platform Python path guarantees.~~ **Done** — 4 unit tests for `getPythonCandidates` (PYTHON env var, blank env var, fallback) and `resolvePythonScript` error messaging; ESM `__dirname` bug in `runtime.ts` fixed.
4. ~~CI dependency audit policy.~~ **Done** — pip-audit split into required (hard-fail) + optional (warn-only) steps; `SECURITY.md` with severity thresholds + response SLAs + lockfile hygiene + reporting.


## Phase P3 (Long-term) — **Complete**

1. ~~Performance and scalability baselines.~~ **Done** — 4 constants + guards + 6 new tests.
2. ~~API contract docs for external consumers.~~ **Done** — README extended with full API reference.


## 8) Path to Validated `.riv` — Formal Gate Checklist

Treat `.riv` as a separate product milestone. The following gates **must all pass** before `.riv` is marked supported anywhere in docs, CLI, or metadata.

### Gate 1 — Exporter Isolation

- [x] `rive-binary-writer.ts` exposes a clean, versioned export API isolated from the rest of the pipeline. **Done (Phase 1)** — Module exports `RIVE_BINARY_WRITER_VERSION`, `writeRiveFile()`, and `RiveWriterInput`/`RiveWriterResult` types.
- [x] The `.riv` writer path has no shared mutable state with the `.rivebundle` path. **Done (Phase 1)** — `rive-binary-writer.ts` only imports from `rive-format-defs.ts`, `rive-writer.ts`, and type-only imports from `pipeline/contracts.ts`.
- [x] A feature flag is implemented so `.riv` output can be disabled cleanly. **Done (Phase 1)** — `outputFormat?: 'rivebundle' | 'riv'` in `PipelineOptions` with `riv` emitting a warning until Phase 6.
- [x] Phase 2 Static Content encoding complete. **Done (Phase 2)** — `writeRiveFile()` now writes a complete static object graph: Backboard → Artboard(s) → Image → Mesh → MeshVertices → Bones → Skins. Version updated to 0.2.0.

### Gate 2 — Verification Harness

Pinned runtime target for harness bring-up:
- Runtime package: `@rive-app/canvas-lite@2.35.2` (official `rive-wasm` line)
- Runtime source lineage: `rive-app/rive-runtime` (current `main` observed at `b1a967c79687badd5c9abf050a577d9e0ad66689` during bring-up)
- Runtime harness in `pipeline.test.ts` now includes a minimal document/canvas shim so `@rive-app/canvas-lite` can be instantiated in Node CI for load-validation checks.
- Harness scaffold now exists in `restored_from_zip/pipeline.test.ts` behind `RUN_RIVE_GATE2=1`:
  - malformed-bytes rejection check (active when flag set)
  - generated-file load check gated behind `RUN_RIVE_GATE2_EXPECT_PASS=1`

- [x] Automated test suite loads generated `.riv` files via the official Rive runtime and asserts no parse errors (`RUN_RIVE_GATE2_EXPECT_PASS=1`).
- [x] At least 5 representative fixtures pass generation → runtime load without errors. **Done (Phase 2/3 remediation)** — `Gate 2 harness: 5 representative generated fixtures load in official runtime` validates: `single-component-mesh`, `sheet-two-components-with-bones`, `humanoid-style-skeleton`, `animated-bone-tracks`, and `dense-mesh-static`.
- [x] A known-bad fixture is included to verify the harness rejects invalid output. **Done (Phase 2/3 remediation)** — `Gate 2 harness: known-bad trailing-byte fixture is rejected by official runtime` appends one trailing `0x00` byte to a valid file and asserts runtime load fails.

### Gate 3 — Compatibility Matrix

Current matrix scaffold:
- Strict CI job: `riv-gate2-runtime` (`ubuntu-latest`, `macos-latest`, `windows-latest`; Node 22)
- Runtime env flags: `RUN_RIVE_GATE2=1` and `RUN_RIVE_GATE2_EXPECT_PASS=1`
- Status: required (no `continue-on-error`)

Compatibility notes (evidence-backed):
- Runtime package under test: `@rive-app/canvas-lite@2.35.2`
- Runtime version support statement: minimum validated = `2.35.2`, tested = `2.35.2`
- Rive Editor support statement: no supported editor version is currently claimed while `.riv` output remains gated/unsupported
- Known incompatibility boundary: pipeline still exports `.rivebundle` as supported output; `outputFormat: 'riv'` remains a gated path with explicit warning until later gates complete
- Known format sensitivity: a trailing file-level byte after the object stream causes runtime load failure (captured by Gate 2 known-bad fixture test)

- [x] Supported Rive runtime versions are documented (minimum version, tested version).
- [x] Supported Rive editor versions are documented (currently: none claimed while `.riv` is gated).
- [x] Known incompatibilities (e.g., state machine IR version, artboard schema version) are listed.
- [x] The matrix is checked in CI as part of the verification harness run.

### Gate 4 — Strict Fallback Policy

- [x] On any `.riv` generation or validation failure, the tool falls back to `.rivebundle` and reports clearly. **Done (Phase 4)** — fallback is enforced for both `.riv` path requests and `outputFormat: 'riv'` requests (`normalizeOutputBundlePath()` + `normalizeOptions()`), and validated by tests `convert CLI redirects .riv output request to .rivebundle with JSON contract` and `runPipeline keeps explicit fallback semantics when outputFormat riv is requested`.
- [x] No silent fallback: user receives an explicit warning when `.riv` is attempted but fails. **Done (Phase 4)** — warnings are asserted in `normalizeOptions warns explicitly about fallback when outputFormat is riv` and in the end-to-end API/CLI fallback tests above.
- [ ] `bundle.json` `export.status` transitions from `fallback` to `supported` only at final `.riv` enablement after Gates 1–4 are all green.
- [ ] `rive-writer.ts` unsupported marker is removed only when `.riv` support is formally enabled.

**Until all four gates are checked, keep `.riv` marked unsupported in docs, CLI output, `rive-writer.ts`, and `bundle.json`.**

## 9) Suggested Acceptance Criteria (Production Readiness Checklist)

Release candidate should not ship unless all are true:

- [ ] Pipeline stages are modularized with clear contracts and ownership.
- [ ] Runtime schema validation covers all external stage boundaries.
- [ ] Subprocess and filesystem safety policies are centralized and tested.
- [ ] CI passes typecheck/lint/tests/audit on configured platform matrix.
- [ ] Deterministic fixture validation suite passes.
- [ ] Error messaging is actionable and capability claims remain honest.
- [ ] No docs or CLI output implies validated `.riv` unless validation harness is green.

## 10) Immediate Work Order

1. Read and honor constraints in:
   - `AGENTS.md`
   - `bundle.json`
   - `restored_from_zip/README.md`
   - `restored_from_zip/rive-writer.ts`
2. P0 pipeline split is **complete**. P1 failure-path tests + fixture validation + CI gates are **complete**. P2 (lint gate, Node matrix, Python deps, DI refactor, structured logging) is **complete**. P3 (performance baselines, API contract docs) is **complete**. P4 (deterministic fixture validation, stageTimeoutMs SLO wiring, cross-platform Python path tests, ESM __dirname fix, SECURITY.md + CI pip-audit split) is **complete**. 83 pass / 0 fail / 4 skip.
3. Keep `.rivebundle` as the only supported export path until all four gates in §8 pass.
4. OpenCode plugin is wired. Dog-food via oh-my-opencode before expanding features.
5. P4 is complete. Next focus: see §6 remaining gaps (production reliability, security, capability integrity).
4. OpenCode plugin is wired. Dog-food via oh-my-opencode before expanding features.

## 11) Known Good Communication Rule

If uncertain, prefer explicit honesty over optimistic claims.

For this project, that means:

- Say: "supported output is `.rivebundle` fallback"
- Do not say: "`.riv` is supported" unless validated end-to-end gates are implemented and passing.
