/**
 * animation.ts
 *
 * Generates procedural animations for a rigged skeleton.
 * Produces RiveAnimationDef objects consumed by the Rive builder.
 *
 * Supported animation types:
 *   - idle     : gentle breathing + sway
 *   - walk     : leg swing + arm counterswing + bounce
 *   - wave     : single-arm wave gesture
 *   - jump     : anticipation → air → landing
 *   - run      : faster walk cycle with lean
 *   - death    : fall over (generic, gravity-like rotation)
 */

import { BONE_GROUPS, BONE_NAMES } from './bone-names.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface Keyframe {
  frame: number; // integer frame number
  value: number; // property value (float)
  interp?: 0 | 1 | 2; // 0=hold, 1=linear, 2=cubic
}

export interface BoneTrack {
  boneName: string;
  property: 'rotation' | 'x' | 'y' | 'scaleX' | 'scaleY';
  keyframes: Keyframe[];
}

export interface RiveAnimationDef {
  name: string;
  fps: number;
  durationFrames: number;
  loopType: 0 | 1 | 2; // 0=oneShot, 1=loop, 2=pingPong
  tracks: BoneTrack[];
}

export type AnimationPreset =
  | 'idle'
  | 'walk'
  | 'wave'
  | 'jump'
  | 'run'
  | 'death';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function deg(d: number): number {
  return (d * Math.PI) / 180;
}

function _lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Build a simple 2-keyframe ping-pong track */
function pingPong(
  boneName: string,
  property: BoneTrack['property'],
  valA: number,
  valB: number,
  frame0: number,
  frame1: number,
): BoneTrack {
  return {
    boneName,
    property,
    keyframes: [
      { frame: frame0, value: valA, interp: 2 },
      { frame: frame1, value: valB, interp: 2 },
    ],
  };
}

