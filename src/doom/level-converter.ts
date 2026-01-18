// Convert Doom level data to triangle meshes
import { LevelData, Vertex, Linedef, Sidedef, Sector } from './wad-parser';
import { Triangle, Material, Vec3, SceneData, MATERIAL_DIFFUSE, MATERIAL_EMISSIVE } from '../scene/geometry';

// Doom units to world units scale (Doom 1 unit ≈ 1 inch, we'll use ~1/64 for reasonable world scale)
const SCALE = 1 / 64;

// Global emissive multiplier for tuning light intensity
const EMISSIVE_MULTIPLIER = 3.0;

// Linedef flags
const ML_TWOSIDED = 0x0004;

// Emissive texture patterns
const EMISSIVE_TEXTURES = [
  'LITE',     // LITE3, LITE5, LITEBLU1, etc.
  'TLITE',    // TLITE6_1, etc.
  'BFALL',    // Blood fall (glowing)
  'SFALL',    // Slime fall (glowing)
  'FIREBLU',  // Animated fire
  'FIRELAV',  // Fire/lava
  'FIREMAG',  // Fire/magma
  'FIREWALA', // Fire wall
  'FIREWALB',
  'FIREWALL',
  'NUKAGE',   // Nukage (glowing green)
  'FWATER',   // Glowing water
  'LAVA',     // Lava
  'BLOOD',    // Blood (slightly glowing)
  'COMP',     // Computer screens (COMPSTA*, etc.)
  'COMPSTA',
  'SW1COMP',  // Computer switches
  'SW2COMP',
];

interface SectorPolygon {
  sectorIndex: number;
  vertices: Vec3[];
}

// Check if a texture name is emissive
function isEmissiveTexture(textureName: string): boolean {
  const upper = textureName.toUpperCase().replace(/\0/g, '');
  for (const pattern of EMISSIVE_TEXTURES) {
    if (upper.startsWith(pattern)) {
      return true;
    }
  }
  return false;
}

// Get emissive color based on texture name
function getEmissiveColor(textureName: string): Vec3 {
  const upper = textureName.toUpperCase();

  if (upper.includes('BLU') || upper.includes('COMP')) {
    // Blue lights / computer screens
    return { x: 0.3 * EMISSIVE_MULTIPLIER, y: 0.5 * EMISSIVE_MULTIPLIER, z: 1.0 * EMISSIVE_MULTIPLIER };
  } else if (upper.includes('FIRE') || upper.includes('LAV') || upper.includes('RED')) {
    // Fire / lava - orange/red
    return { x: 1.0 * EMISSIVE_MULTIPLIER, y: 0.4 * EMISSIVE_MULTIPLIER, z: 0.1 * EMISSIVE_MULTIPLIER };
  } else if (upper.includes('NUK') || upper.includes('SLIME') || upper.includes('SFALL')) {
    // Nukage / slime - green
    return { x: 0.2 * EMISSIVE_MULTIPLIER, y: 1.0 * EMISSIVE_MULTIPLIER, z: 0.2 * EMISSIVE_MULTIPLIER };
  } else if (upper.includes('BLOOD') || upper.includes('BFALL')) {
    // Blood - dark red
    return { x: 0.8 * EMISSIVE_MULTIPLIER, y: 0.1 * EMISSIVE_MULTIPLIER, z: 0.1 * EMISSIVE_MULTIPLIER };
  } else {
    // Default white/yellow light
    return { x: 1.0 * EMISSIVE_MULTIPLIER, y: 0.95 * EMISSIVE_MULTIPLIER, z: 0.8 * EMISSIVE_MULTIPLIER };
  }
}

// Convert sector light level (0-255) to brightness multiplier
function lightLevelToBrightness(lightLevel: number): number {
  // Doom light levels: 0 = dark, 255 = bright
  // We'll map this to a reasonable range for path tracing
  // Using a slight curve to make dark areas darker
  const normalized = lightLevel / 255;
  return 0.1 + 0.9 * Math.pow(normalized, 1.5);
}

