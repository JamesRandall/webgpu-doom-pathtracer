export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Triangle {
  v0: Vec3;
  v1: Vec3;
  v2: Vec3;
  normal: Vec3;
  color: Vec3;
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function normalize(v: Vec3): Vec3 {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (len === 0) return { x: 0, y: 0, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function computeNormal(v0: Vec3, v1: Vec3, v2: Vec3): Vec3 {
  const edge1 = subtract(v1, v0);
  const edge2 = subtract(v2, v0);
  return normalize(cross(edge1, edge2));
}

function createTriangle(v0: Vec3, v1: Vec3, v2: Vec3, color: Vec3): Triangle {
  return {
    v0,
    v1,
    v2,
    normal: computeNormal(v0, v1, v2),
    color,
  };
}

export function createCube(center: Vec3, size: number, color?: Vec3): Triangle[] {
  const h = size / 2;
  const cx = center.x;
  const cy = center.y;
  const cz = center.z;

  const vertices: Vec3[] = [
    { x: cx - h, y: cy - h, z: cz - h }, // 0: left-bottom-back
    { x: cx + h, y: cy - h, z: cz - h }, // 1: right-bottom-back
    { x: cx + h, y: cy + h, z: cz - h }, // 2: right-top-back
    { x: cx - h, y: cy + h, z: cz - h }, // 3: left-top-back
    { x: cx - h, y: cy - h, z: cz + h }, // 4: left-bottom-front
    { x: cx + h, y: cy - h, z: cz + h }, // 5: right-bottom-front
    { x: cx + h, y: cy + h, z: cz + h }, // 6: right-top-front
    { x: cx - h, y: cy + h, z: cz + h }, // 7: left-top-front
  ];

  // Use provided color or default face colors
  const colors = color
    ? { front: color, back: color, left: color, right: color, top: color, bottom: color }
    : {
        front: { x: 1.0, y: 0.3, z: 0.3 },
        back: { x: 0.3, y: 1.0, z: 0.3 },
        left: { x: 0.3, y: 0.3, z: 1.0 },
        right: { x: 1.0, y: 1.0, z: 0.3 },
        top: { x: 1.0, y: 0.3, z: 1.0 },
        bottom: { x: 0.3, y: 1.0, z: 1.0 },
      };

  const triangles: Triangle[] = [];

  // Front face (z+)
  triangles.push(createTriangle(vertices[4], vertices[5], vertices[6], colors.front));
  triangles.push(createTriangle(vertices[4], vertices[6], vertices[7], colors.front));

  // Back face (z-)
  triangles.push(createTriangle(vertices[1], vertices[0], vertices[3], colors.back));
  triangles.push(createTriangle(vertices[1], vertices[3], vertices[2], colors.back));

  // Left face (x-)
  triangles.push(createTriangle(vertices[0], vertices[4], vertices[7], colors.left));
  triangles.push(createTriangle(vertices[0], vertices[7], vertices[3], colors.left));

  // Right face (x+)
  triangles.push(createTriangle(vertices[5], vertices[1], vertices[2], colors.right));
  triangles.push(createTriangle(vertices[5], vertices[2], vertices[6], colors.right));

  // Top face (y+)
  triangles.push(createTriangle(vertices[7], vertices[6], vertices[2], colors.top));
  triangles.push(createTriangle(vertices[7], vertices[2], vertices[3], colors.top));

  // Bottom face (y-)
  triangles.push(createTriangle(vertices[0], vertices[1], vertices[5], colors.bottom));
  triangles.push(createTriangle(vertices[0], vertices[5], vertices[4], colors.bottom));

  return triangles;
}

// Create a grid of cubes for BVH testing
export function createCubeGrid(gridSize: number, spacing: number, cubeSize: number): Triangle[] {
  const triangles: Triangle[] = [];
  const offset = ((gridSize - 1) * spacing) / 2;

  for (let x = 0; x < gridSize; x++) {
    for (let y = 0; y < gridSize; y++) {
      for (let z = 0; z < gridSize; z++) {
        const center = {
          x: x * spacing - offset,
          y: y * spacing - offset,
          z: z * spacing - offset,
        };

        // Generate a color based on position
        const color = {
          x: (x + 1) / gridSize,
          y: (y + 1) / gridSize,
          z: (z + 1) / gridSize,
        };

        triangles.push(...createCube(center, cubeSize, color));
      }
    }
  }

  return triangles;
}

// Pack triangles into a Float32Array for GPU upload
// Layout per triangle: v0(3) + pad(1) + v1(3) + pad(1) + v2(3) + pad(1) + normal(3) + pad(1) + color(3) + pad(1) = 20 floats
export function packTriangles(triangles: Triangle[]): Float32Array {
  const floatsPerTriangle = 20;
  const buffer = new ArrayBuffer(triangles.length * floatsPerTriangle * 4);
  const data = new Float32Array(buffer);

  for (let i = 0; i < triangles.length; i++) {
    const t = triangles[i];
    const offset = i * floatsPerTriangle;

    // v0 + padding
    data[offset + 0] = t.v0.x;
    data[offset + 1] = t.v0.y;
    data[offset + 2] = t.v0.z;
    data[offset + 3] = 0;

    // v1 + padding
    data[offset + 4] = t.v1.x;
    data[offset + 5] = t.v1.y;
    data[offset + 6] = t.v1.z;
    data[offset + 7] = 0;

    // v2 + padding
    data[offset + 8] = t.v2.x;
    data[offset + 9] = t.v2.y;
    data[offset + 10] = t.v2.z;
    data[offset + 11] = 0;

    // normal + padding
    data[offset + 12] = t.normal.x;
    data[offset + 13] = t.normal.y;
    data[offset + 14] = t.normal.z;
    data[offset + 15] = 0;

    // color + padding
    data[offset + 16] = t.color.x;
    data[offset + 17] = t.color.y;
    data[offset + 18] = t.color.z;
    data[offset + 19] = 0;
  }

  return data;
}
