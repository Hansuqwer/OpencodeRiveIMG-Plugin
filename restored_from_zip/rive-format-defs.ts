/**
 * rive-format-defs.ts
 *
 * Pure-data module containing all Rive binary format constants derived from
 * the official core definition files at:
 *   https://github.com/rive-app/rive-runtime/tree/main/dev/defs
 *
 * No logic, no pipeline imports, no side-effects. Every numeric value comes
 * directly from the canonical JSON definition files and the published format
 * specification at https://rive.app/docs/runtimes/advanced-topic/format
 *
 * This file is the single source of truth for:
 *  - File header magic bytes and version constants
 *  - Table-of-Contents (ToC) backing-type codes
 *  - Object type keys with inheritance chains
 *  - Property keys with owning type, backing type, and field name
 */

// ---------------------------------------------------------------------------
// File header constants
// ---------------------------------------------------------------------------

/** Magic bytes at offset 0 of every `.riv` file: ASCII "RIVE". */
export const RIVE_MAGIC = new Uint8Array([0x52, 0x49, 0x56, 0x45]);

/** Current `.riv` format major version (varuint after magic). */
export const RIVE_MAJOR_VERSION = 7;

/**
 * Minor version to write. Zero is safe — official runtimes accept any
 * minor version ≤ their own.
 */
export const RIVE_MINOR_VERSION = 0;

// ---------------------------------------------------------------------------
// ToC backing-type codes (2-bit values in the Table of Contents)
// ---------------------------------------------------------------------------

/**
 * Backing types encode how a property value is serialized in the binary
 * stream. Each property key maps to exactly one backing type.
 */
export const TocBackingType = {
  /** uint (varuint) or bool (varuint 0/1). */
  Uint: 0,
  /** Length-prefixed UTF-8 string. */
  String: 1,
  /** IEEE 754 32-bit little-endian float. */
  Float: 2,
  /** 32-bit ARGB color (written as uint32). */
  Color: 3,
} as const;

export type TocBackingTypeValue =
  (typeof TocBackingType)[keyof typeof TocBackingType];

// ---------------------------------------------------------------------------
// Object type keys
// ---------------------------------------------------------------------------

/**
 * Every Rive object type has a unique integer key used as the object header
 * in the binary stream. Keys are sourced from `"key"` in each core def JSON.
 *
 * Only types relevant to the image-to-rive pipeline are included. The full
 * Rive runtime defines additional types (e.g. state machines, constraints,
 * blend states) that are outside our current scope.
 */
export const RiveTypeKey = {
  // --- structural ---
  Artboard: 1,
  Node: 2,
  Shape: 3,
  Component: 10,
  ContainerComponent: 11,
  Drawable: 13,
  Backboard: 23,
  TransformComponent: 38,
  WorldTransformComponent: 91,
  LayoutComponent: 409,

  // --- skeleton ---
  SkeletalComponent: 39,
  Bone: 40,
  RootBone: 41,
  Skin: 43,
  Tendon: 44,

  // --- mesh / vertex ---
  Vertex: 107,
  MeshVertex: 108,
  Mesh: 109,

  // --- asset ---
  Asset: 99,
  Image: 100,
  FileAsset: 103,
  DrawableAsset: 104,
  ImageAsset: 105,

  // --- animation ---
  Animation: 27,
  KeyedObject: 25,
  KeyedProperty: 26,
  KeyFrame: 29,
  KeyFrameDouble: 30,
  LinearAnimation: 31,
  KeyFrameId: 50,
  CubicInterpolator: 139,
  KeyFrameInterpolator: 175,
  InterpolatingKeyFrame: 170,
} as const;

export type RiveTypeKeyValue = (typeof RiveTypeKey)[keyof typeof RiveTypeKey];

// ---------------------------------------------------------------------------
// Inheritance chains
// ---------------------------------------------------------------------------

/**
 * Maps each concrete/abstract type to its parent in the Rive type hierarchy.
 * `null` means no parent (root type in the hierarchy).
 *
 * Inheritance determines which property keys are valid on a given object.
 */
export const RiveTypeParent: Record<
  keyof typeof RiveTypeKey,
  keyof typeof RiveTypeKey | null