function constantTrack(
  boneName: string,
  property: BoneTrack['property'],
  value: number,
): BoneTrack {
  return {
    boneName,
    property,
    keyframes: [{ frame: 0, value, interp: 1 }],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Animation presets
// ─────────────────────────────────────────────────────────────────────────────

function buildIdle(boneNames: string[]): RiveAnimationDef {
  const fps = 24;
  const totalFrames = 48; // 2-second loop

  const hasBone = (n: string) => boneNames.includes(n);
  const tracks: BoneTrack[] = [];

  // Body sway (spine, if present)
  if (hasBone('spine')) {
    tracks.push({
      boneName: 'spine',
      property: 'rotation',
      keyframes: [
        { frame: 0, value: deg(0), interp: 2 },
        { frame: 12, value: deg(1.5), interp: 2 },
        { frame: 24, value: deg(0), interp: 2 },
        { frame: 36, value: deg(-1.5), interp: 2 },
        { frame: 48, value: deg(0), interp: 2 },
      ],
    });
  }

  // Breathing: chest Y offset
  if (hasBone('neck')) {
    tracks.push({
      boneName: 'neck',
      property: 'y',
      keyframes: [
        { frame: 0, value: 0, interp: 2 },
        { frame: 16, value: -3, interp: 2 },
        { frame: 32, value: 0, interp: 2 },
        { frame: 48, value: 0, interp: 2 },
      ],
    });
  }

  // Arm idle sway
  for (const side of ['l', 'r'] as const) {
    const sign = side === 'l' ? 1 : -1;
    const arm = `${side}_upper_arm`;
    if (hasBone(arm)) {
      tracks.push({
        boneName: arm,
        property: 'rotation',
        keyframes: [
          { frame: 0, value: deg(sign * 2), interp: 2 },
          { frame: 24, value: deg(-sign * 2), interp: 2 },
          { frame: 48, value: deg(sign * 2), interp: 2 },
        ],
      });
    }
  }

  // Head slight bob
  if (hasBone('head')) {
    tracks.push({
      boneName: 'head',
      property: 'rotation',
      keyframes: [
        { frame: 0, value: deg(0), interp: 2 },
        { frame: 24, value: deg(2), interp: 2 },
        { frame: 48, value: deg(0), interp: 2 },
      ],
    });
  }

  // Generic bone fallback
  if (tracks.length === 0 && boneNames.length > 0) {
    for (const name of boneNames.slice(0, 3)) {
      tracks.push(pingPong(name, 'rotation', deg(-3), deg(3), 0, 24));
    }
  }

  return {
    name: 'Idle',
    fps,
    durationFrames: totalFrames,
    loopType: 1,
    tracks,
  };
}

function buildWalk(boneNames: string[]): RiveAnimationDef {
  const fps = 24;
  const totalFrames = 24; // 1-second cycle
  const hasBone = (n: string) => boneNames.includes(n);
  const tracks: BoneTrack[] = [];

  const swingAng = deg(30);

  // Leg swing (opposite phase)
  if (hasBone('l_upper_leg') && hasBone('r_upper_leg')) {
    tracks.push({
      boneName: 'l_upper_leg',
      property: 'rotation',
      keyframes: [
        { frame: 0, value: -swingAng, interp: 2 },
        { frame: 12, value: swingAng, interp: 2 },
        { frame: 24, value: -swingAng, interp: 2 },
      ],
    });
    tracks.push({
      boneName: 'r_upper_leg',
      property: 'rotation',
      keyframes: [
        { frame: 0, value: swingAng, interp: 2 },
        { frame: 12, value: -swingAng, interp: 2 },
        { frame: 24, value: swingAng, interp: 2 },
      ],
    });
  }

  // Knee bend on stride leg
  if (hasBone('l_lower_leg') && hasBone('r_lower_leg')) {
    tracks.push({
      boneName: 'l_lower_leg',
      property: 'rotation',
      keyframes: [
        { frame: 0, value: 0, interp: 2 },
        { frame: 6, value: deg(-20), interp: 2 },
        { frame: 12, value: 0, interp: 2 },
        { frame: 24, value: 0, interp: 2 },
      ],
    });
    tracks.push({
      boneName: 'r_lower_leg',
      property: 'rotation',
      keyframes: [
        { frame: 0, value: 0, interp: 2 },
        { frame: 18, value: deg(-20), interp: 2 },
        { frame: 24, value: 0, interp: 2 },
      ],
    });
  }

  // Counter-swing arms
  if (hasBone('l_upper_arm') && hasBone('r_upper_arm')) {
    tracks.push({
      boneName: 'l_upper_arm',
      property: 'rotation',
      keyframes: [
        { frame: 0, value: deg(20), interp: 2 },
        { frame: 12, value: deg(-20), interp: 2 },
        { frame: 24, value: deg(20), interp: 2 },
      ],
    });
    tracks.push({
      boneName: 'r_upper_arm',
      property: 'rotation',
      keyframes: [
        { frame: 0, value: deg(-20), interp: 2 },
        { frame: 12, value: deg(20), interp: 2 },
        { frame: 24, value: deg(-20), interp: 2 },
      ],
    });
  }

  // Vertical bob (spine or root)
  const bobTarget = hasBone('spine') ? 'spine' : (boneNames[0] ?? 'root');
  tracks.push({
    boneName: bobTarget,
    property: 'y',
    keyframes: [
      { frame: 0, value: 0, interp: 2 },
      { frame: 6, value: -4, interp: 2 },
      { frame: 12, value: 0, interp: 2 },
      { frame: 18, value: -4, interp: 2 },
      { frame: 24, value: 0, interp: 2 },
    ],
  });

  return {
    name: 'Walk',
    fps,
    durationFrames: totalFrames,
    loopType: 1,
    tracks,
  };
}

function buildWave(boneNames: string[]): RiveAnimationDef {
  const fps = 24;
  const totalFrames = 36;
  const hasBone = (n: string) => boneNames.includes(n);
  const tracks: BoneTrack[] = [];

  // Raise right arm
  if (hasBone('r_upper_arm')) {
    tracks.push({
      boneName: 'r_upper_arm',
      property: 'rotation',
      keyframes: [
        { frame: 0, value: deg(0), interp: 2 },
        { frame: 6, value: deg(-90), interp: 2 },
        { frame: 36, value: deg(-90), interp: 2 },
      ],
    });
  }

  // Forearm waving
  if (hasBone('r_lower_arm')) {
    tracks.push({
      boneName: 'r_lower_arm',
      property: 'rotation',
      keyframes: [
        { frame: 6, value: deg(0), interp: 2 },
        { frame: 12, value: deg(40), interp: 2 },
        { frame: 18, value: deg(-20), interp: 2 },
        { frame: 24, value: deg(40), interp: 2 },
        { frame: 30, value: deg(-20), interp: 2 },
        { frame: 36, value: deg(0), interp: 2 },
      ],
    });
  }

  // Slight lean
  if (hasBone('spine')) {
    tracks.push({
      boneName: 'spine',
      property: 'rotation',
      keyframes: [
        { frame: 0, value: deg(0), interp: 2 },
        { frame: 6, value: deg(5), interp: 2 },
        { frame: 36, value: deg(5), interp: 2 },
      ],
    });
  }

  return {
    name: 'Wave',
    fps,
    durationFrames: totalFrames,
    loopType: 0,
    tracks,
  };
}

function buildJump(boneNames: string[]): RiveAnimationDef {
  const fps = 24;
  const totalFrames = 36;
  const hasBone = (n: string) => boneNames.includes(n);
  const tracks: BoneTrack[] = [];

  const root = hasBone('spine') ? 'spine' : (boneNames[0] ?? 'root');

  // Anticipation dip → rise → fall
  tracks.push({
    boneName: root,
    property: 'y',
    keyframes: [
      { frame: 0, value: 0, interp: 2 },
      { frame: 6, value: 12, interp: 2 }, // crouch
      { frame: 12, value: -60, interp: 2 }, // peak
      { frame: 24, value: -60, interp: 2 }, // float
      { frame: 30, value: 10, interp: 2 }, // land + impact
      { frame: 36, value: 0, interp: 2 }, // recover
    ],
  });

  // Leg tuck in air
  if (hasBone('l_upper_leg')) {
    tracks.push({
      boneName: 'l_upper_leg',
      property: 'rotation',
      keyframes: [
        { frame: 0, value: deg(0), interp: 2 },
        { frame: 12, value: deg(-40), interp: 2 },
        { frame: 24, value: deg(-40), interp: 2 },
        { frame: 30, value: deg(10), interp: 2 },
        { frame: 36, value: deg(0), interp: 2 },
      ],
    });
  }

  return {
    name: 'Jump',
    fps,
    durationFrames: totalFrames,
    loopType: 0,
    tracks,
  };
}

function buildRun(boneNames: string[]): RiveAnimationDef {
  const fps = 24;
  const totalFrames = 16;
  const hasBone = (n: string) => boneNames.includes(n);
  const tracks: BoneTrack[] = [];

  const swingAng = deg(45);

  if (hasBone('l_upper_leg') && hasBone('r_upper_leg')) {
    tracks.push({
      boneName: 'l_upper_leg',
      property: 'rotation',
      keyframes: [
        { frame: 0, value: -swingAng, interp: 2 },
        { frame: 8, value: swingAng, interp: 2 },
        { frame: 16, value: -swingAng, interp: 2 },
      ],
    });
    tracks.push({
      boneName: 'r_upper_leg',
      property: 'rotation',
      keyframes: [
        { frame: 0, value: swingAng, interp: 2 },
        { frame: 8, value: -swingAng, interp: 2 },
        { frame: 16, value: swingAng, interp: 2 },
      ],
    });
  }

  if (hasBone('spine')) {
    tracks.push(constantTrack('spine', 'rotation', deg(-10))); // forward lean
  }

  const root = hasBone('spine') ? 'spine' : (boneNames[0] ?? 'root');
  tracks.push({
    boneName: root,
    property: 'y',
    keyframes: [
      { frame: 0, value: 0, interp: 2 },
      { frame: 4, value: -8, interp: 2 },
      { frame: 8, value: 0, interp: 2 },
      { frame: 12, value: -8, interp: 2 },
      { frame: 16, value: 0, interp: 2 },
    ],
  });

  return { name: 'Run', fps, durationFrames: totalFrames, loopType: 1, tracks };
}

function buildDeath(boneNames: string[]): RiveAnimationDef {
  const fps = 24;
  const totalFrames = 36;
  const hasBone = (n: string) => boneNames.includes(n);
  const tracks: BoneTrack[] = [];

  const root = hasBone('spine') ? 'spine' : (boneNames[0] ?? 'root');

  tracks.push({
    boneName: root,
    property: 'rotation',
    keyframes: [
      { frame: 0, value: deg(0), interp: 2 },
      { frame: 6, value: deg(10), interp: 2 }, // stagger
      { frame: 20, value: deg(80), interp: 2 }, // falling
      { frame: 36, value: deg(90), interp: 1 }, // on ground
    ],
  });

  tracks.push({
    boneName: root,
    property: 'y',
    keyframes: [
      { frame: 0, value: 0, interp: 2 },
      { frame: 20, value: 80, interp: 2 },
      { frame: 36, value: 100, interp: 1 },
    ],
  });

  // Limb collapse
  for (const limb of [
    'l_upper_arm',
    'r_upper_arm',
    'l_upper_leg',
    'r_upper_leg',
  ]) {
    if (hasBone(limb)) {
      tracks.push({
        boneName: limb,
        property: 'rotation',
        keyframes: [
          { frame: 0, value: deg(0), interp: 2 },
          { frame: 36, value: deg(30), interp: 2 },
        ],
      });
    }
  }

  return {
    name: 'Death',
    fps,
    durationFrames: totalFrames,
    loopType: 0,
    tracks,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export function generateAnimations(
  boneNames: string[],
  presets: AnimationPreset[] = ['idle', 'walk', 'wave', 'jump', 'run', 'death'],
): RiveAnimationDef[] {
  const builders: Record<AnimationPreset, (b: string[]) => RiveAnimationDef> = {
    idle: buildIdle,
    walk: buildWalk,
    wave: buildWave,
    jump: buildJump,
    run: buildRun,
    death: buildDeath,
  };

  return presets.map((p) => builders[p](boneNames));
}

export function getPropertyRiveKey(prop: BoneTrack['property']): number {
  // These map to rive-cpp core property IDs
  // Used when writing LinearAnimKeyFrame propertyKey
  const map: Record<BoneTrack['property'], number> = {
    rotation: 15,
    x: 13,
    y: 14,
    scaleX: 16,
    scaleY: 17,
  };
  return map[prop];
}

// ─────────────────────────────────────────────────────────────────────────────
// Animation Compatibility Checks
// ─────────────────────────────────────────────────────────────────────────────

export interface AnimationCompatibilityResult {
  compatible: boolean;
  warnings: string[];
  supportedPresets: AnimationPreset[];
}

/**
 * Check if a skeleton supports the requested animation presets.
 * Returns warnings for incompatible presets.
 */
export function checkAnimationCompatibility(
  boneNames: string[],
  requestedPresets: AnimationPreset[],
): AnimationCompatibilityResult {
  const warnings: string[] = [];
  const supportedPresets: AnimationPreset[] = [];

  // Helper to check if bone exists (with aliases for cross-skeleton compatibility)
  const hasBone = (name: string): boolean => boneNames.includes(name);
  const hasAny = (names: string[]): boolean => names.some(hasBone);

  // Check limb availability
  const hasLimbs = hasAny(BONE_GROUPS.LIMBS);
  const hasArms = hasAny([
    BONE_NAMES.LEFT_UPPER_ARM,
    BONE_NAMES.RIGHT_UPPER_ARM,
    BONE_NAMES.LEFT_FRONT_UPPER,
    BONE_NAMES.RIGHT_FRONT_UPPER,
  ]);

  for (const preset of requestedPresets) {
    switch (preset) {
      case 'idle':
        // Idle only needs spine or any bones
        if (
          hasBone(BONE_NAMES.SPINE) ||
          hasBone(BONE_NAMES.ROOT) ||
          boneNames.length > 0
        ) {
          supportedPresets.push(preset);
        } else {
          warnings.push(`${preset} animation requires at least one bone`);
        }
        break;

      case 'wave':
        // Wave needs arms
        if (hasArms) {
          supportedPresets.push(preset);
        } else {
          warnings.push(
            `${preset} animation requires arm bones (l_upper_arm/r_upper_arm or l_front_upper/r_front_upper)`,
          );
        }
        break;

      case 'walk':
      case 'run':
      case 'jump':
      case 'death':
        // These need limbs (legs for walk/run/jump, full body for death)
        if (hasLimbs) {
          supportedPresets.push(preset);
        } else {
          warnings.push(
            `${preset} animation requires limb bones (arms or legs)`,
          );
        }
        break;

      default:
        warnings.push(`Unknown animation preset: ${preset}`);
    }
  }

  return {
    compatible: supportedPresets.length === requestedPresets.length,
    warnings,
    supportedPresets,
  };
}

/**
 * Get a human-readable description of which bones an animation preset needs.
 */
export function getPresetRequiredBones(preset: AnimationPreset): string {
  switch (preset) {
    case 'idle':
      return 'spine or root (optional)';
    case 'wave':
      return 'l_upper_arm/r_upper_arm (or l_front_upper/r_front_upper for quadrupeds)';
    case 'walk':
    case 'run':
      return 'l_upper_leg/r_upper_leg (or l_hind_upper/r_hind_upper for quadrupeds)';
    case 'jump':
      return 'l_upper_leg/r_upper_leg (or l_hind_upper/r_hind_upper for quadrupeds)';
    case 'death':
      return 'spine, l_upper_arm/r_upper_arm, l_upper_leg/r_upper_leg (or quadruped equivalents)';
    default:
      return 'unknown';
  }
}
