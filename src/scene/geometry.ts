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
  emissive: Vec3;
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

function createTriangle(v0: Vec3, v1: Vec3, v2: Vec3, color: Vec3, emissive: Vec3 = { x: 0, y: 0, z: 0 }): Triangle {
  return {
    v0,
    v1,
    v2,
    normal: computeNormal(v0, v1, v2),
    color,
    emissive,
  };
}

// Create a quad from 4 vertices (2 triangles)
function createQuad(v0: Vec3, v1: Vec3, v2: Vec3, v3: Vec3, color: Vec3, emissive: Vec3 = { x: 0, y: 0, z: 0 }): Triangle[] {
  return [
    createTriangle(v0, v1, v2, color, emissive),
    createTriangle(v0, v2, v3, color, emissive),
  ];
}

export function createCube(center: Vec3, size: number, color?: Vec3): Triangle[] {
  const h = size / 2;
  const cx = center.x;
  const cy = center.y;
  const cz = center.z;

  const vertices: Vec3[] = [
    { x: cx - h, y: cy - h, z: cz - h },
    { x: cx + h, y: cy - h, z: cz - h },
    { x: cx + h, y: cy + h, z: cz - h },
    { x: cx - h, y: cy + h, z: cz - h },
    { x: cx - h, y: cy - h, z: cz + h },
    { x: cx + h, y: cy - h, z: cz + h },
    { x: cx + h, y: cy + h, z: cz + h },
    { x: cx - h, y: cy + h, z: cz + h },
  ];

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

  const noEmissive = { x: 0, y: 0, z: 0 };
  const triangles: Triangle[] = [];

  triangles.push(createTriangle(vertices[4], vertices[5], vertices[6], colors.front, noEmissive));
  triangles.push(createTriangle(vertices[4], vertices[6], vertices[7], colors.front, noEmissive));
  triangles.push(createTriangle(vertices[1], vertices[0], vertices[3], colors.back, noEmissive));
  triangles.push(createTriangle(vertices[1], vertices[3], vertices[2], colors.back, noEmissive));
  triangles.push(createTriangle(vertices[0], vertices[4], vertices[7], colors.left, noEmissive));
  triangles.push(createTriangle(vertices[0], vertices[7], vertices[3], colors.left, noEmissive));
  triangles.push(createTriangle(vertices[5], vertices[1], vertices[2], colors.right, noEmissive));
  triangles.push(createTriangle(vertices[5], vertices[2], vertices[6], colors.right, noEmissive));
  triangles.push(createTriangle(vertices[7], vertices[6], vertices[2], colors.top, noEmissive));
  triangles.push(createTriangle(vertices[7], vertices[2], vertices[3], colors.top, noEmissive));
  triangles.push(createTriangle(vertices[0], vertices[1], vertices[5], colors.bottom, noEmissive));
  triangles.push(createTriangle(vertices[0], vertices[5], vertices[4], colors.bottom, noEmissive));

  return triangles;
}

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

// Create Cornell box scene
export function createCornellBox(): Triangle[] {
  const triangles: Triangle[] = [];
  const size = 5;
  const h = size / 2;

  // Colors
  const white = { x: 0.73, y: 0.73, z: 0.73 };
  const red = { x: 0.65, y: 0.05, z: 0.05 };
  const green = { x: 0.12, y: 0.45, z: 0.15 };
  const noEmissive = { x: 0, y: 0, z: 0 };
  const lightEmissive = { x: 40, y: 40, z: 40 };

  // Floor (white)
  triangles.push(...createQuad(
    { x: -h, y: -h, z: -h },
    { x: h, y: -h, z: -h },
    { x: h, y: -h, z: h },
    { x: -h, y: -h, z: h },
    white, noEmissive
  ));

  // Ceiling (white)
  triangles.push(...createQuad(
    { x: -h, y: h, z: -h },
    { x: -h, y: h, z: h },
    { x: h, y: h, z: h },
    { x: h, y: h, z: -h },
    white, noEmissive
  ));

  // Back wall (white)
  triangles.push(...createQuad(
    { x: -h, y: -h, z: h },
    { x: h, y: -h, z: h },
    { x: h, y: h, z: h },
    { x: -h, y: h, z: h },
    white, noEmissive
  ));

  // Left wall (red)
  triangles.push(...createQuad(
    { x: -h, y: -h, z: -h },
    { x: -h, y: -h, z: h },
    { x: -h, y: h, z: h },
    { x: -h, y: h, z: -h },
    red, noEmissive
  ));

  // Right wall (green)
  triangles.push(...createQuad(
    { x: h, y: -h, z: h },
    { x: h, y: -h, z: -h },
    { x: h, y: h, z: -h },
    { x: h, y: h, z: h },
    green, noEmissive
  ));

  // Light on ceiling (emissive white quad, slightly smaller and lower than ceiling)
  const lightSize = 1.0;
  const lightY = h - 0.01;
  triangles.push(...createQuad(
    { x: -lightSize / 2, y: lightY, z: -lightSize / 2 },
    { x: -lightSize / 2, y: lightY, z: lightSize / 2 },
    { x: lightSize / 2, y: lightY, z: lightSize / 2 },
    { x: lightSize / 2, y: lightY, z: -lightSize / 2 },
    white, lightEmissive
  ));

  // Tall box (white)
  const tallBoxCenter = { x: -1.0, y: -h + 1.5, z: 0.5 };
  const tallBoxSize = 1.5;
  const tallBoxHeight = 3.0;
  triangles.push(...createBox(tallBoxCenter, tallBoxSize, tallBoxSize, tallBoxHeight, white, 0.3));

  // Short box (white)
  const shortBoxCenter = { x: 1.0, y: -h + 0.75, z: -0.5 };
  const shortBoxSize = 1.5;
  const shortBoxHeight = 1.5;
  triangles.push(...createBox(shortBoxCenter, shortBoxSize, shortBoxSize, shortBoxHeight, white, -0.25));

  return triangles;
}

