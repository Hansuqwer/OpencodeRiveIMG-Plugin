# OpenCode Rive Plugin Beginner Guide

This repository helps you turn a `png`, `jpg`, or expression sheet into a rigged `.rivebundle` that you can inspect and import into a Rive workflow.

If you are completely new, start here.

Important: this project does **not** currently generate a validated `.riv` binary. The supported output is a `.rivebundle` fallback.

## What this project is

- `OpenCode` plugin: lets an AI tool call `image_to_rive` and `rive_init`
- CLI tool: lets you run the same pipeline from the terminal
- Pipeline: takes an image through validation, segmentation, pose detection, animation planning, and bundle assembly

## Repository layout

This repo has two important parts:

- `.opencode/` - OpenCode plugin registration and plugin SDK dependency
- `restored_from_zip/` - active implementation, CLI, pipeline, Python scripts, build output

If you want to change or run the real pipeline code, work in `restored_from_zip/`.

## Before you start

You need:

- Node.js `18.18+`
- Python `3.9+`
- `npm`
- `pip`

## First-time setup

Run these commands from the repo root:

```bash
npm install --prefix .opencode
npm install --prefix restored_from_zip
npm run build --prefix restored_from_zip
python3 -m pip install -r restored_from_zip/requirements.txt
python3 -m pip install -r restored_from_zip/requirements.optional.txt
```

What these do:

- installs the OpenCode plugin SDK used by `.opencode/plugins.ts`
- installs the pipeline dependencies used by `restored_from_zip/`
- builds `restored_from_zip/dist/`, which the plugin loads at runtime
- installs required and optional Python packages used by segmentation and pose stages

## How plugin initialization works

There are two different setup concepts in this project.

### 1. OpenCode plugin registration

This repo already includes plugin registration in `.opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file://.opencode/plugins.ts"]
}
```

That means OpenCode can load the local plugin from this repository once the dependencies are installed and the pipeline is built.

### 2. Project initialization for Rive output

After the plugin is available, run the init command for the project you want to use:

```bash
node restored_from_zip/dist/cli.js init
```

This creates and updates:

- `.rive/config.json`
- `.rive/output/`
- `AGENTS.md` with a Rive plugin capability section

If you prefer to do the same thing through OpenCode, use the `rive_init` tool.

## Check that everything is ready

Run:

```bash
node restored_from_zip/dist/cli.js check-deps
```

All required dependencies should show as `OK`:

- `numpy`
- `cv2`
- `PIL`
- `scipy`
- `skimage`

Optional packages:

- `rembg`
- `mediapipe`

The optional packages improve results, but the required ones are the minimum.

## Your first conversion

Put an image somewhere inside the repo, for example `01#Assets/example.png`, then run:

```bash
node restored_from_zip/dist/cli.js convert "01#Assets/example.png" -o "01#Assets/example.rivebundle" --json
```

You can also omit `-o` and the tool will create `<image-name>.rivebundle` next to the image.

Common options:

- `--mesh-density 0.08` - denser mesh, range is `0.01` to `0.15`
- `--animations idle,walk,wave` - choose animation presets
- `--sheet-mode auto|single|split` - control sprite sheet handling
- `--width 1024 --height 1024` - override artboard size
- `--keep-temp` - keep intermediate temp files for debugging
- `--json` - print structured output instead of human-readable text

Example with more options:

```bash
node restored_from_zip/dist/cli.js convert "01#Assets/example.png" \
  -o "01#Assets/example.rivebundle" \
  --mesh-density 0.08 \
  --animations idle,walk \
  --sheet-mode auto \
  --json
```

## Using it through OpenCode

Once the plugin is loaded, OpenCode exposes two tools:

- `rive_init`
- `image_to_rive`

`image_to_rive` accepts these beginner-relevant arguments:

- `input_image`
- `output_bundle`
- `mesh_density`
- `animations`
- `artboard_width`
- `artboard_height`
- `sheet_mode`
- `keep_temp`

The tool resolves relative paths from the current project directory.

## Pipeline flow

The main pipeline function is `runPipeline()` in `restored_from_zip/pipeline.ts`.

This is the flow in plain English:

1. `validate-input` - checks file path, extension, file size, options, and output path
2. `segmentation` - runs `segment.py` to isolate the subject, split sheets, trace contour, and build the mesh
3. `pose` - runs `pose_estimate.py` to infer the skeleton and skinning weights
4. `animation` - generates compatible animation presets like `idle`, `walk`, or `wave`
5. `bundle` - writes the `.rivebundle` directory with JSON, PNG, and SVG artifacts
6. `finalize` - returns the final result object with paths, counts, warnings, and metadata

The pipeline also records logs and stage durations.

## What gets created in the output bundle

Typical output looks like this:

```text
example.rivebundle/
├── bundle.json
├── state_machine.json
├── IMPORT_INTO_RIVE.md
├── logs.json
└── artboards/
    └── subject_01/
        ├── masked.png
        ├── segmentation.json
        ├── pose.json
        ├── animations.json
        ├── rive_ir.json
        ├── contour.svg
        ├── mesh.svg
        └── rig-preview.svg
```

This gives you:

- the cleaned subject image
- the generated mesh
- the inferred bones and weights
- animation data
- preview files so you can inspect what happened

## What kinds of images work best

Best results usually come from:

- one clear character on a simple background
- front-facing cartoon bipeds or humanoid-like characters
- expression sheets with neat spacing
- white or transparent backgrounds

Supported subject handling is best for:

- cartoon bipeds
- humanoids
- front-facing quadrupeds
- side-view quadrupeds

If the subject is unusual, the pipeline may fall back to a simpler generic skeleton.

## Limits and honest expectations

These limits are enforced by the code:

- input image max size: `50 MB`
- artboard width or height max: `8192 px`
- mesh density range: `0.01` to `0.15`

Important limitations:

- output is `.rivebundle`, not a validated `.riv`
- non-standard limbs like wings or tentacles are not individually rigged
- humanoid detection is better when `mediapipe` is available
- segmentation is better when `rembg` is available
- expression-sheet splitting works best with clean grids

## Troubleshooting

### `check-deps` says something is missing

Re-run:

```bash
python3 -m pip install -r restored_from_zip/requirements.txt
python3 -m pip install -r restored_from_zip/requirements.optional.txt
```

### OpenCode can see the plugin file but the tool fails

Make sure you built the pipeline first:

```bash
npm run build --prefix restored_from_zip
```

The plugin loads `restored_from_zip/dist/pipeline.js`, so the build must exist.

### You get no output bundle

Check:

- your input path is correct
- the file is a `png`, `jpg`, or `jpeg`
- the file is under the allowed size limit
- Python dependencies are installed

### You want more technical details

See `restored_from_zip/README.md` for the API contract and lower-level reference details.

## Useful commands

```bash
# Build the pipeline
npm run build --prefix restored_from_zip

# Initialize the current project
node restored_from_zip/dist/cli.js init

# Check Python dependencies
node restored_from_zip/dist/cli.js check-deps

# Convert an image
node restored_from_zip/dist/cli.js convert "01#Assets/example.png" --json

# Run tests
npm test --prefix restored_from_zip
```

## In one sentence

Install dependencies, build `restored_from_zip`, run `init`, verify Python dependencies, then run `convert` on a character image to get a `.rivebundle` you can inspect and use as a Rive-ready intermediate.
