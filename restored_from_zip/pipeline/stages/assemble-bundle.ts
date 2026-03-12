import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getRiveWriterStatus } from '../../rive-writer.js';
import type {
  BundleAssemblyResult,
  ComponentAnimationPlan,
  NormalizedPipelineOptions,
  PipelineArtboardSummary,
  PoseResult,
  SegResult,
  StageContext,
} from '../contracts.js';
import { TOOL_NAME, TOOL_VERSION } from '../contracts.js';
import {
  makeContourSvg,
  makeImportNotes,
  makeMeshSvg,
  makeRigPreviewSvg,
  makeRiveIr,
  makeStateMachineIr,
} from '../render.js';
import {
  copyFileIntoBundle,
  createLogger,
  replaceDirectoryAtomically,
  toPosixPath,
  writeJson,
} from '../runtime.js';
import { validateComponentConsistency } from '../validation.js';

function prefixBundlePath(
  bundleDirectory: string,
  relativePath: string,
): string {
  return toPosixPath(path.join(path.basename(bundleDirectory), relativePath));
}

export async function assembleBundleStage(
  opts: NormalizedPipelineOptions,
  seg: SegResult,
  pose: PoseResult,
  animationPlans: ComponentAnimationPlan[],
  ctx: StageContext,
): Promise<BundleAssemblyResult> {
  const finalBundleDir = opts.outputBundle;
  await fs.mkdir(path.dirname(finalBundleDir), { recursive: true });

  const tempBundleDir = await fs.mkdtemp(
    path.join(
      path.dirname(finalBundleDir),
      `${path.basename(finalBundleDir)}.tmp-`,
    ),
  );
  const log = createLogger(ctx.logs);

  try {
    const artboardsDir = path.join(tempBundleDir, 'artboards');
    await fs.mkdir(artboardsDir, { recursive: true });

    const animationPlanById = new Map(
      animationPlans.map((plan) => [plan.id, plan]),
    );
    const componentSummaries: PipelineArtboardSummary[] = [];
    const stateItems: Array<{
      id: string;
      label: string;
      animations: ComponentAnimationPlan['animations'];
    }> = [];

    for (const component of seg.components) {
      const poseComponent = pose.components.find(
        (item) => item.id === component.id,
      );
      if (!poseComponent) {
        throw new Error(
          `Pose result did not contain component "${component.id}".`,
        );
      }

      const animationPlan = animationPlanById.get(component.id);
      if (!animationPlan) {
        throw new Error(
          `Animation plan did not contain component "${component.id}".`,
        );
      }

      validateComponentConsistency(component, poseComponent);

      const artboardWidth = opts.artboardWidth ?? component.image_size.w;
      const artboardHeight = opts.artboardHeight ?? component.image_size.h;
      const artboardDir = path.join(artboardsDir, component.id);
      await fs.mkdir(artboardDir, { recursive: true });

      const maskedTarget = path.join(artboardDir, 'masked.png');
      await copyFileIntoBundle(component.masked_png_path, maskedTarget);
      await writeJson(path.join(artboardDir, 'segmentation.json'), component);
      await writeJson(path.join(artboardDir, 'pose.json'), poseComponent);
      await writeJson(
        path.join(artboardDir, 'animations.json'),
        animationPlan.animations,
      );
      await writeJson(
        path.join(artboardDir, 'rive_ir.json'),
        makeRiveIr(
          component,
          poseComponent,
          animationPlan.animations,
          artboardWidth,
          artboardHeight,
        ),
      );
      await fs.writeFile(
        path.join(artboardDir, 'contour.svg'),
        makeContourSvg(component),
        'utf8',
      );
      await fs.writeFile(
        path.join(artboardDir, 'mesh.svg'),
        makeMeshSvg(component),
        'utf8',
      );
      await fs.writeFile(
        path.join(artboardDir, 'rig-preview.svg'),
        makeRigPreviewSvg(component, poseComponent),
        'utf8',
      );

      stateItems.push({
        id: component.id,
        label: component.label,
        animations: animationPlan.animations,
      });

      const relativeDir = toPosixPath(
        path.relative(tempBundleDir, artboardDir),
      );
      componentSummaries.push({
        id: component.id,
        name: component.label,
        bundleDir: relativeDir,
        maskedImagePath: `${relativeDir}/masked.png`,
        contourSvgPath: `${relativeDir}/contour.svg`,
        meshSvgPath: `${relativeDir}/mesh.svg`,
        rigPreviewPath: `${relativeDir}/rig-preview.svg`,
        riveIrPath: `${relativeDir}/rive_ir.json`,
        sourceBounds: component.source_bounds,
        artboardWidth,
        artboardHeight,
        boneCount: poseComponent.skeleton.bones.length,
        vertexCount: component.mesh.vertices.length,
        triangleCount: component.mesh.triangles.length,
        skeletonType: poseComponent.skeleton.type,
      });

      log('info', 'bundle', 'Wrote component bundle artifacts.', {
        componentId: component.id,
        artboardDir,
        vertexCount: component.mesh.vertices.length,
        triangleCount: component.mesh.triangles.length,
        boneCount: poseComponent.skeleton.bones.length,
        generatedAnimations: animationPlan.animationNames,
      });
    }

    const stateMachinePath = path.join(tempBundleDir, 'state_machine.json');
    const logsPath = path.join(tempBundleDir, 'logs.json');
    const importNotesPath = path.join(tempBundleDir, 'IMPORT_INTO_RIVE.md');
    const manifestPath = path.join(tempBundleDir, 'bundle.json');

    await writeJson(stateMachinePath, makeStateMachineIr(stateItems));
    await writeJson(logsPath, ctx.logs);
    await fs.writeFile(importNotesPath, makeImportNotes(), 'utf8');

    const manifest = {
      schema_version: 1,
      kind: 'rivebundle',
      export: {
        status: 'fallback',
        output_format: 'rivebundle',
        riv_supported: false,
        writer_status: getRiveWriterStatus(),
      },
      tool: {
        name: TOOL_NAME,
        version: TOOL_VERSION,
      },
      input: {
        source_image: opts.inputImage,
        requested_output_path: opts.requestedOutputPath,
        actual_output_path: opts.outputBundle,
        sheet_detected: seg.sheet.sheet_detected,
        component_count: seg.components.length,
        background_method: seg.background_method,
      },
      config: {
        mesh_density: opts.meshDensity,
        animations: opts.animations,
        artboard_width_override: opts.artboardWidth ?? null,
        artboard_height_override: opts.artboardHeight ?? null,
        sheet_mode: opts.sheetMode,
      },
      primary_artboard_id:
        componentSummaries.length > 0 ? componentSummaries[0]?.id : null,
      artboards: componentSummaries,
      state_machine_path: 'state_machine.json',
      logs_path: 'logs.json',
      import_notes_path: 'IMPORT_INTO_RIVE.md',
    };
    await writeJson(manifestPath, manifest);

    await replaceDirectoryAtomically(finalBundleDir, tempBundleDir, {
      pathExists: (targetPath) => existsSync(targetPath),
    });

    return {
      manifestPath: path.join(finalBundleDir, 'bundle.json'),
      stateMachinePath: path.join(finalBundleDir, 'state_machine.json'),
      importNotesPath: path.join(finalBundleDir, 'IMPORT_INTO_RIVE.md'),
      logsPath: path.join(finalBundleDir, 'logs.json'),
      animationPlans,
      components: componentSummaries.map((component) => ({
        ...component,
        bundleDir: prefixBundlePath(finalBundleDir, component.bundleDir),
        maskedImagePath: prefixBundlePath(
          finalBundleDir,
          component.maskedImagePath,
        ),
        contourSvgPath: prefixBundlePath(
          finalBundleDir,
          component.contourSvgPath,
        ),
        meshSvgPath: prefixBundlePath(finalBundleDir, component.meshSvgPath),
        rigPreviewPath: prefixBundlePath(
          finalBundleDir,
          component.rigPreviewPath,
        ),
        riveIrPath: prefixBundlePath(finalBundleDir, component.riveIrPath),
      })),
    };
  } catch (error) {
    await fs.rm(tempBundleDir, { recursive: true, force: true });
    throw error;
  }
}
