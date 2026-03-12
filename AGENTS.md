# PROJECT KNOWLEDGE BASE

**Generated:** 2026-03-09 | **Updated:** 2026-03-11 Europe/Stockholm (P4 complete)
**Commit:** N/A (not a git repository)
**Branch:** N/A (not a git repository)

## OVERVIEW
This repository has an artifact-first root AND an active runnable implementation under `restored_from_zip/`.
Primary truth is in `restored_from_zip/` for live code, `OpenCodeRivePlugin_changes.patch` and `bundle.json` for historical context.

## STRUCTURE
```text
OpenCodeRivePlugin/
├── AGENTS.md                           # this file
├── HANDOVER.md                         # handover doc with .riv gate checklist (§8)
├── SECURITY.md                         # dependency audit policy + severity thresholds + vulnerability reporting
├── .opencode/
│   ├── plugins.ts                      # OpenCode plugin entry point (SDK tool() + Zod)
│   ├── opencode.json                   # project-level plugin registration
│   ├── package.json                    # @opencode-ai/plugin dependency
│   └── node_modules/                   # plugin SDK
├── .github/workflows/ci.yml            # CI: typecheck + build + sequential tests
├── restored_from_zip/                  # ACTIVE IMPLEMENTATION
│   ├── cli.ts                          # CLI entrypoint; path safety; legacy tool stubs
│   ├── index.ts                        # public API re-exports
│   ├── pipeline.ts                     # thin orchestrator; wraps all 4 stages with runStage()
│   ├── pipeline/
│   │   ├── contracts.ts                # all shared types/interfaces/constants; LogEntry.durationMs; MIN/MAX_MESH_DENSITY; MAX_INPUT_FILE_BYTES; MAX_ARTBOARD_DIMENSION
│   │   ├── runtime.ts                  # subprocess execution, atomic dir replacement, runStage<T>()
│   │   ├── validation.ts               # runtime schema validation (SegResult, PoseResult)
│   │   ├── render.ts                   # SVG / IR generation
│   │   └── stages/
│   │       ├── validate-input.ts
│   │       ├── run-segmentation.ts
│   │       ├── run-pose.ts
│   │       ├── generate-animation.ts
│   │       ├── assemble-bundle.ts
│   │       └── finalize-output.ts
│   ├── animation.ts                    # procedural animation presets
│   ├── rive-writer.ts                  # .riv writer explicitly unsupported
│   ├── rive-format-defs.ts              # Rive binary format constants (type keys, property keys, ToC backing types)
│   ├── segment.py                      # Python segmentation stage
│   ├── pose_estimate.py                # Python pose/skeleton stage
│   ├── pipeline.test.ts                # 106 tests: 101 pass / 5 skip (Python-dependent)
│   ├── tests/fixtures/                 # golden-bundle.json + bad-bundle.json + golden-bundle-sheet.json + golden-bundle-humanoid.json
│   ├── biome.json                      # Biome formatter/linter config
│   └── dist/                           # compiled output (tsc)
├── .sisyphus/notepads/                 # local research and handoff prompts
├── 01#Assets/                          # uploaded images and generated model folders
├── OpenCodeRivePlugin_changes.patch    # historical TS/Python snapshot (diff format)
├── bundle.json                         # export metadata; marks .riv as fallback
└── old/                                # historical drafts, reviews, UI prototype
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Understand current repo purpose | `bundle.json` | `export.status` is `fallback`; `.riv` writer intentionally disabled |
| Active implementation | `restored_from_zip/` | Live source with build + tests |
| Plugin entry point | `.opencode/plugins.ts` | Registers `image_to_rive` and `rive_init` tools via SDK |
| Plugin registration | `.opencode/opencode.json` | `"plugin": ["file://.opencode/plugins.ts"]` |
| .riv writer gate criteria | `HANDOVER.md §8` | 4-gate checklist; all must pass before .riv is supported |
| Review fixture image | `01#Assets/01#Images/ModelExpressions.png` | 6-expression bunny sheet |
| Historical codebase snapshot | `OpenCodeRivePlugin_changes.patch` | diff blocks for cli.ts, pipeline.ts, segment.py, pose_estimate.py |
| Prior bug findings | `old/Chatgpt5.4proReview.md` | Security + pipeline issues; includes mixed proposed code |
| Rive binary format constants | `restored_from_zip/rive-format-defs.ts` | All type keys, property keys, backing types, inheritance from official core defs |
| Review Phase 0 handover | `.sisyphus/notepads/handover-phase0-riv-constants.md` | Complete deliverables, findings, review checklist for `.riv` constants module |

## CODE MAP
Active source symbols (AST-derived from `restored_from_zip/`).

| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `runPipeline` | async function | `restored_from_zip/pipeline.ts` | Thin orchestrator; delegates to pipeline/ stages |
| `PipelineOptions` | interface | `restored_from_zip/pipeline/contracts.ts` | Input shape for runPipeline |
| `PipelineResult` | interface | `restored_from_zip/pipeline/contracts.ts` | Output shape from runPipeline |
| `runCommand` | function | `restored_from_zip/pipeline/runtime.ts` | Hardened subprocess executor (timeout + output caps) |
| `replaceDirectoryAtomically` | function | `restored_from_zip/pipeline/runtime.ts` | Atomic dir swap using tmp + rename |
| `runStage` | async function | `restored_from_zip/pipeline/runtime.ts` | Stage wrapper; emits start/end/error logs with `durationMs` |
| `validateSegResult` | function | `restored_from_zip/pipeline/validation.ts` | Runtime shape check for segmentation output |
| `validatePoseResult` | function | `restored_from_zip/pipeline/validation.ts` | Runtime shape check for pose output |
| `resolvePathWithinBase` | function | `restored_from_zip/cli.ts` | Path traversal guard; used by CLI and plugin |
| `image_to_rive` (SDK) | tool() | `.opencode/plugins.ts` | OpenCode SDK convert tool (Zod args) |
| `rive_init` (SDK) | tool() | `.opencode/plugins.ts` | OpenCode SDK init tool (Zod args) |
| `PromptReviewer` | React component | `old/prompt-reviewer.jsx` | Historical UI shell (not active) |
| `MIN_MESH_DENSITY` | constant | `restored_from_zip/pipeline/contracts.ts` | Lower bound for meshDensity option (0.01) |
| `MAX_MESH_DENSITY` | constant | `restored_from_zip/pipeline/contracts.ts` | Upper bound for meshDensity option (0.15) |
| `MAX_INPUT_FILE_BYTES` | constant | `restored_from_zip/pipeline/contracts.ts` | Max input image file size (50 MB) |
| `MAX_ARTBOARD_DIMENSION` | constant | `restored_from_zip/pipeline/contracts.ts` | Max artboard width/height in pixels (8192) |
| `commandLimits` | field | `restored_from_zip/pipeline/contracts.ts` → `NormalizedPipelineOptions` | Resolved `CommandExecutionLimits` built from `stageTimeoutMs` or defaults |
| `stageTimeoutMs` | option | `restored_from_zip/pipeline/contracts.ts` → `PipelineOptions` | Optional per-stage timeout override (ms); validated positive integer |
| `RiveTypeKey` | const object | `restored_from_zip/rive-format-defs.ts` | All Rive object type keys (Artboard=1, Bone=40, Mesh=109, etc.) |
| `RivePropertyKey` | const object | `restored_from_zip/rive-format-defs.ts` | All Rive property keys with backing type, owner, and field name |
| `RiveTypeParent` | const object | `restored_from_zip/rive-format-defs.ts` | Inheritance chains for all Rive types |
| `TocBackingType` | const object | `restored_from_zip/rive-format-defs.ts` | ToC 2-bit backing type codes (Uint=0, String=1, Float=2, Color=3) |
| `RIVE_MAGIC` | constant | `restored_from_zip/rive-format-defs.ts` | File header magic bytes: ASCII "RIVE" |
| `RIVE_MAJOR_VERSION` | constant | `restored_from_zip/rive-format-defs.ts` | Current format major version (7) |
| `getPropertiesForType` | function | `restored_from_zip/rive-format-defs.ts` | Collects own + inherited property defs for a given type |
| `RIVE_BINARY_WRITER_VERSION` | constant | `restored_from_zip/rive-binary-writer.ts` | Module version: '0.4.0' (Phase 2/3 Gate 2 runtime-load path fixed)
| `writeRiveFile` | function | `restored_from_zip/rive-binary-writer.ts` | Main `.riv` writer (experimental; not yet gate-validated)
| `RiveWriterInput` | interface | `restored_from_zip/rive-binary-writer.ts` | Input type for writeRiveFile (segResult, poseResult, animationPlans)
| `RiveWriterResult` | interface | `restored_from_zip/rive-binary-writer.ts` | Output type from writeRiveFile (bytes, artboardCount, boneCount, warnings)
| `outputFormat` | option | `restored_from_zip/pipeline/contracts.ts` → `PipelineOptions` | Requested output format: 'rivebundle' | 'riv' (still fallback in pipeline)
## CONVENTIONS
- Active implementation is in `restored_from_zip/`; do not edit root-level archives.
- Plugin entry point is `.opencode/plugins.ts`; imports from `restored_from_zip/dist/pipeline.js` at runtime.
- Preserve explicit honesty: supported output is `.rivebundle` fallback only; `.riv` is gated (see HANDOVER.md §8).
- Prefer adding context notes over editing binary artifacts (`*.zip`).
- Save new research and execution prompts in `.sisyphus/notepads/` so they persist in-repo.
- Build: `cd restored_from_zip && npm run build` — must be clean before plugin can be used.
- Test: `node --test dist/pipeline.test.js` inside `restored_from_zip/` — 115 pass, 5 skip expected.
- Lint: `cd restored_from_zip && npm run lint` — must exit 0 (Biome CI check).
- Validate fixtures: `cd restored_from_zip && npm run validate:fixtures` — must exit 0.

