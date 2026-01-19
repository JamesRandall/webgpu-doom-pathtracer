// Collision detection for Doom levels
import { LevelData } from './wad-parser';

// Scale factor (same as level-converter)
const SCALE = 1 / 64;

// Player collision radius in world units
const PLAYER_RADIUS = 0.35;  // ~22 Doom units

// Player height for ceiling checks
const PLAYER_HEIGHT = 0.875;  // ~56 Doom units (eye level)

// Maximum step height player can climb
const MAX_STEP_HEIGHT = 0.375;  // ~24 Doom units

// Linedef flags
const ML_BLOCKING = 0x0001;
const ML_TWOSIDED = 0x0004;

interface LineSegment {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  frontSector: number;
  backSector: number;  // -1 if one-sided
  isTwoSided: boolean;
  isBlocking: boolean;
}

interface SectorInfo {
  floor: number;
  ceiling: number;
}

export class CollisionDetector {
  private lines: LineSegment[] = [];
  private sectors: SectorInfo[] = [];

  constructor(level: LevelData) {
    // Store sector heights
    this.sectors = level.sectors.map(s => ({
      floor: s.floorHeight * SCALE,
      ceiling: s.ceilingHeight * SCALE,
    }));

    // Build line segments from linedefs
    for (const linedef of level.linedefs) {
      const v1 = level.vertices[linedef.startVertex];
      const v2 = level.vertices[linedef.endVertex];

      const frontSector = linedef.rightSidedef !== -1
        ? level.sidedefs[linedef.rightSidedef].sector
        : -1;
      const backSector = linedef.leftSidedef !== -1
        ? level.sidedefs[linedef.leftSidedef].sector
        : -1;

      this.lines.push({
        x1: v1.x * SCALE,
        z1: v1.y * SCALE,
        x2: v2.x * SCALE,
        z2: v2.y * SCALE,
        frontSector,
        backSector,
        isTwoSided: (linedef.flags & ML_TWOSIDED) !== 0,
        isBlocking: (linedef.flags & ML_BLOCKING) !== 0,
      });
    }

    console.log(`Collision: ${this.lines.length} lines, ${this.sectors.length} sectors`);
  }

  // Check if a move is valid, return adjusted position
  checkMove(
    oldPos: { x: number; y: number; z: number },
    newPos: { x: number; y: number; z: number }
  ): { x: number; y: number; z: number } {
    // Calculate move distance
    const dx = newPos.x - oldPos.x;
    const dz = newPos.z - oldPos.z;
    const moveDist = Math.sqrt(dx * dx + dz * dz);

    // Substep if moving fast to prevent tunneling
    const maxStepDist = PLAYER_RADIUS * 0.5;
    const numSteps = Math.max(1, Math.ceil(moveDist / maxStepDist));

    let currentPos = { ...oldPos };

    for (let i = 0; i < numSteps; i++) {
      const t = (i + 1) / numSteps;
      const targetPos = {
        x: oldPos.x + dx * t,
        y: oldPos.y + (newPos.y - oldPos.y) * t,
        z: oldPos.z + dz * t,
      };

      currentPos = this.tryMove(currentPos, targetPos);
    }

    // Apply floor/ceiling constraints
    const floorHeight = this.getFloorHeightAt(currentPos.x, currentPos.z, oldPos.y);
    const ceilingHeight = this.getCeilingHeightAt(currentPos.x, currentPos.z);

    // Clamp to floor
    const minY = floorHeight + PLAYER_HEIGHT;
    if (currentPos.y < minY) {
      currentPos.y = minY;
    }

    // Clamp to ceiling
    const maxY = ceilingHeight - 0.05;
    if (currentPos.y > maxY) {
      currentPos.y = maxY;
    }

    return currentPos;
  }

  private tryMove(
    oldPos: { x: number; y: number; z: number },
    newPos: { x: number; y: number; z: number }
  ): { x: number; y: number; z: number } {
    const playerY = oldPos.y;

    // Check if new position is valid
    if (!this.isPositionBlocked(newPos.x, newPos.z, playerY)) {
      return newPos;
    }

    // Try sliding along X axis only
    if (!this.isPositionBlocked(newPos.x, oldPos.z, playerY)) {
      return { x: newPos.x, y: newPos.y, z: oldPos.z };
    }

    // Try sliding along Z axis only
    if (!this.isPositionBlocked(oldPos.x, newPos.z, playerY)) {
      return { x: oldPos.x, y: newPos.y, z: newPos.z };
    }

    // Can't move, stay in place (but allow Y change)
    return { x: oldPos.x, y: newPos.y, z: oldPos.z };
  }

