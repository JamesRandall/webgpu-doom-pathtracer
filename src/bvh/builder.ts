import { Triangle } from '../scene/geometry';
import {
  AABB,
  BVHNode,
  FlatBVHNode,
  createEmptyAABB,
  mergeAABB,
  aabbCentroid,
} from './types';

const MAX_TRIANGLES_PER_LEAF = 4;

interface TriangleInfo {
  index: number;
  bounds: AABB;
  centroid: { x: number; y: number; z: number };
}

function computeTriangleBounds(tri: Triangle): AABB {
  const aabb = createEmptyAABB();
  aabb.minX = Math.min(tri.v0.x, tri.v1.x, tri.v2.x);
  aabb.minY = Math.min(tri.v0.y, tri.v1.y, tri.v2.y);
  aabb.minZ = Math.min(tri.v0.z, tri.v1.z, tri.v2.z);
  aabb.maxX = Math.max(tri.v0.x, tri.v1.x, tri.v2.x);
  aabb.maxY = Math.max(tri.v0.y, tri.v1.y, tri.v2.y);
  aabb.maxZ = Math.max(tri.v0.z, tri.v1.z, tri.v2.z);
  return aabb;
}

export class BVHBuilder {
  private nodes: BVHNode[] = [];
  private triangleInfos: TriangleInfo[] = [];
  private orderedTriangles: Triangle[] = [];

  build(triangles: Triangle[]): { nodes: BVHNode[]; orderedTriangles: Triangle[] } {
    if (triangles.length === 0) {
      return { nodes: [], orderedTriangles: [] };
    }

    this.nodes = [];
    this.orderedTriangles = [];

    // Compute bounds and centroids for all triangles
    this.triangleInfos = triangles.map((tri, index) => {
      const bounds = computeTriangleBounds(tri);
      return {
        index,
        bounds,
        centroid: aabbCentroid(bounds),
      };
    });

    // Build the tree recursively
    this.buildRecursive(triangles, 0, triangles.length);

    return {
      nodes: this.nodes,
      orderedTriangles: this.orderedTriangles,
    };
  }

  private buildRecursive(
    originalTriangles: Triangle[],
    start: number,
    end: number
  ): number {
    const nodeIndex = this.nodes.length;
    const node: BVHNode = {
      bounds: createEmptyAABB(),
      leftChild: -1,
      rightChild: -1,
      firstTriangle: 0,
      triangleCount: 0,
    };
    this.nodes.push(node);

    // Compute bounds of all triangles in this node
    for (let i = start; i < end; i++) {
      node.bounds = mergeAABB(node.bounds, this.triangleInfos[i].bounds);
    }

    const triangleCount = end - start;

    // Create leaf if few enough triangles
    if (triangleCount <= MAX_TRIANGLES_PER_LEAF) {
      node.firstTriangle = this.orderedTriangles.length;
      node.triangleCount = triangleCount;

      // Add triangles to ordered list
      for (let i = start; i < end; i++) {
        this.orderedTriangles.push(originalTriangles[this.triangleInfos[i].index]);
      }

      return nodeIndex;
    }

    // Find the best axis to split on (longest extent)
    const extent = {
      x: node.bounds.maxX - node.bounds.minX,
      y: node.bounds.maxY - node.bounds.minY,
      z: node.bounds.maxZ - node.bounds.minZ,
    };

    let axis: 'x' | 'y' | 'z' = 'x';
    if (extent.y > extent.x && extent.y > extent.z) {
      axis = 'y';
    } else if (extent.z > extent.x) {
      axis = 'z';
    }

    // Sort triangles along the chosen axis by centroid
    const infosSlice = this.triangleInfos.slice(start, end);
    infosSlice.sort((a, b) => a.centroid[axis] - b.centroid[axis]);
    for (let i = 0; i < infosSlice.length; i++) {
      this.triangleInfos[start + i] = infosSlice[i];
    }

    // Split at median
    const mid = start + Math.floor(triangleCount / 2);

    // Recursively build children
    node.leftChild = this.buildRecursive(originalTriangles, start, mid);
    node.rightChild = this.buildRecursive(originalTriangles, mid, end);

    return nodeIndex;
  }
}

// Leaf flag - high bit set indicates leaf node
const LEAF_FLAG = 0x80000000;

// Flatten BVH for GPU consumption
// Encoding: rightChildOrTriangleCount has high bit set for leaf nodes
export function flattenBVH(nodes: BVHNode[]): FlatBVHNode[] {
  return nodes.map((node) => {
    if (node.triangleCount > 0) {
      // Leaf node: store firstTriangle, and triangleCount with LEAF_FLAG
      return {
        minX: node.bounds.minX,
        minY: node.bounds.minY,
        minZ: node.bounds.minZ,
        leftChildOrFirstTriangle: node.firstTriangle,
        maxX: node.bounds.maxX,
        maxY: node.bounds.maxY,
        maxZ: node.bounds.maxZ,
        rightChildOrTriangleCount: node.triangleCount | LEAF_FLAG,
      };
    } else {
      // Internal node: store leftChild and rightChild (no flag)
      return {
        minX: node.bounds.minX,
        minY: node.bounds.minY,
        minZ: node.bounds.minZ,
        leftChildOrFirstTriangle: node.leftChild,
        maxX: node.bounds.maxX,
        maxY: node.bounds.maxY,
        maxZ: node.bounds.maxZ,
        rightChildOrTriangleCount: node.rightChild,
      };
    }
  });
}

// Pack flat BVH nodes into an ArrayBuffer for GPU upload
export function packBVHNodes(flatNodes: FlatBVHNode[]): ArrayBuffer {
  // Layout per node: min(3f) + leftOrFirst(1u) + max(3f) + rightOrCount(1u) = 8 values
  const buffer = new ArrayBuffer(flatNodes.length * 8 * 4);
  const floatView = new Float32Array(buffer);
  const uintView = new Uint32Array(buffer);

  for (let i = 0; i < flatNodes.length; i++) {
    const node = flatNodes[i];
    const offset = i * 8;

    floatView[offset + 0] = node.minX;
    floatView[offset + 1] = node.minY;
    floatView[offset + 2] = node.minZ;
    uintView[offset + 3] = node.leftChildOrFirstTriangle;
    floatView[offset + 4] = node.maxX;
    floatView[offset + 5] = node.maxY;
    floatView[offset + 6] = node.maxZ;
    uintView[offset + 7] = node.rightChildOrTriangleCount;
  }

  return buffer;
}