## ANTI-PATTERNS (THIS PROJECT)
- Do not claim validated `.riv` generation; `bundle.json` marks fallback and HANDOVER.md §8 lists the 4 gates.
- Do not treat root archive zips as editable source; use `restored_from_zip/` instead.
- Do not run `npm run build` at the workspace root — the build is in `restored_from_zip/`.
- Do not use `old/` planning transcripts as canonical implementation truth when they conflict with live source.

## UNIQUE STYLES
- Historical material mixes planning prose, generated code, and transcripts in very large files.
- Terminology emphasizes "honest" capability reporting and fallback behavior.
- Project intent centers on image-to-rig pipelines; active source checkout is in `restored_from_zip/`.

## COMMANDS
```bash
# Build the implementation (required before plugin works)
cd restored_from_zip && npm run build

# Run tests (sequential, as required by environment)
cd restored_from_zip && node --test dist/pipeline.test.js

# Gate 2 runtime-load verification (official runtime package wiring)
cd restored_from_zip && RUN_RIVE_GATE2=1 RUN_RIVE_GATE2_EXPECT_PASS=1 node --test dist/pipeline.test.js

# Typecheck only (no emit)
cd restored_from_zip && npm run typecheck

# Inventory local files quickly
rg --files

# Find capability claims and fallback markers
grep -nE "fallback|\.rivebundle|\.riv" bundle.json restored_from_zip/rive-writer.ts

# Inspect archive members without extracting
python -m zipfile -l "OpenCodeRivePlugin_fixed.zip"
python -m zipfile -l "bunny-output.rivebundle.zip"
```

## NOTES
- AGENTS.md was originally auto-generated (2026-03-09); updated 2026-03-11 (P1 complete: 54 pass / 0 fail / 6 skip, fixture validation in CI); updated 2026-03-11 (P2 complete: 62 pass / 0 fail / 4 skip, Biome lint gate, Node 22 matrix, Python deps in CI, DI refactor, structured logging); updated 2026-03-11 (P3 complete: 68 pass / 0 fail / 4 skip, performance-baseline constants + guards, README API contract docs); updated 2026-03-11 (P4 complete: 83 pass / 0 fail / 4 skip, deterministic fixture validation (3 golden + 1 bad), stageTimeoutMs SLO wiring, cross-platform Python path tests, __dirname ESM fix in runtime.ts, SECURITY.md + CI pip-audit split); updated 2026-03-12 (Phase 0: 106 pass / 0 fail / 5 skip, rive-format-defs.ts constants module with all Rive type/property keys from official core defs, 20 new unit tests, roadmap Section 5 revised to eliminate Option B (parser-only tool), Option A (direct binary writer) confirmed as only viable path); updated 2026-03-12 (Phase 1: 112 pass / 0 fail / 5 skip, rive-binary-writer.ts with clean API, outputFormat feature flag, Gate 1 (Exporter Isolation) complete); updated 2026-03-12 (Phase 2/3 remediation advanced: removed trailing file-level terminator that broke runtime load, expanded Gate 2 runtime harness to 5 representative generated fixtures plus one known-bad trailing-byte rejection fixture, and promoted CI to strict `riv-gate2-runtime` matrix; 118 pass / 0 fail / 5 skip); updated 2026-03-12 (Phase 4 strict fallback policy hardening: explicit `outputFormat: 'riv'` fallback warning + end-to-end API fallback manifest assertions + Gate 4 checklist/docs sync; local verification with `RUN_RIVE_GATE2=1 RUN_RIVE_GATE2_EXPECT_PASS=1 npm test` reports 118 pass / 0 fail / 6 skip).
- `restored_from_zip/` is the canonical active source tree with `package.json`, `tsconfig.json`, and runnable `npm run build`.
- OpenCode plugin is registered at `.opencode/opencode.json`; plugin entry point is `.opencode/plugins.ts`.
- GitHub remote: `https://github.com/Hansuqwer/OpencodeRiveIMG-Plugin` (main).
