import { Triangle } from '../scene/geometry';
import {
  AABB,
  BVHNode,
  FlatBVHNode,
  createEmptyAABB,
  mergeAABB,
  aabbCentroid,
  aabbSurfaceArea,
} from './types';

const MAX_TRIANGLES_PER_LEAF = 4;
const SAH_TRAVERSAL_COST = 1.0;    // Cost of traversing a node
const SAH_INTERSECTION_COST = 2.0; // Cost of intersecting a triangle
const SAH_NUM_BUCKETS = 12;        // Number of buckets for SAH evaluation

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

    // Compute centroid bounds for SAH
    let centroidBounds = createEmptyAABB();
    for (let i = start; i < end; i++) {
      const c = this.triangleInfos[i].centroid;
      centroidBounds.minX = Math.min(centroidBounds.minX, c.x);
      centroidBounds.minY = Math.min(centroidBounds.minY, c.y);
      centroidBounds.minZ = Math.min(centroidBounds.minZ, c.z);
      centroidBounds.maxX = Math.max(centroidBounds.maxX, c.x);
      centroidBounds.maxY = Math.max(centroidBounds.maxY, c.y);
      centroidBounds.maxZ = Math.max(centroidBounds.maxZ, c.z);
    }

    // Find the best split using SAH
    const splitResult = this.findBestSplit(start, end, node.bounds, centroidBounds);

    // If SAH says making a leaf is cheaper, or we can't split, make a leaf
    if (splitResult.axis === -1 || splitResult.cost >= triangleCount * SAH_INTERSECTION_COST) {
      node.firstTriangle = this.orderedTriangles.length;
      node.triangleCount = triangleCount;
      for (let i = start; i < end; i++) {
        this.orderedTriangles.push(originalTriangles[this.triangleInfos[i].index]);
      }
      return nodeIndex;
    }

    // Partition triangles based on the best split
    const mid = this.partition(start, end, splitResult.axis, splitResult.splitPos);

    // If partition failed (all triangles on one side), fall back to median
    if (mid === start || mid === end) {
      const axis = splitResult.axis;
      const infosSlice = this.triangleInfos.slice(start, end);
      const axisKey = ['x', 'y', 'z'][axis] as 'x' | 'y' | 'z';
      infosSlice.sort((a, b) => a.centroid[axisKey] - b.centroid[axisKey]);
      for (let i = 0; i < infosSlice.length; i++) {
        this.triangleInfos[start + i] = infosSlice[i];
      }
      const medianMid = start + Math.floor(triangleCount / 2);
      node.leftChild = this.buildRecursive(originalTriangles, start, medianMid);
      node.rightChild = this.buildRecursive(originalTriangles, medianMid, end);
    } else {
      // Recursively build children
      node.leftChild = this.buildRecursive(originalTriangles, start, mid);
      node.rightChild = this.buildRecursive(originalTriangles, mid, end);
    }

    return nodeIndex;
  }

  private findBestSplit(
    start: number,
    end: number,
    nodeBounds: AABB,
    centroidBounds: AABB
  ): { axis: number; splitPos: number; cost: number } {
    let bestAxis = -1;
    let bestSplitPos = 0;
    let bestCost = Infinity;

    const nodeSA = aabbSurfaceArea(nodeBounds);
    if (nodeSA <= 0) {
      return { axis: -1, splitPos: 0, cost: Infinity };
    }

    // Try each axis
    for (let axis = 0; axis < 3; axis++) {
      const axisKey = ['x', 'y', 'z'][axis] as 'x' | 'y' | 'z';
      const minKey = ['minX', 'minY', 'minZ'][axis] as 'minX' | 'minY' | 'minZ';
      const maxKey = ['maxX', 'maxY', 'maxZ'][axis] as 'maxX' | 'maxY' | 'maxZ';

      const axisMin = centroidBounds[minKey];
      const axisMax = centroidBounds[maxKey];

      // Skip if all centroids are at the same position on this axis
      if (axisMax - axisMin < 1e-6) {
        continue;
      }

      // Initialize buckets
      const buckets: { count: number; bounds: AABB }[] = [];
      for (let i = 0; i < SAH_NUM_BUCKETS; i++) {
        buckets.push({ count: 0, bounds: createEmptyAABB() });
      }

      // Assign triangles to buckets
      const scale = SAH_NUM_BUCKETS / (axisMax - axisMin);
      for (let i = start; i < end; i++) {
        const centroid = this.triangleInfos[i].centroid[axisKey];
        let bucketIdx = Math.floor((centroid - axisMin) * scale);
        bucketIdx = Math.min(bucketIdx, SAH_NUM_BUCKETS - 1);
        buckets[bucketIdx].count++;
        buckets[bucketIdx].bounds = mergeAABB(buckets[bucketIdx].bounds, this.triangleInfos[i].bounds);
      }

      // Evaluate SAH cost for each split position
      // Precompute cumulative data from left and right
      const leftCount: number[] = new Array(SAH_NUM_BUCKETS - 1);
      const leftBounds: AABB[] = new Array(SAH_NUM_BUCKETS - 1);
      const rightCount: number[] = new Array(SAH_NUM_BUCKETS - 1);
      const rightBounds: AABB[] = new Array(SAH_NUM_BUCKETS - 1);

      let cumBounds = createEmptyAABB();
      let cumCount = 0;
      for (let i = 0; i < SAH_NUM_BUCKETS - 1; i++) {
        cumBounds = mergeAABB(cumBounds, buckets[i].bounds);
        cumCount += buckets[i].count;
        leftBounds[i] = { ...cumBounds };
        leftCount[i] = cumCount;
      }

      cumBounds = createEmptyAABB();
      cumCount = 0;
      for (let i = SAH_NUM_BUCKETS - 1; i > 0; i--) {
        cumBounds = mergeAABB(cumBounds, buckets[i].bounds);
        cumCount += buckets[i].count;
        rightBounds[i - 1] = { ...cumBounds };
        rightCount[i - 1] = cumCount;
      }

      // Find best split for this axis
      for (let i = 0; i < SAH_NUM_BUCKETS - 1; i++) {
        if (leftCount[i] === 0 || rightCount[i] === 0) continue;

        const leftSA = aabbSurfaceArea(leftBounds[i]);
        const rightSA = aabbSurfaceArea(rightBounds[i]);

        const cost = SAH_TRAVERSAL_COST +
          (leftSA / nodeSA) * leftCount[i] * SAH_INTERSECTION_COST +
          (rightSA / nodeSA) * rightCount[i] * SAH_INTERSECTION_COST;

        if (cost < bestCost) {
          bestCost = cost;
          bestAxis = axis;
          bestSplitPos = axisMin + (i + 1) * (axisMax - axisMin) / SAH_NUM_BUCKETS;
        }
      }
    }

    return { axis: bestAxis, splitPos: bestSplitPos, cost: bestCost };
  }

  private partition(start: number, end: number, axis: number, splitPos: number): number {
    const axisKey = ['x', 'y', 'z'][axis] as 'x' | 'y' | 'z';
    let left = start;
    let right = end - 1;

    while (left <= right) {
      while (left <= right && this.triangleInfos[left].centroid[axisKey] < splitPos) {
        left++;
      }
      while (left <= right && this.triangleInfos[right].centroid[axisKey] >= splitPos) {
        right--;
      }
      if (left < right) {
        // Swap
        const temp = this.triangleInfos[left];
        this.triangleInfos[left] = this.triangleInfos[right];
        this.triangleInfos[right] = temp;
        left++;
        right--;
      }
    }

    return left;
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