> = {
  // structural
  Artboard: 'LayoutComponent',
  Node: 'TransformComponent',
  Shape: 'Drawable',
  Component: null,
  ContainerComponent: 'Component',
  Drawable: 'Node',
  Backboard: null,
  TransformComponent: 'WorldTransformComponent',
  WorldTransformComponent: 'ContainerComponent',
  LayoutComponent: 'Drawable',

  // skeleton
  SkeletalComponent: 'TransformComponent',
  Bone: 'SkeletalComponent',
  RootBone: 'Bone',
  Skin: 'ContainerComponent',
  Tendon: 'Component',

  // mesh / vertex
  Vertex: 'ContainerComponent',
  MeshVertex: 'Vertex',
  Mesh: 'ContainerComponent',

  // asset
  Asset: null,
  Image: 'Drawable',
  FileAsset: 'Asset',
  DrawableAsset: 'FileAsset',
  ImageAsset: 'DrawableAsset',

  // animation
  Animation: null,
  KeyedObject: null,
  KeyedProperty: null,
  KeyFrame: null,
  KeyFrameDouble: 'InterpolatingKeyFrame',
  LinearAnimation: 'Animation',
  KeyFrameId: 'InterpolatingKeyFrame',
  CubicInterpolator: 'KeyFrameInterpolator',
  KeyFrameInterpolator: null,
  InterpolatingKeyFrame: 'KeyFrame',
};

// ---------------------------------------------------------------------------
// Property keys
// ---------------------------------------------------------------------------

/**
 * Property key definitions. Each property has:
 *  - `key`: the integer property key from core defs
 *  - `backingType`: how it is serialized (ToC 2-bit code)
 *  - `owner`: the type name that declares this property
 *  - `field`: human-readable field name (matches core def `"name"`)
 *
 * When the same field name appears on multiple owners (e.g. `x` on Node vs
 * Vertex vs RootBone), each gets a distinct entry with a disambiguated name.
 */
export interface RivePropertyDef {
  readonly key: number;
  readonly backingType: TocBackingTypeValue;
  readonly owner: keyof typeof RiveTypeKey;
  readonly field: string;
}

/**
 * All property keys needed by the image-to-rive pipeline, grouped by
 * functional area.
 *
 * Naming convention: `owner_field` when disambiguation is needed.
 */
