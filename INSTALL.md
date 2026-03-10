# Installing image-to-rive

This document is intended for AI models assisting users with OpenCode CLI or similar
environments. Follow these steps exactly.

## Prerequisites

- Node.js ≥ 18.18
- Python 3.9+ with pip
- npm

## Option A: Install from npm (Recommended)

```bash
# Install globally
npm install -g image-to-rive

# Or install locally in a project
npm install image-to-rive
```

## Option B: Install from GitHub

```bash
# Clone the repository (URL placeholder — replace when repo is published)
git clone https://github.com/<owner>/image-to-rive.git
cd image-to-rive
npm install
npm run build
```

## Initialize the plugin

After installation, run the init command to set up your project:

```bash
# Initialize in current project directory
image-to-rive init

# Or initialize globally (writes to ~/.config/opencode/)
image-to-rive init --global
```

This creates:
1. `.rive/config.json` — project configuration with sensible defaults
2. `.rive/output/` — default output directory for generated bundles
3. Appends a Rive capabilities section to `AGENTS.md` so your AI model knows what the plugin can do

## Install Python dependencies

The pipeline requires Python packages for image processing:

```bash
# Required (segmentation, mesh, contour)
pip install numpy opencv-python Pillow scipy scikit-image

# Optional but recommended (better segmentation, humanoid pose detection)
pip install "rembg==2.0.72" "onnxruntime==1.24.3" mediapipe
```

Or use the bundled requirements files:

```bash
pip install -r node_modules/image-to-rive/requirements.txt
pip install -r node_modules/image-to-rive/requirements.optional.txt
```

## Verify installation

```bash
image-to-rive check-deps
```

All "required" items must show `OK`. Optional items (`rembg`, `mediapipe`) improve quality
but are not strictly necessary.

## Quick test

```bash
image-to-rive convert your-image.png -o test-output.rivebundle --json
```

## What the plugin produces

Output is a `.rivebundle` directory (NOT a validated `.riv` binary) containing:
- Masked PNG assets
- Mesh, contour, and rig preview SVGs
- JSON IR for skeleton, weights, animations, and state machine
- Import instructions for Rive editor

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `rembg` import fails | `pip install "rembg==2.0.72" "onnxruntime==1.24.3"` |
| `mediapipe` import fails | `pip install mediapipe` (x86_64 only) |
| `skimage` import fails | `pip install scikit-image` |
| Python not found | Ensure `python3` is on PATH, or use a venv |
| Init says "scripts not found" | Run from the project root or ensure npm installed the package correctly |
