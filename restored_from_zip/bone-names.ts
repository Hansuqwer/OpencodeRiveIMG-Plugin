/**
 * bone-names.ts
 *
 * Shared bone name constants for the image-to-rive pipeline.
 * These names must be synchronized between:
 * - pose_estimate.py (Python skeleton generation)
 * - animation.ts (TypeScript animation generation)
 *
 * Bone naming convention:
 * - l_ / r_ prefix for left/right sides
 * - _upper_ / _lower_ for proximal/distal segments
 * - Descriptive suffixes (arm, leg, etc.)
 */

// Biped / Creature front-facing skeleton bone names
export const BONE_NAMES = {
  // Core body
  ROOT: 'root',
  SPINE: 'spine',
  NECK: 'neck',
  HEAD: 'head',

  // Arms (biped naming convention)
  LEFT_UPPER_ARM: 'l_upper_arm',
  RIGHT_UPPER_ARM: 'r_upper_arm',
  LEFT_LOWER_ARM: 'l_lower_arm',
  RIGHT_LOWER_ARM: 'r_lower_arm',

  // Legs (biped naming convention)
  LEFT_UPPER_LEG: 'l_upper_leg',
  RIGHT_UPPER_LEG: 'r_upper_leg',
  LEFT_LOWER_LEG: 'l_lower_leg',
  RIGHT_LOWER_LEG: 'r_lower_leg',

  // Ears (for creature bipeds)
  LEFT_EAR: 'l_ear',
  RIGHT_EAR: 'r_ear',

  // Quadruped front-facing bone names
  LEFT_FRONT_UPPER: 'l_front_upper',
  RIGHT_FRONT_UPPER: 'r_front_upper',
  LEFT_FRONT_LOWER: 'l_front_lower',
  RIGHT_FRONT_LOWER: 'r_front_lower',
  LEFT_HIND_UPPER: 'l_hind_upper',
  RIGHT_HIND_UPPER: 'r_hind_upper',
  LEFT_HIND_LOWER: 'l_hind_lower',
  RIGHT_HIND_LOWER: 'r_hind_lower',
  TAIL: 'tail',

  // Quadruped side-view bone names
  SPINE_FRONT: 'spine_front',
  SPINE_REAR: 'spine_rear',
  LEFT_FRONT_LEG: 'l_front_upper', // Alias
  RIGHT_FRONT_LEG: 'r_front_upper', // Alias
  LEFT_HIND_LEG: 'l_hind_upper', // Alias
  RIGHT_HIND_LEG: 'r_hind_upper', // Alias
} as const;

// Type for bone names
export type BoneName = (typeof BONE_NAMES)[keyof typeof BONE_NAMES];

// Grouped bone names for animation compatibility checks
export const BONE_GROUPS = {
  // Limbs required for walk/run/jump/death animations
  LIMBS: [
    BONE_NAMES.LEFT_UPPER_ARM,
    BONE_NAMES.RIGHT_UPPER_ARM,
    BONE_NAMES.LEFT_UPPER_LEG,
    BONE_NAMES.RIGHT_UPPER_LEG,
    // Quadruped equivalents
    BONE_NAMES.LEFT_FRONT_UPPER,
    BONE_NAMES.RIGHT_FRONT_UPPER,
    BONE_NAMES.LEFT_HIND_UPPER,
    BONE_NAMES.RIGHT_HIND_UPPER,
  ],

  // Arms required for wave animation
  ARMS: [
    BONE_NAMES.LEFT_UPPER_ARM,
    BONE_NAMES.RIGHT_UPPER_ARM,
    BONE_NAMES.LEFT_LOWER_ARM,
    BONE_NAMES.RIGHT_LOWER_ARM,
    // Quadruped front legs
    BONE_NAMES.LEFT_FRONT_UPPER,
    BONE_NAMES.RIGHT_FRONT_UPPER,
    BONE_NAMES.LEFT_FRONT_LOWER,
    BONE_NAMES.RIGHT_FRONT_LOWER,
  ],

  // Legs required for walk/run/jump animations
  LEGS: [
    BONE_NAMES.LEFT_UPPER_LEG,
    BONE_NAMES.RIGHT_UPPER_LEG,
    BONE_NAMES.LEFT_LOWER_LEG,
    BONE_NAMES.RIGHT_LOWER_LEG,
    // Quadruped equivalents
    BONE_NAMES.LEFT_FRONT_UPPER,
    BONE_NAMES.RIGHT_FRONT_UPPER,
    BONE_NAMES.LEFT_FRONT_LOWER,
    BONE_NAMES.RIGHT_FRONT_LOWER,
    BONE_NAMES.LEFT_HIND_UPPER,
    BONE_NAMES.RIGHT_HIND_UPPER,
    BONE_NAMES.LEFT_HIND_LOWER,
    BONE_NAMES.RIGHT_HIND_LOWER,
  ],

  // Core body bones
  CORE: [BONE_NAMES.ROOT, BONE_NAMES.SPINE, BONE_NAMES.NECK, BONE_NAMES.HEAD],
};