export const RivePropertyKey = {
  // --- Component (base) ---
  name: {
    key: 4,
    backingType: TocBackingType.String,
    owner: 'Component',
    field: 'name',
  },
  parentId: {
    key: 5,
    backingType: TocBackingType.Uint,
    owner: 'Component',
    field: 'parentId',
  },

  // --- LayoutComponent (inherited by Artboard) ---
  width: {
    key: 7,
    backingType: TocBackingType.Float,
    owner: 'LayoutComponent',
    field: 'width',
  },
  height: {
    key: 8,
    backingType: TocBackingType.Float,
    owner: 'LayoutComponent',
    field: 'height',
  },

  // --- Artboard-specific ---
  artboard_originX: {
    key: 11,
    backingType: TocBackingType.Float,
    owner: 'Artboard',
    field: 'originX',
  },
  artboard_originY: {
    key: 12,
    backingType: TocBackingType.Float,
    owner: 'Artboard',
    field: 'originY',
  },

  // --- Node position ---
  node_x: {
    key: 13,
    backingType: TocBackingType.Float,
    owner: 'Node',
    field: 'x',
  },
  node_y: {
    key: 14,
    backingType: TocBackingType.Float,
    owner: 'Node',
    field: 'y',
  },

  // --- TransformComponent ---
  rotation: {
    key: 15,
    backingType: TocBackingType.Float,
    owner: 'TransformComponent',
    field: 'rotation',
  },
  scaleX: {
    key: 16,
    backingType: TocBackingType.Float,
    owner: 'TransformComponent',
    field: 'scaleX',
  },
  scaleY: {
    key: 17,
    backingType: TocBackingType.Float,
    owner: 'TransformComponent',
    field: 'scaleY',
  },

  // --- WorldTransformComponent ---
  opacity: {
    key: 18,
    backingType: TocBackingType.Float,
    owner: 'WorldTransformComponent',
    field: 'opacity',
  },

  // --- Drawable ---
  blendModeValue: {
    key: 23,
    backingType: TocBackingType.Uint,
    owner: 'Drawable',
    field: 'blendModeValue',
  },

  // --- Vertex position ---
  vertex_x: {
    key: 24,
    backingType: TocBackingType.Float,
    owner: 'Vertex',
    field: 'x',
  },
  vertex_y: {
    key: 25,
    backingType: TocBackingType.Float,
    owner: 'Vertex',
    field: 'y',
  },

  // --- KeyedObject ---
  objectId: {
    key: 51,
    backingType: TocBackingType.Uint,
    owner: 'KeyedObject',
    field: 'objectId',
  },

  // --- KeyedProperty ---
  propertyKey: {
    key: 53,
    backingType: TocBackingType.Uint,
    owner: 'KeyedProperty',
    field: 'propertyKey',
  },

  // --- Animation ---
  animation_name: {
    key: 55,
    backingType: TocBackingType.String,
    owner: 'Animation',
    field: 'name',
  },

  // --- LinearAnimation ---
  fps: {
    key: 56,
    backingType: TocBackingType.Uint,
    owner: 'LinearAnimation',
    field: 'fps',
  },
  duration: {
    key: 57,
    backingType: TocBackingType.Uint,
    owner: 'LinearAnimation',
    field: 'duration',
  },
  speed: {
    key: 58,
    backingType: TocBackingType.Float,
    owner: 'LinearAnimation',
    field: 'speed',
  },
  loopValue: {
    key: 59,
    backingType: TocBackingType.Uint,
    owner: 'LinearAnimation',
    field: 'loopValue',
  },
  workStart: {
    key: 60,
    backingType: TocBackingType.Uint,
    owner: 'LinearAnimation',
    field: 'workStart',
  },
  workEnd: {
    key: 61,
    backingType: TocBackingType.Uint,
    owner: 'LinearAnimation',
    field: 'workEnd',
  },
  enableWorkArea: {
    key: 62,
    backingType: TocBackingType.Uint,
    owner: 'LinearAnimation',
    field: 'enableWorkArea',
  },

  // --- CubicInterpolator ---
  cubicX1: {
    key: 63,
    backingType: TocBackingType.Float,
    owner: 'CubicInterpolator',
    field: 'x1',
  },
  cubicY1: {
    key: 64,
    backingType: TocBackingType.Float,
    owner: 'CubicInterpolator',
    field: 'y1',
  },
  cubicX2: {
    key: 65,
    backingType: TocBackingType.Float,
    owner: 'CubicInterpolator',
    field: 'x2',
  },
  cubicY2: {
    key: 66,
    backingType: TocBackingType.Float,
    owner: 'CubicInterpolator',
    field: 'y2',
  },

  // --- KeyFrame ---
  frame: {
    key: 67,
    backingType: TocBackingType.Uint,
    owner: 'KeyFrame',
    field: 'frame',
  },

  // --- InterpolatingKeyFrame ---
  interpolationType: {
    key: 68,
    backingType: TocBackingType.Uint,
    owner: 'InterpolatingKeyFrame',
    field: 'interpolationType',
  },
  interpolatorId: {
    key: 69,
    backingType: TocBackingType.Uint,
    owner: 'InterpolatingKeyFrame',
    field: 'interpolatorId',
  },

  // --- KeyFrameDouble ---
  keyFrameDouble_value: {
    key: 70,
    backingType: TocBackingType.Float,
    owner: 'KeyFrameDouble',
    field: 'value',
  },

  // --- Bone ---
  bone_length: {
    key: 89,
    backingType: TocBackingType.Float,
    owner: 'Bone',
    field: 'length',
  },

  // --- RootBone ---
  rootBone_x: {
    key: 90,
    backingType: TocBackingType.Float,
    owner: 'RootBone',
    field: 'x',
  },
  rootBone_y: {
    key: 91,
    backingType: TocBackingType.Float,
    owner: 'RootBone',
    field: 'y',
  },

  // --- Tendon ---
  tendon_boneId: {
    key: 95,
    backingType: TocBackingType.Uint,
    owner: 'Tendon',
    field: 'boneId',
  },
  tendon_xx: {
    key: 96,
    backingType: TocBackingType.Float,
    owner: 'Tendon',
    field: 'xx',
  },
  tendon_yx: {
    key: 97,
    backingType: TocBackingType.Float,
    owner: 'Tendon',
    field: 'yx',
  },
  tendon_xy: {
    key: 98,
    backingType: TocBackingType.Float,
    owner: 'Tendon',
    field: 'xy',
  },
  tendon_yy: {
    key: 99,
    backingType: TocBackingType.Float,
    owner: 'Tendon',
    field: 'yy',
  },
  tendon_tx: {
    key: 100,
    backingType: TocBackingType.Float,
    owner: 'Tendon',
    field: 'tx',
  },
  tendon_ty: {
    key: 101,
    backingType: TocBackingType.Float,
    owner: 'Tendon',
    field: 'ty',
  },

  // --- Skin ---
  skin_xx: {
    key: 104,
    backingType: TocBackingType.Float,
    owner: 'Skin',
    field: 'xx',
  },
  skin_yx: {
    key: 105,
    backingType: TocBackingType.Float,
    owner: 'Skin',
    field: 'yx',
  },
  skin_xy: {
    key: 106,
    backingType: TocBackingType.Float,
    owner: 'Skin',
    field: 'xy',
  },
  skin_yy: {
    key: 107,
    backingType: TocBackingType.Float,
    owner: 'Skin',
    field: 'yy',
  },
  skin_tx: {
    key: 108,
    backingType: TocBackingType.Float,
    owner: 'Skin',
    field: 'tx',
  },
  skin_ty: {
    key: 109,
    backingType: TocBackingType.Float,
    owner: 'Skin',
    field: 'ty',
  },

  // --- KeyFrameId ---
  keyFrameId_value: {
    key: 122,
    backingType: TocBackingType.Uint,
    owner: 'KeyFrameId',
    field: 'value',
  },

  // --- LayoutComponent ---
  layout_clip: {
    key: 196,
    backingType: TocBackingType.Uint,
    owner: 'LayoutComponent',
    field: 'clip',
  },

  // --- Asset ---
  asset_name: {
    key: 203,
    backingType: TocBackingType.String,
    owner: 'Asset',
    field: 'name',
  },

  // --- FileAsset ---
  fileAsset_assetId: {
    key: 204,
    backingType: TocBackingType.Uint,
    owner: 'FileAsset',
    field: 'assetId',
  },

  // --- Image ---
  image_assetId: {
    key: 206,
    backingType: TocBackingType.Uint,
    owner: 'Image',
    field: 'assetId',
  },

  // --- DrawableAsset ---
  drawableAsset_height: {
    key: 207,
    backingType: TocBackingType.Float,
    owner: 'DrawableAsset',
    field: 'height',
  },
  drawableAsset_width: {
    key: 208,
    backingType: TocBackingType.Float,
    owner: 'DrawableAsset',
    field: 'width',
  },

  // --- MeshVertex ---
  meshVertex_u: {
    key: 215,
    backingType: TocBackingType.Float,
    owner: 'MeshVertex',
    field: 'u',
  },
  meshVertex_v: {
    key: 216,
    backingType: TocBackingType.Float,
    owner: 'MeshVertex',
    field: 'v',
  },

  // --- Mesh ---
  triangleIndexBytes: {
    key: 223,
    backingType: TocBackingType.String,
    owner: 'Mesh',
    field: 'triangleIndexBytes',
  },

  // --- FileAsset CDN ---
  cdnUuid: {
    key: 359,
    backingType: TocBackingType.String,
    owner: 'FileAsset',
    field: 'cdnUuid',
  },
  cdnBaseUrl: {
    key: 362,
    backingType: TocBackingType.String,
    owner: 'FileAsset',
    field: 'cdnBaseUrl',
  },

  // --- Image origin ---
  image_originX: {
    key: 380,
    backingType: TocBackingType.Float,
    owner: 'Image',
    field: 'originX',
  },
  image_originY: {
    key: 381,
    backingType: TocBackingType.Float,
    owner: 'Image',
    field: 'originY',
  },
} as const satisfies Record<string, RivePropertyDef>;