// Create a box with rotation around Y axis
function createBox(center: Vec3, width: number, depth: number, height: number, color: Vec3, rotationY: number): Triangle[] {
  const triangles: Triangle[] = [];
  const hw = width / 2;
  const hd = depth / 2;
  const hh = height / 2;
  const noEmissive = { x: 0, y: 0, z: 0 };

  const cos = Math.cos(rotationY);
  const sin = Math.sin(rotationY);

  function rotateY(x: number, z: number): { x: number; z: number } {
    return {
      x: x * cos - z * sin,
      z: x * sin + z * cos,
    };
  }

  function vertex(lx: number, ly: number, lz: number): Vec3 {
    const rotated = rotateY(lx, lz);
    return {
      x: center.x + rotated.x,
      y: center.y + ly,
      z: center.z + rotated.z,
    };
  }

  // 8 vertices of the box
  const v = [
    vertex(-hw, -hh, -hd), // 0
    vertex(hw, -hh, -hd),  // 1
    vertex(hw, -hh, hd),   // 2
    vertex(-hw, -hh, hd),  // 3
    vertex(-hw, hh, -hd),  // 4
    vertex(hw, hh, -hd),   // 5
    vertex(hw, hh, hd),    // 6
    vertex(-hw, hh, hd),   // 7
  ];

  // Front face
  triangles.push(...createQuad(v[3], v[2], v[6], v[7], color, noEmissive));
  // Back face
  triangles.push(...createQuad(v[1], v[0], v[4], v[5], color, noEmissive));
  // Left face
  triangles.push(...createQuad(v[0], v[3], v[7], v[4], color, noEmissive));
  // Right face
  triangles.push(...createQuad(v[2], v[1], v[5], v[6], color, noEmissive));
  // Top face
  triangles.push(...createQuad(v[7], v[6], v[5], v[4], color, noEmissive));
  // Bottom face (usually not visible)
  triangles.push(...createQuad(v[0], v[1], v[2], v[3], color, noEmissive));

  return triangles;
}

// Pack triangles into a Float32Array for GPU upload
// Layout per triangle: v0(3)+pad + v1(3)+pad + v2(3)+pad + normal(3)+pad + color(3)+pad + emissive(3)+pad = 24 floats
export function packTriangles(triangles: Triangle[]): Float32Array {
  const floatsPerTriangle = 24;
  const buffer = new ArrayBuffer(triangles.length * floatsPerTriangle * 4);
  const data = new Float32Array(buffer);

  for (let i = 0; i < triangles.length; i++) {
    const t = triangles[i];
    const offset = i * floatsPerTriangle;

    data[offset + 0] = t.v0.x;
    data[offset + 1] = t.v0.y;
    data[offset + 2] = t.v0.z;
    data[offset + 3] = 0;

    data[offset + 4] = t.v1.x;
    data[offset + 5] = t.v1.y;
    data[offset + 6] = t.v1.z;
    data[offset + 7] = 0;

    data[offset + 8] = t.v2.x;
    data[offset + 9] = t.v2.y;
    data[offset + 10] = t.v2.z;
    data[offset + 11] = 0;

    data[offset + 12] = t.normal.x;
    data[offset + 13] = t.normal.y;
    data[offset + 14] = t.normal.z;
    data[offset + 15] = 0;

    data[offset + 16] = t.color.x;
    data[offset + 17] = t.color.y;
    data[offset + 18] = t.color.z;
    data[offset + 19] = 0;

    data[offset + 20] = t.emissive.x;
    data[offset + 21] = t.emissive.y;
    data[offset + 22] = t.emissive.z;
    data[offset + 23] = 0;
  }

  return data;
}
