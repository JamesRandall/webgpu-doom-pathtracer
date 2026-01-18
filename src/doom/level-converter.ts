// Convert Doom level data to triangle meshes
import { LevelData, Vertex, Linedef, Sidedef, Sector } from './wad-parser';
import { Triangle, Material, Vec3, SceneData, MATERIAL_DIFFUSE, MATERIAL_EMISSIVE } from '../scene/geometry';

// Doom units to world units scale (Doom 1 unit ≈ 1 inch, we'll use ~1/64 for reasonable world scale)
const SCALE = 1 / 64;

// Linedef flags
const ML_TWOSIDED = 0x0004;

interface SectorPolygon {
  sectorIndex: number;
  vertices: Vec3[];  // 2D vertices (y will be height)
}

export function convertLevelToScene(level: LevelData): SceneData {
  const triangles: Triangle[] = [];
  const materials: Material[] = [];

  // Create base materials
  // 0: Default wall (gray)
  materials.push({
    albedo: { x: 0.6, y: 0.6, z: 0.6 },
    emissive: { x: 0, y: 0, z: 0 },
    roughness: 0.8,
    materialType: MATERIAL_DIFFUSE,
  });

  // 1: Floor (darker gray)
  materials.push({
    albedo: { x: 0.4, y: 0.4, z: 0.4 },
    emissive: { x: 0, y: 0, z: 0 },
    roughness: 0.9,
    materialType: MATERIAL_DIFFUSE,
  });

  // 2: Ceiling (lighter gray)
  materials.push({
    albedo: { x: 0.5, y: 0.5, z: 0.5 },
    emissive: { x: 0, y: 0, z: 0 },
    roughness: 0.9,
    materialType: MATERIAL_DIFFUSE,
  });

  // 3: Sky/emissive ceiling
  materials.push({
    albedo: { x: 0.5, y: 0.6, z: 0.8 },
    emissive: { x: 2.0, y: 2.5, z: 3.0 },
    roughness: 1.0,
    materialType: MATERIAL_EMISSIVE,
  });

  // 4: Light texture (emissive)
  materials.push({
    albedo: { x: 1.0, y: 1.0, z: 0.9 },
    emissive: { x: 8.0, y: 8.0, z: 7.0 },
    roughness: 1.0,
    materialType: MATERIAL_EMISSIVE,
  });

  const MAT_WALL = 0;
  const MAT_FLOOR = 1;
  const MAT_CEILING = 2;
  const MAT_SKY = 3;
  const MAT_LIGHT = 4;

  // Convert vertices from Doom coordinates to our coordinate system
  // Doom: X = east, Y = north, Z = up (implicit from sector heights)
  // Our system: X = right, Y = up, Z = forward
  const convertVertex = (v: Vertex, height: number): Vec3 => ({
    x: v.x * SCALE,
    y: height * SCALE,
    z: v.y * SCALE,  // Doom Y becomes our Z
  });

  // Process walls from linedefs
  for (let i = 0; i < level.linedefs.length; i++) {
    const linedef = level.linedefs[i];
    const v1 = level.vertices[linedef.startVertex];
    const v2 = level.vertices[linedef.endVertex];

    // Process right sidedef (always present for valid linedefs)
    if (linedef.rightSidedef !== -1) {
      const sidedef = level.sidedefs[linedef.rightSidedef];
      const sector = level.sectors[sidedef.sector];

      if (linedef.flags & ML_TWOSIDED) {
        // Two-sided linedef - need to check for upper/lower textures
        if (linedef.leftSidedef !== -1) {
          const backSidedef = level.sidedefs[linedef.leftSidedef];
          const backSector = level.sectors[backSidedef.sector];

          // Upper wall (if front ceiling is higher than back ceiling)
          if (sector.ceilingHeight > backSector.ceilingHeight) {
            const top = sector.ceilingHeight;
            const bottom = backSector.ceilingHeight;
            triangles.push(...createWallQuad(v1, v2, bottom, top, MAT_WALL, false));
          }

          // Lower wall (if front floor is lower than back floor)
          if (sector.floorHeight < backSector.floorHeight) {
            const top = backSector.floorHeight;
            const bottom = sector.floorHeight;
            triangles.push(...createWallQuad(v1, v2, bottom, top, MAT_WALL, false));
          }
        }
      } else {
        // One-sided linedef - full wall from floor to ceiling
        const floorHeight = sector.floorHeight;
        const ceilingHeight = sector.ceilingHeight;
        triangles.push(...createWallQuad(v1, v2, floorHeight, ceilingHeight, MAT_WALL, false));
      }
    }

    // Process left sidedef if present
    if (linedef.leftSidedef !== -1) {
      const sidedef = level.sidedefs[linedef.leftSidedef];
      const sector = level.sectors[sidedef.sector];

      if (linedef.flags & ML_TWOSIDED) {
        if (linedef.rightSidedef !== -1) {
          const frontSidedef = level.sidedefs[linedef.rightSidedef];
          const frontSector = level.sectors[frontSidedef.sector];

          // Upper wall (from back side, if back ceiling is higher than front ceiling)
          if (sector.ceilingHeight > frontSector.ceilingHeight) {
            const top = sector.ceilingHeight;
            const bottom = frontSector.ceilingHeight;
            triangles.push(...createWallQuad(v1, v2, bottom, top, MAT_WALL, true));
          }

          // Lower wall (from back side, if back floor is lower than front floor)
          if (sector.floorHeight < frontSector.floorHeight) {
            const top = frontSector.floorHeight;
            const bottom = sector.floorHeight;
            triangles.push(...createWallQuad(v1, v2, bottom, top, MAT_WALL, true));
          }
        }
      }
    }
  }

  // Build floor and ceiling polygons for each sector
  const sectorPolygons = buildSectorPolygons(level);

  for (const polygon of sectorPolygons) {
    const sector = level.sectors[polygon.sectorIndex];

    // Check if ceiling is sky
    const isSky = sector.ceilingTexture.startsWith('F_SKY');
    const ceilingMat = isSky ? MAT_SKY : MAT_CEILING;

    // Triangulate and add floor
    const floorTris = triangulatePolygon(polygon.vertices, sector.floorHeight * SCALE, false);
    for (const tri of floorTris) {
      triangles.push({ ...tri, materialIndex: MAT_FLOOR });
    }

    // Triangulate and add ceiling
    const ceilingTris = triangulatePolygon(polygon.vertices, sector.ceilingHeight * SCALE, true);
    for (const tri of ceilingTris) {
      triangles.push({ ...tri, materialIndex: ceilingMat });
    }
  }

  console.log(`Converted level ${level.name}: ${triangles.length} triangles`);

  return { triangles, materials };

  // Helper function to create a wall quad (2 triangles)
  function createWallQuad(
    v1: Vertex,
    v2: Vertex,
    bottomHeight: number,
    topHeight: number,
    materialIndex: number,
    flip: boolean
  ): Triangle[] {
    const p1 = convertVertex(v1, bottomHeight);
    const p2 = convertVertex(v2, bottomHeight);
    const p3 = convertVertex(v2, topHeight);
    const p4 = convertVertex(v1, topHeight);

    const triangles: Triangle[] = [];

    if (flip) {
      // Back face
      triangles.push(createTriangle(p2, p1, p4, materialIndex));
      triangles.push(createTriangle(p2, p4, p3, materialIndex));
    } else {
      // Front face
      triangles.push(createTriangle(p1, p2, p3, materialIndex));
      triangles.push(createTriangle(p1, p3, p4, materialIndex));
    }

    return triangles;
  }
}

