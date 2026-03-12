import {
  type AnimationPreset,
  checkAnimationCompatibility,
  generateAnimations,
} from '../../animation.js';
import type {
  ComponentAnimationPlan,
  PoseResult,
  SegResult,
  StageContext,
} from '../contracts.js';
import { createLogger } from '../runtime.js';

function appendUniqueWarnings(target: string[], warnings: string[]): void {
  for (const warning of warnings) {
    if (!target.includes(warning)) {
      target.push(warning);
    }
  }
}

export function generateAnimationPlanStage(
  seg: SegResult,
  pose: PoseResult,
  requestedPresets: AnimationPreset[],
  ctx: StageContext,
): ComponentAnimationPlan[] {
  const log = createLogger(ctx.logs);
  const plans: ComponentAnimationPlan[] = [];

  for (const component of seg.components) {
    const poseComponent = pose.components.find(
      (item) => item.id === component.id,
    );
    if (!poseComponent) {
      throw new Error(
        `Pose result did not contain component "${component.id}".`,
      );
    }

    const boneNames = poseComponent.skeleton.bones.map((bone) => bone.name);
    const compatibility = checkAnimationCompatibility(
      boneNames,
      requestedPresets,
    );
    appendUniqueWarnings(ctx.warnings, compatibility.warnings);

    const animations = generateAnimations(
      boneNames,
      compatibility.supportedPresets,
    );
    plans.push({
      id: component.id,
      label: component.label,
      boneNames,
      animations,
      animationNames: animations.map((animation) => animation.name),
    });

    log('info', 'animation', 'Resolved component animation presets.', {
      componentId: component.id,
      requestedPresets,
      supportedPresets: compatibility.supportedPresets,
      generatedAnimationNames: animations.map((animation) => animation.name),
      compatibilityWarnings: compatibility.warnings,
    });
  }

  return plans;
}
