export interface AABB {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export interface BVHNode {
  bounds: AABB;
  leftChild: number;      // Index of left child, or -1 if leaf
  rightChild: number;     // Index of right child, or -1 if leaf
  firstTriangle: number;  // First triangle index (only for leaves)
  triangleCount: number;  // Number of triangles (0 = internal node)
}

// Flattened node for GPU - includes both child indices
// Layout: min(3) + leftOrFirst(1) + max(3) + rightOrCount(1) = 8 floats
export interface FlatBVHNode {
  minX: number;
  minY: number;
  minZ: number;
  leftChildOrFirstTriangle: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  rightChildOrTriangleCount: number;  // For internal: right child index; For leaf: triangle count
}

export function createEmptyAABB(): AABB {
  return {
    minX: Infinity,
    minY: Infinity,
    minZ: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
    maxZ: -Infinity,
  };
}

export function expandAABB(aabb: AABB, x: number, y: number, z: number): void {
  aabb.minX = Math.min(aabb.minX, x);
  aabb.minY = Math.min(aabb.minY, y);
  aabb.minZ = Math.min(aabb.minZ, z);
  aabb.maxX = Math.max(aabb.maxX, x);
  aabb.maxY = Math.max(aabb.maxY, y);
  aabb.maxZ = Math.max(aabb.maxZ, z);
}

export function mergeAABB(a: AABB, b: AABB): AABB {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    minZ: Math.min(a.minZ, b.minZ),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
    maxZ: Math.max(a.maxZ, b.maxZ),
  };
}

export function aabbSurfaceArea(aabb: AABB): number {
  const dx = aabb.maxX - aabb.minX;
  const dy = aabb.maxY - aabb.minY;
  const dz = aabb.maxZ - aabb.minZ;
  return 2 * (dx * dy + dy * dz + dz * dx);
}

export function aabbCentroid(aabb: AABB): { x: number; y: number; z: number } {
  return {
    x: (aabb.minX + aabb.maxX) * 0.5,
    y: (aabb.minY + aabb.maxY) * 0.5,
    z: (aabb.minZ + aabb.maxZ) * 0.5,
  };
}
