# .riv Writer Phase 2-3 Remediation Plan

## Goal
Fix Phase 2 (static encoding) and Phase 3 (animation encoding) so Gate 2 and Gate 3 can be passed with objective CI evidence, while keeping `.rivebundle` fallback behavior unchanged until final enablement.

## Current Status (2026-03-12)
- Gate 2 runtime-load harness is active and passing locally with `RUN_RIVE_GATE2=1 RUN_RIVE_GATE2_EXPECT_PASS=1`.
- Harness now covers 5 representative generated fixtures plus 1 known-bad trailing-byte rejection fixture.
- CI Gate 2 has been promoted to strict `riv-gate2-runtime` matrix (ubuntu/macos/windows, Node 22, required job).
- Gate 3 compatibility docs are now explicit: runtime version (`2.35.2`), editor support stance (none claimed while `.riv` remains gated), and known incompatibility boundaries are documented.
- Gate 4 fallback evidence now includes explicit `outputFormat: 'riv'` fallback warning semantics plus end-to-end API/CLI fallback tests; `.rivebundle` remains the only supported output while `.riv` stays gated.

## Constraints
- Active code is in `restored_from_zip/`.
- No support claims for `.riv` until runtime-load and compatibility matrix checks are green.
- Every step must have pass criteria that are machine-verifiable in tests/CI.

## Ordered Plan

### 0) Pin the validation target first
**Why first**
All format fixes need one pinned source of truth.

**Changes**
- Choose and pin official runtime artifact + version/commit used for validation.
- Add a tiny smoke harness in tests that runs in CI (can fail initially).

**Pass criteria**
- Runtime target and version are documented.
- Smoke harness executes in CI deterministically.

### 1) Fix header/ToC contract
**Changes**
- Replace count-prefixed ToC writer with runtime-compatible sequence:
  1. property key varuint list,
  2. `0` terminator,
  3. packed 2-bit backing-type map.
- Add test-side ToC decoder matching pinned runtime behavior.

**Files**
- `restored_from_zip/rive-binary-writer.ts`
- `restored_from_zip/pipeline.test.ts`

**Pass criteria**
- Header decodes correctly and first object type is recovered at expected offset.
- Legacy assertions like "ToC count at fixed byte" are removed.

### 2) Correct primitive encoders (including byte-string semantics)
**Changes**
- Validate writer primitive encoders against pinned runtime readers.
- Split "string backing" handling into:
  - text strings,
  - raw byte-string payloads (required for `triangleIndexBytes`).
- Remove silent fallback for unknown property/backing types; fail fast.

**Files**
- `restored_from_zip/rive-writer.ts`
- `restored_from_zip/rive-binary-writer.ts`

**Pass criteria**
- Decode-side tests for uint/float/color/text-string/byte-string.
- Invalid property/backing combinations throw with actionable errors.

### 3) Refactor ID domains and reference rules
**Changes**
- Define explicit ID domains and mapping tables:
  - file object ordering,
  - artboard object index domain,
  - animation/interpolator reference domain.
- Stop relying on unscoped global `nextId` for every reference.
- Add pre-emit structural validator for reference existence + type compatibility.

**Files**
- `restored_from_zip/rive-binary-writer.ts`

**Pass criteria**
- Negative tests catch missing target, wrong-type target, cross-domain misuse.

### 4) Fix static graph legality
**Changes**
- Correct illegal property ownership assignments (especially image/asset boundaries).
- Ensure required parent chains are emitted and legal:
  - mesh parented as runtime expects,
  - meshVertex parent links present,
  - skin/tendon/bone graph links valid.

**Files**
- `restored_from_zip/rive-binary-writer.ts`
- `restored_from_zip/rive-format-defs.ts` (only if metadata corrections are needed)

**Pass criteria**
- Object-level legality tests: only valid properties per type.
- Graph-level tests: required parent links exist and resolve.

### 5) Fix mesh payload and skinning encoding
**Changes**
- Encode `triangleIndexBytes` exactly as pinned runtime decodes it.
- Validate vertex/triangle ranges and ordering before emission.

**Files**
- `restored_from_zip/rive-binary-writer.ts`

**Pass criteria**
- Positive decode test for non-trivial mesh indices.
- Negative test rejects out-of-range indices before write.

### 6) Fix animation graph correctness
**Changes**
- Enforce valid keyed-object/objectId mapping.
- Enforce propertyKey legality against keyed target type.
- Emit and validate required parent links for animation nodes.
- Validate interpolator linking (`interpolatorId`) and required objects.

**Files**
- `restored_from_zip/rive-binary-writer.ts`

**Pass criteria**
- Tests cover valid graph, invalid property key, missing interpolator, and missing parent links.

### 7) Implement Gate 2 runtime-load harness
**Changes**
- Use pinned official runtime harness to load emitted bytes.
- Cover at least 5 representative valid fixtures + 1 known-bad fixture.

**Files**
- `restored_from_zip/pipeline.test.ts` or `restored_from_zip/rive-writer-runtime.test.ts`
- `.github/workflows/ci.yml`

**Pass criteria**
- Valid fixtures load/import successfully.
- Known-bad fixture fails with expected reason.
- Harness is required in CI.

### 8) Implement Gate 3 compatibility matrix
**Changes**
- Pin minimum + current tested runtime versions/commits.
- Run Gate 2 harness across matrix in CI.
- Document compatibility contract and rollback policy.

**Files**
- `.github/workflows/ci.yml`
- `HANDOVER.md`
- `AGENTS.md`

**Pass criteria**
- Matrix jobs green.
- Gate 3 checklist items are evidence-backed and checkable.

### 9) Determinism and final enablement
**Changes**
- Canonicalize iteration order for emitted collections.
- Add byte-for-byte determinism tests.
- Enable `.riv` output path only after all prior pass criteria are met.

**Files**
- `restored_from_zip/rive-binary-writer.ts`
- `restored_from_zip/pipeline.test.ts`
- pipeline wiring files as needed

**Pass criteria**
- Identical input produces identical bytes across repeated runs.
- Capability claims in code/docs exactly match tested behavior.

## Minimum Test Suite Additions
- Contract tests: header/ToC decode and primitive decode checks.
- Static graph tests: parent/reference legality and type compatibility.
- Mesh tests: index payload decode + bounds validation.
- Animation tests: keyed graph linking + interpolator linkage.
- Runtime harness tests: valid load + known-bad rejection.
- Determinism tests: exact byte equality snapshots.

## Definition of Done
- Gate 2 checks in `HANDOVER.md` are satisfied with CI evidence.
- Gate 3 checks in `HANDOVER.md` are satisfied with compatibility matrix evidence.
- `.riv` remains disabled until all required checks are green, then enabled with matching documentation updates.