// Create a triangle with computed normal
function createTriangle(v0: Vec3, v1: Vec3, v2: Vec3, materialIndex: number): Triangle {
  const edge1 = subtract(v1, v0);
  const edge2 = subtract(v2, v0);
  const normal = normalize(cross(edge1, edge2));

  return { v0, v1, v2, normal, materialIndex };
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
  if (len === 0) return { x: 0, y: 1, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

// Build polygons for each sector by tracing linedef edges
function buildSectorPolygons(level: LevelData): SectorPolygon[] {
  const polygons: SectorPolygon[] = [];

  // Build a map of sector -> linedefs
  const sectorLinedefs: Map<number, { linedef: Linedef; startVertex: number; endVertex: number }[]> = new Map();

  for (const linedef of level.linedefs) {
    if (linedef.rightSidedef !== -1) {
      const sectorIndex = level.sidedefs[linedef.rightSidedef].sector;
      if (!sectorLinedefs.has(sectorIndex)) {
        sectorLinedefs.set(sectorIndex, []);
      }
      sectorLinedefs.get(sectorIndex)!.push({
        linedef,
        startVertex: linedef.startVertex,
        endVertex: linedef.endVertex,
      });
    }

    if (linedef.leftSidedef !== -1) {
      const sectorIndex = level.sidedefs[linedef.leftSidedef].sector;
      if (!sectorLinedefs.has(sectorIndex)) {
        sectorLinedefs.set(sectorIndex, []);
      }
      // For left sidedef, the edge direction is reversed
      sectorLinedefs.get(sectorIndex)!.push({
        linedef,
        startVertex: linedef.endVertex,
        endVertex: linedef.startVertex,
      });
    }
  }

  // For each sector, trace the polygon(s)
  for (const [sectorIndex, edges] of sectorLinedefs) {
    const usedEdges = new Set<number>();

    // May have multiple polygons per sector (islands)
    while (usedEdges.size < edges.length) {
      // Find an unused edge to start
      let startEdgeIndex = -1;
      for (let i = 0; i < edges.length; i++) {
        if (!usedEdges.has(i)) {
          startEdgeIndex = i;
          break;
        }
      }
      if (startEdgeIndex === -1) break;

      const polygon: Vec3[] = [];
      let currentEdgeIndex = startEdgeIndex;
      let currentVertex = edges[currentEdgeIndex].startVertex;
      const firstVertex = currentVertex;

      // Trace the polygon
      let safety = 0;
      const maxIterations = edges.length + 1;

      while (safety < maxIterations) {
        safety++;

        if (currentEdgeIndex === -1) break;
        if (usedEdges.has(currentEdgeIndex)) {
          // Check if we've completed the loop
          if (edges[currentEdgeIndex].startVertex === firstVertex) break;
          currentEdgeIndex = -1;
          break;
        }

        usedEdges.add(currentEdgeIndex);
        const edge = edges[currentEdgeIndex];

        const v = level.vertices[edge.startVertex];
        polygon.push({ x: v.x * SCALE, y: 0, z: v.y * SCALE });

        currentVertex = edge.endVertex;

        // Find next edge that starts where this one ends
        currentEdgeIndex = -1;
        for (let i = 0; i < edges.length; i++) {
          if (!usedEdges.has(i) && edges[i].startVertex === currentVertex) {
            currentEdgeIndex = i;
            break;
          }
        }

        // Check if we've completed the loop
        if (currentVertex === firstVertex) break;
      }

      if (polygon.length >= 3) {
        polygons.push({ sectorIndex, vertices: polygon });
      }
    }
  }

  return polygons;
}

// Simple ear clipping triangulation for convex/simple polygons
function triangulatePolygon(vertices: Vec3[], height: number, flip: boolean): Triangle[] {
  if (vertices.length < 3) return [];

  const triangles: Triangle[] = [];

  // Set all vertices to the correct height
  const verts = vertices.map(v => ({ x: v.x, y: height, z: v.z }));

  // Simple fan triangulation (works well for mostly convex polygons)
  // For more complex polygons, ear clipping would be needed
  for (let i = 1; i < verts.length - 1; i++) {
    if (flip) {
      triangles.push(createTriangle(verts[0], verts[i + 1], verts[i], 0));
    } else {
      triangles.push(createTriangle(verts[0], verts[i], verts[i + 1], 0));
    }
  }

  return triangles;
}