export type RivePropertyKeyName = keyof typeof RivePropertyKey;

// ---------------------------------------------------------------------------
// Interpolation type constants (used in InterpolatingKeyFrame.interpolationType)
// ---------------------------------------------------------------------------

export const RiveInterpolationType = {
  Hold: 0,
  Linear: 1,
  Cubic: 2,
} as const;

// ---------------------------------------------------------------------------
// Loop type constants (used in LinearAnimation.loopValue)
// ---------------------------------------------------------------------------

export const RiveLoopType = {
  OneShot: 0,
  Loop: 1,
  PingPong: 2,
} as const;

// ---------------------------------------------------------------------------
// Blend mode constants (used in Drawable.blendModeValue)
// ---------------------------------------------------------------------------

export const RiveBlendMode = {
  SrcOver: 3,
  Screen: 14,
  Overlay: 15,
  Darken: 16,
  Lighten: 17,
  ColorDodge: 18,
  ColorBurn: 19,
  HardLight: 20,
  SoftLight: 21,
  Difference: 22,
  Exclusion: 23,
  Multiply: 24,
  Hue: 25,
  Saturation: 26,
  Color: 27,
  Luminosity: 28,
} as const;

// ---------------------------------------------------------------------------
// Helpers for property key lookup
// ---------------------------------------------------------------------------

/** All property definitions as an array for iteration. */
export const ALL_PROPERTY_DEFS: readonly RivePropertyDef[] =
  Object.values(RivePropertyKey);

/** Map from numeric property key → definition, for fast lookup during ToC generation. */
export const PROPERTY_BY_KEY: ReadonlyMap<number, RivePropertyDef> = new Map(
  ALL_PROPERTY_DEFS.map((def) => [def.key, def]),
);

/** Collect all property keys that belong to a given owner type (including inherited). */
export function getPropertiesForType(
  typeName: keyof typeof RiveTypeKey,
): readonly RivePropertyDef[] {
  const result: RivePropertyDef[] = [];
  let current: keyof typeof RiveTypeKey | null = typeName;
  while (current !== null) {
    for (const def of ALL_PROPERTY_DEFS) {
      if (def.owner === current) {
        result.push(def);
      }
    }
    current = RiveTypeParent[current];
  }
  return result;
}