export function convertLevelToScene(level: LevelData): SceneData {
  const triangles: Triangle[] = [];
  const materials: Material[] = [];
  const materialCache: Map<string, number> = new Map();

  // Helper to get or create a material
  function getMaterial(
    type: 'wall' | 'floor' | 'ceiling' | 'sky',
    lightLevel: number,
    textureName: string = ''
  ): number {
    const isEmissive = isEmissiveTexture(textureName);
    const brightness = lightLevelToBrightness(lightLevel);
    const key = `${type}-${lightLevel}-${textureName}-${isEmissive}`;

    if (materialCache.has(key)) {
      return materialCache.get(key)!;
    }

    const index = materials.length;
    materialCache.set(key, index);

    if (type === 'sky') {
      // Sky is always emissive
      materials.push({
        albedo: { x: 0.6, y: 0.7, z: 0.9 },
        emissive: { x: 1.5, y: 2.0, z: 3.0 },
        roughness: 1.0,
        materialType: MATERIAL_EMISSIVE,
      });
    } else if (isEmissive) {
      const emissiveColor = getEmissiveColor(textureName);
      materials.push({
        albedo: { x: 1.0, y: 1.0, z: 1.0 },
        emissive: emissiveColor,
        roughness: 1.0,
        materialType: MATERIAL_EMISSIVE,
      });
    } else {
      // Base colors for different surface types
      let baseColor: Vec3;
      switch (type) {
        case 'wall':
          baseColor = { x: 0.6, y: 0.55, z: 0.5 };
          break;
        case 'floor':
          baseColor = { x: 0.45, y: 0.42, z: 0.4 };
          break;
        case 'ceiling':
          baseColor = { x: 0.5, y: 0.48, z: 0.45 };
          break;
        default:
          baseColor = { x: 0.5, y: 0.5, z: 0.5 };
      }

      // Apply brightness from sector light level
      materials.push({
        albedo: {
          x: baseColor.x * brightness,
          y: baseColor.y * brightness,
          z: baseColor.z * brightness,
        },
        emissive: { x: 0, y: 0, z: 0 },
        roughness: 0.85,
        materialType: MATERIAL_DIFFUSE,
      });
    }

    return index;
  }

  // Convert vertices from Doom coordinates to our coordinate system
  const convertVertex = (v: Vertex, height: number): Vec3 => ({
    x: v.x * SCALE,
    y: height * SCALE,
    z: v.y * SCALE,
  });

  // Helper function to create a wall quad
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

    const tris: Triangle[] = [];

    if (flip) {
      tris.push(createTriangle(p2, p1, p4, materialIndex));
      tris.push(createTriangle(p2, p4, p3, materialIndex));
    } else {
      tris.push(createTriangle(p1, p2, p3, materialIndex));
      tris.push(createTriangle(p1, p3, p4, materialIndex));
    }

    return tris;
  }

  // Process walls from linedefs
  for (let i = 0; i < level.linedefs.length; i++) {
    const linedef = level.linedefs[i];
    const v1 = level.vertices[linedef.startVertex];
    const v2 = level.vertices[linedef.endVertex];

    // Process right sidedef
    if (linedef.rightSidedef !== -1) {
      const sidedef = level.sidedefs[linedef.rightSidedef];
      const sector = level.sectors[sidedef.sector];

      if (linedef.flags & ML_TWOSIDED) {
        if (linedef.leftSidedef !== -1) {
          const backSidedef = level.sidedefs[linedef.leftSidedef];
          const backSector = level.sectors[backSidedef.sector];

          // Upper wall
          if (sector.ceilingHeight > backSector.ceilingHeight) {
            const mat = getMaterial('wall', sector.lightLevel, sidedef.upperTexture);
            triangles.push(...createWallQuad(v1, v2, backSector.ceilingHeight, sector.ceilingHeight, mat, false));
          }

          // Lower wall
          if (sector.floorHeight < backSector.floorHeight) {
            const mat = getMaterial('wall', sector.lightLevel, sidedef.lowerTexture);
            triangles.push(...createWallQuad(v1, v2, sector.floorHeight, backSector.floorHeight, mat, false));
          }

          // Middle texture (if present, for fences/gratings)
          if (sidedef.middleTexture && sidedef.middleTexture !== '-') {
            const mat = getMaterial('wall', sector.lightLevel, sidedef.middleTexture);
            const top = Math.min(sector.ceilingHeight, backSector.ceilingHeight);
            const bottom = Math.max(sector.floorHeight, backSector.floorHeight);
            if (top > bottom) {
              triangles.push(...createWallQuad(v1, v2, bottom, top, mat, false));
            }
          }
        }
      } else {
        // One-sided linedef
        const mat = getMaterial('wall', sector.lightLevel, sidedef.middleTexture);
        triangles.push(...createWallQuad(v1, v2, sector.floorHeight, sector.ceilingHeight, mat, false));
      }
    }

    // Process left sidedef
    if (linedef.leftSidedef !== -1) {
      const sidedef = level.sidedefs[linedef.leftSidedef];
      const sector = level.sectors[sidedef.sector];

      if (linedef.flags & ML_TWOSIDED) {
        if (linedef.rightSidedef !== -1) {
          const frontSidedef = level.sidedefs[linedef.rightSidedef];
          const frontSector = level.sectors[frontSidedef.sector];

          // Upper wall (from back side)
          if (sector.ceilingHeight > frontSector.ceilingHeight) {
            const mat = getMaterial('wall', sector.lightLevel, sidedef.upperTexture);
            triangles.push(...createWallQuad(v1, v2, frontSector.ceilingHeight, sector.ceilingHeight, mat, true));
          }

          // Lower wall (from back side)
          if (sector.floorHeight < frontSector.floorHeight) {
            const mat = getMaterial('wall', sector.lightLevel, sidedef.lowerTexture);
            triangles.push(...createWallQuad(v1, v2, sector.floorHeight, frontSector.floorHeight, mat, true));
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
    const isSky = sector.ceilingTexture.toUpperCase().startsWith('F_SKY');

    // Floor material
    const floorMat = getMaterial('floor', sector.lightLevel, sector.floorTexture);

    // Ceiling material
    const ceilingMat = isSky
      ? getMaterial('sky', 255, 'SKY')
      : getMaterial('ceiling', sector.lightLevel, sector.ceilingTexture);

    // Triangulate and add floor
    const floorTris = triangulatePolygon(polygon.vertices, sector.floorHeight * SCALE, false);
    for (const tri of floorTris) {
      triangles.push({ ...tri, materialIndex: floorMat });
    }

    // Triangulate and add ceiling
    const ceilingTris = triangulatePolygon(polygon.vertices, sector.ceilingHeight * SCALE, true);
    for (const tri of ceilingTris) {
      triangles.push({ ...tri, materialIndex: ceilingMat });
    }
  }

  console.log(`Converted level ${level.name}: ${triangles.length} triangles, ${materials.length} materials`);

  return { triangles, materials };
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
      sectorLinedefs.get(sectorIndex)!.push({
        linedef,
        startVertex: linedef.endVertex,
        endVertex: linedef.startVertex,
      });
    }
  }

  for (const [sectorIndex, edges] of sectorLinedefs) {
    const usedEdges = new Set<number>();

    while (usedEdges.size < edges.length) {
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

      let safety = 0;
      const maxIterations = edges.length + 1;

      while (safety < maxIterations) {
        safety++;

        if (currentEdgeIndex === -1) break;
        if (usedEdges.has(currentEdgeIndex)) {
          if (edges[currentEdgeIndex].startVertex === firstVertex) break;
          currentEdgeIndex = -1;
          break;
        }

        usedEdges.add(currentEdgeIndex);
        const edge = edges[currentEdgeIndex];

        const v = level.vertices[edge.startVertex];
        polygon.push({ x: v.x * SCALE, y: 0, z: v.y * SCALE });

        currentVertex = edge.endVertex;

        currentEdgeIndex = -1;
        for (let i = 0; i < edges.length; i++) {
          if (!usedEdges.has(i) && edges[i].startVertex === currentVertex) {
            currentEdgeIndex = i;
            break;
          }
        }

        if (currentVertex === firstVertex) break;
      }

      if (polygon.length >= 3) {
        polygons.push({ sectorIndex, vertices: polygon });
      }
    }
  }

  return polygons;
}

// Simple fan triangulation
function triangulatePolygon(vertices: Vec3[], height: number, flip: boolean): Triangle[] {
  if (vertices.length < 3) return [];

  const triangles: Triangle[] = [];
  const verts = vertices.map(v => ({ x: v.x, y: height, z: v.z }));

  for (let i = 1; i < verts.length - 1; i++) {
    if (flip) {
      triangles.push(createTriangle(verts[0], verts[i + 1], verts[i], 0));
    } else {
      triangles.push(createTriangle(verts[0], verts[i], verts[i + 1], 0));
    }
  }

  return triangles;
}
