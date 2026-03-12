import type {
  BundleAssemblyResult,
  NormalizedPipelineOptions,
  PipelineResult,
} from '../contracts.js';

export function finalizeOutputStage(
  opts: NormalizedPipelineOptions,
  bundle: BundleAssemblyResult,
  warnings: string[],
): PipelineResult {
  const primaryComponent = bundle.components[0];
  if (!primaryComponent) {
    throw new Error('Bundle did not contain a primary artboard.');
  }

  const primaryAnimationPlan = bundle.animationPlans.find(
    (plan) => plan.id === primaryComponent.id,
  );

  return {
    outputPath: opts.outputBundle,
    bundlePath: opts.outputBundle,
    rivPath: opts.outputBundle,
    manifestPath: bundle.manifestPath,
    stateMachinePath: bundle.stateMachinePath,
    importNotesPath: bundle.importNotesPath,
    logsPath: bundle.logsPath,
    exportKind: 'rivebundle',
    exportStatus: 'fallback',
    primaryArtboardId: primaryComponent.id,
    artboardCount: bundle.components.length,
    artboardWidth: primaryComponent.artboardWidth,
    artboardHeight: primaryComponent.artboardHeight,
    boneCount: primaryComponent.boneCount,
    vertexCount: primaryComponent.vertexCount,
    triangleCount: primaryComponent.triangleCount,
    animationNames: primaryAnimationPlan?.animationNames ?? [],
    skeletonType: primaryComponent.skeletonType,
    warnings,
    components: bundle.components,
  };
}