  // Check if a position is blocked by any wall
  private isPositionBlocked(x: number, z: number, playerY: number): boolean {
    const playerFeet = playerY - PLAYER_HEIGHT;

    for (const line of this.lines) {
      // Get distance from point to line segment
      const dist = this.pointToSegmentDistance(x, z, line.x1, line.z1, line.x2, line.z2);

      // If we're not close enough to this line, skip it
      if (dist >= PLAYER_RADIUS) {
        continue;
      }

      // One-sided lines always block
      if (!line.isTwoSided || line.frontSector === -1 || line.backSector === -1) {
        return true;
      }

      // Explicitly blocking lines always block
      if (line.isBlocking) {
        return true;
      }

      // Two-sided line - check if we can pass through
      const frontFloor = this.sectors[line.frontSector].floor;
      const frontCeiling = this.sectors[line.frontSector].ceiling;
      const backFloor = this.sectors[line.backSector].floor;
      const backCeiling = this.sectors[line.backSector].ceiling;

      // The opening
      const openingFloor = Math.max(frontFloor, backFloor);
      const openingCeiling = Math.min(frontCeiling, backCeiling);
      const openingHeight = openingCeiling - openingFloor;

      // Not enough vertical space to pass
      if (openingHeight < PLAYER_HEIGHT) {
        return true;
      }

      // Check step height - can we step up?
      const stepUp = openingFloor - playerFeet;
      if (stepUp > MAX_STEP_HEIGHT) {
        return true;
      }

      // Check headroom at the opening
      if (playerY > openingCeiling - 0.1) {
        return true;
      }
    }

    return false;
  }

  // Distance from point (px, pz) to line segment (x1,z1)-(x2,z2)
  private pointToSegmentDistance(
    px: number, pz: number,
    x1: number, z1: number,
    x2: number, z2: number
  ): number {
    const dx = x2 - x1;
    const dz = z2 - z1;
    const lengthSq = dx * dx + dz * dz;

    if (lengthSq < 0.0001) {
      // Degenerate segment (point)
      return Math.sqrt((px - x1) * (px - x1) + (pz - z1) * (pz - z1));
    }

    // Project point onto line, clamped to segment
    let t = ((px - x1) * dx + (pz - z1) * dz) / lengthSq;
    t = Math.max(0, Math.min(1, t));

    const closestX = x1 + t * dx;
    const closestZ = z1 + t * dz;

    return Math.sqrt((px - closestX) * (px - closestX) + (pz - closestZ) * (pz - closestZ));
  }

  // Get floor height at position, considering step-up from current height
  private getFloorHeightAt(x: number, z: number, currentY: number): number {
    let bestFloor = -1000;
    const playerFeet = currentY - PLAYER_HEIGHT;

    for (const line of this.lines) {
      if (line.frontSector === -1) continue;

      // Check if point is near this line
      const dist = this.pointToSegmentDistance(x, z, line.x1, line.z1, line.x2, line.z2);
      if (dist > PLAYER_RADIUS * 2) continue;

      // Check which side of the line we're on
      const side = (x - line.x1) * (line.z2 - line.z1) - (z - line.z1) * (line.x2 - line.x1);

      let sectorIndex: number;
      if (side >= 0) {
        sectorIndex = line.frontSector;
      } else if (line.backSector !== -1) {
        sectorIndex = line.backSector;
      } else {
        sectorIndex = line.frontSector;
      }

      const floor = this.sectors[sectorIndex].floor;

      // Only use this floor if we can step up to it
      if (floor - playerFeet <= MAX_STEP_HEIGHT && floor > bestFloor) {
        bestFloor = floor;
      }
    }

    return bestFloor > -999 ? bestFloor : 0;
  }

  // Get ceiling height at position
  private getCeilingHeightAt(x: number, z: number): number {
    let bestCeiling = 1000;

    for (const line of this.lines) {
      if (line.frontSector === -1) continue;

      const dist = this.pointToSegmentDistance(x, z, line.x1, line.z1, line.x2, line.z2);
      if (dist > PLAYER_RADIUS * 2) continue;

      const side = (x - line.x1) * (line.z2 - line.z1) - (z - line.z1) * (line.x2 - line.x1);

      let sectorIndex: number;
      if (side >= 0) {
        sectorIndex = line.frontSector;
      } else if (line.backSector !== -1) {
        sectorIndex = line.backSector;
      } else {
        sectorIndex = line.frontSector;
      }

      const ceiling = this.sectors[sectorIndex].ceiling;
      if (ceiling < bestCeiling) {
        bestCeiling = ceiling;
      }
    }

    return bestCeiling < 999 ? bestCeiling : 10;
  }

  // Public method to get floor height (for initial positioning)
  getFloorHeight(x: number, z: number): number {
    return this.getFloorHeightAt(x, z, 1000);  // High current Y to accept any floor
  }
}