/**
 * Check if a skeleton has any bones from a specific group.
 * Used for animation compatibility validation.
 */
export function hasAnyBone(
  boneNames: string[],
  group: readonly string[],
): boolean {
  return boneNames.some((name) => group.includes(name));
}

/**
 * Check if a skeleton has limb bones (required for most animations).
 */
export function hasLimbs(boneNames: string[]): boolean {
  return hasAnyBone(boneNames, BONE_GROUPS.LIMBS);
}

/**
 * Check if a skeleton has arm bones (required for wave animation).
 */
export function hasArms(boneNames: string[]): boolean {
  return hasAnyBone(boneNames, BONE_GROUPS.ARMS);
}

/**
 * Check if a skeleton has leg bones (required for walk/run/jump).
 */
export function hasLegs(boneNames: string[]): boolean {
  return hasAnyBone(boneNames, BONE_GROUPS.LEGS);
}

/**
 * Get all bone name aliases for a given canonical name.
 * Useful for cross-compatibility between skeleton types.
 */
export function getBoneAliases(canonicalName: string): string[] {
  const aliases: Record<string, string[]> = {
    [BONE_NAMES.LEFT_UPPER_ARM]: [BONE_NAMES.LEFT_FRONT_UPPER],
    [BONE_NAMES.RIGHT_UPPER_ARM]: [BONE_NAMES.RIGHT_FRONT_UPPER],
    [BONE_NAMES.LEFT_LOWER_ARM]: [BONE_NAMES.LEFT_FRONT_LOWER],
    [BONE_NAMES.RIGHT_LOWER_ARM]: [BONE_NAMES.RIGHT_FRONT_LOWER],
    [BONE_NAMES.LEFT_UPPER_LEG]: [
      BONE_NAMES.LEFT_HIND_UPPER,
      BONE_NAMES.LEFT_HIND_LEG,
    ],
    [BONE_NAMES.RIGHT_UPPER_LEG]: [
      BONE_NAMES.RIGHT_HIND_UPPER,
      BONE_NAMES.RIGHT_HIND_LEG,
    ],
    [BONE_NAMES.LEFT_LOWER_LEG]: [BONE_NAMES.LEFT_HIND_LOWER],
    [BONE_NAMES.RIGHT_LOWER_LEG]: [BONE_NAMES.RIGHT_HIND_LOWER],
    [BONE_NAMES.SPINE]: [BONE_NAMES.SPINE_FRONT, BONE_NAMES.SPINE_REAR],
  };
  return aliases[canonicalName] ?? [];
}

/**
 * Check if a bone name exists, including aliases.
 */
export function hasBoneWithAliases(
  boneNames: string[],
  targetName: string,
): boolean {
  if (boneNames.includes(targetName)) return true;
  const aliases = getBoneAliases(targetName);
  return boneNames.some((name) => aliases.includes(name));
}
