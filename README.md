# image-to-rive

An honest OpenCode plugin + CLI that converts a static PNG or JPG into a rigged
`.rivebundle` fallback for Rive authoring.

## What works

Given an input image, the pipeline can:

1. segment the subject using alpha, `rembg`, or a border-colour fallback
2. split sprite sheets into multiple components
3. extract a silhouette contour
4. generate a deformable Delaunay mesh
5. infer a skeleton with:
   - optional MediaPipe for single-image humanoids
   - a stronger heuristic for front-facing creatures
   - a generic centerline fallback
6. compute per-vertex skinning weights using point-to-bone-segment distance
7. generate procedural animation presets
8. export a `.rivebundle` directory with:
   - masked PNG assets
   - contour, mesh, and rig preview SVGs
   - JSON IR for rig, weights, and animations
   - a Rive-style state-machine IR

## What does **not** work

This repository does **not** ship a validated `.riv` writer.

The original code contained a hand-written binary encoder, but there was no
reliable validation path proving that its output could be trusted as a correct
`.riv` file. The supported export path is therefore the `.rivebundle`
intermediate.

## Layout

- `cli.ts` – CLI entry point and OpenCode plugin manifest
- `pipeline.ts` – TS orchestration and `.rivebundle` assembly
- `animation.ts` – procedural animation presets
- `rive-writer.ts` – quarantined byte utilities and explicit `.riv` status
- `segment.py` – segmentation, sheet splitting, contour extraction, mesh generation
- `pose_estimate.py` – skeleton inference and skinning weights
- `pipeline.test.ts` – smoke, pipeline, and bunny-sheet regression tests

## Quick Start (npm)

```bash
# Install globally
npm install -g image-to-rive

# Initialize the plugin in your project
image-to-rive init

# Install Python dependencies
pip install -r requirements.txt
pip install -r requirements.optional.txt

# Verify everything works
image-to-rive check-deps
```

The `init` command creates:
- `.rive/config.json` — project configuration
- `.rive/output/` — default output directory
- Appends a Rive capabilities section to your `AGENTS.md` so AI models know what the plugin can do

## Installation (from source)

```bash
git clone https://github.com/<owner>/image-to-rive.git
cd image-to-rive
npm install
npm run build
npm run setup:python
```

## CLI

```bash
# Basic conversion
image-to-rive convert input.png -o output.rivebundle

# Expression sheet with 6 poses
image-to-rive convert expressions.png -o character.rivebundle --sheet-mode split --mesh-density 0.08 --animations idle,walk --json

# Backward-compatible .riv request: redirected to .rivebundle
image-to-rive convert input.png -o output.riv

# Initialize plugin in a project
image-to-rive init
image-to-rive init --global   # writes to ~/.config/opencode/
image-to-rive init --force    # overwrite existing config

# Dependency check
image-to-rive check-deps
```

## Tests

```bash
npm test
```

The repo includes `tests/assets/ModelExpressions.png` as a real regression
asset. The regression test expects the bunny sheet to split into 6 components
in correct row-major order.

## Skeleton Support

| Subject | Bones | Detection |
|---------|-------|-----------|
| Cartoon biped (rabbit, bear) | 14 | Bilateral symmetry + dual limbs |
| Humanoid | 12 (MediaPipe) or 14 (fallback) | MediaPipe pose or heuristic |
| Quadruped front (dog, cat) | 15-16 | Symmetric + wide + heavy lower body |
| Quadruped side | 13-14 | Wide + low symmetry |
| Generic / non-standard | 4 | Centerline fallback |

## For AI Models

See `INSTALL.md` for step-by-step installation instructions suitable for AI-assisted setup.
After running `image-to-rive init`, your `AGENTS.md` will contain full capability documentation.
