import { Camera } from '../renderer';
import {
  getDungeonMap,
  getDungeonEyeHeight,
  TILE_SIZE,
  DUNGEON_START_X,
  DUNGEON_START_Z,
  DUNGEON_START_DIR,
} from './dungeon';

// Direction: 0=N(+Z), 1=E(+X), 2=S(-Z), 3=W(-X)
const DIR_DX = [0, 1, 0, -1];
const DIR_DZ = [1, 0, -1, 0];

// Yaw angles for each direction (radians)
// Camera looks along +Z at yaw=0, +X at yaw=PI/2, etc.
const DIR_YAW = [0, Math.PI / 2, Math.PI, -Math.PI / 2];

function lerpAngle(from: number, to: number, t: number): number {
  // Normalize difference to [-PI, PI]
  let diff = to - from;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  return from + diff * t;
}

export class DungeonCameraController {
  private tileX: number;
  private tileZ: number;
  private facing: number; // 0-3

  // Current world position (smoothly animated)
  private worldX: number;
  private worldZ: number;
  private worldYaw: number;

  // Animation state
  private animating = false;
  private animFrom: { x: number; z: number; yaw: number } = { x: 0, z: 0, yaw: 0 };
  private animTo: { x: number; z: number; yaw: number } = { x: 0, z: 0, yaw: 0 };
  private animProgress = 0;
  private animDuration = 0.25; // seconds per step

  // Head bob for walking animation
  private bobPhase = 0;
  private bobActive = false;

  // Input state - track key presses as discrete events
  private pendingActions: string[] = [];
  private keysDown: Set<string> = new Set();
  public active = false;

  private readonly fov = 75;
  private readonly map: number[][];
  private readonly eyeHeight: number;

  // Stored references for detach()
  private keyTarget: EventTarget | null = null;
  private onKeyDown: ((e: Event) => void) | null = null;
  private onKeyUp: ((e: Event) => void) | null = null;

  constructor() {
    this.tileX = DUNGEON_START_X;
    this.tileZ = DUNGEON_START_Z;
    this.facing = DUNGEON_START_DIR;
    this.map = getDungeonMap();
    this.eyeHeight = getDungeonEyeHeight();

    this.worldX = this.tileToWorldX(this.tileX);
    this.worldZ = this.tileToWorldZ(this.tileZ);
    this.worldYaw = DIR_YAW[this.facing];
  }

  private tileToWorldX(tx: number): number {
    return tx * TILE_SIZE + TILE_SIZE / 2;
  }

  private tileToWorldZ(tz: number): number {
    return tz * TILE_SIZE + TILE_SIZE / 2;
  }

  private isWalkable(tx: number, tz: number): boolean {
    if (tz < 0 || tz >= this.map.length) return false;
    if (tx < 0 || tx >= this.map[0].length) return false;
    return this.map[tz][tx] === 0;
  }

  attach(canvas: HTMLCanvasElement, keyboardTarget?: EventTarget): void {
    this.detach();
    this.keyTarget = keyboardTarget || window;

    this.onKeyDown = (e: Event) => {
      if (!this.active) return;
      const code = (e as KeyboardEvent).code;
      if (this.keysDown.has(code)) return;
      this.keysDown.add(code);

      switch (code) {
        case 'KeyW':
        case 'KeyA':
        case 'KeyD':
        case 'KeyS':
        case 'KeyQ':
        case 'KeyE':
          this.pendingActions.push(code);
          break;
      }
    };

    this.onKeyUp = (e: Event) => {
      this.keysDown.delete((e as KeyboardEvent).code);
    };

    this.keyTarget.addEventListener('keydown', this.onKeyDown);
    this.keyTarget.addEventListener('keyup', this.onKeyUp);
  }

  detach(): void {
    if (this.keyTarget && this.onKeyDown) {
      this.keyTarget.removeEventListener('keydown', this.onKeyDown);
      this.keyTarget.removeEventListener('keyup', this.onKeyUp!);
    }
    this.keysDown.clear();
    this.pendingActions = [];
    this.keyTarget = null;
  }

  update(deltaTime: number): void {
    if (this.animating) {
      this.animProgress += deltaTime / this.animDuration;
      if (this.animProgress >= 1) {
        this.animProgress = 1;
        this.animating = false;
        this.bobActive = false;
        this.worldX = this.animTo.x;
        this.worldZ = this.animTo.z;
        this.worldYaw = this.animTo.yaw;
      } else {
        // Smooth step interpolation
        const t = this.animProgress;
        const smooth = t * t * (3 - 2 * t);

        this.worldX = this.animFrom.x + (this.animTo.x - this.animFrom.x) * smooth;
        this.worldZ = this.animFrom.z + (this.animTo.z - this.animFrom.z) * smooth;
        this.worldYaw = lerpAngle(this.animFrom.yaw, this.animTo.yaw, smooth);
      }

      // Head bob during movement
      if (this.bobActive) {
        this.bobPhase += deltaTime * 12;
      }

      return; // Don't process input while animating
    }

    // Process next pending action
    if (this.pendingActions.length === 0) return;
    const action = this.pendingActions.shift()!;

    this.animFrom = { x: this.worldX, z: this.worldZ, yaw: this.worldYaw };

    switch (action) {
      case 'KeyW': {
        // Move forward
        const nx = this.tileX + DIR_DX[this.facing];
        const nz = this.tileZ + DIR_DZ[this.facing];
        if (this.isWalkable(nx, nz)) {
          this.tileX = nx;
          this.tileZ = nz;
          this.startMoveAnim();
        }
        break;
      }
      case 'KeyS': {
        // Move backward
        const backDir = (this.facing + 2) % 4;
        const nx = this.tileX + DIR_DX[backDir];
        const nz = this.tileZ + DIR_DZ[backDir];
        if (this.isWalkable(nx, nz)) {
          this.tileX = nx;
          this.tileZ = nz;
          this.startMoveAnim();
        }
        break;
      }
      case 'KeyA': {
        // Strafe left
        const leftDir = (this.facing + 1) % 4;
        const nx = this.tileX + DIR_DX[leftDir];
        const nz = this.tileZ + DIR_DZ[leftDir];
        if (this.isWalkable(nx, nz)) {
          this.tileX = nx;
          this.tileZ = nz;
          this.startMoveAnim();
        }
        break;
      }
      case 'KeyD': {
        // Strafe right
        const rightDir = (this.facing + 3) % 4;
        const nx = this.tileX + DIR_DX[rightDir];
        const nz = this.tileZ + DIR_DZ[rightDir];
        if (this.isWalkable(nx, nz)) {
          this.tileX = nx;
          this.tileZ = nz;
          this.startMoveAnim();
        }
        break;
      }
      case 'KeyQ': {
        // Rotate left (counter-clockwise from above)
        this.facing = (this.facing + 1) % 4;
        this.startTurnAnim();
        break;
      }
      case 'KeyE': {
        // Rotate right (clockwise from above)
        this.facing = (this.facing + 3) % 4;
        this.startTurnAnim();
        break;
      }
    }
  }

  private startMoveAnim(): void {
    this.animTo = {
      x: this.tileToWorldX(this.tileX),
      z: this.tileToWorldZ(this.tileZ),
      yaw: this.worldYaw,
    };
    this.animating = true;
    this.animProgress = 0;
    this.bobActive = true;
    this.bobPhase = 0;
  }

  private startTurnAnim(): void {
    this.animTo = {
      x: this.worldX,
      z: this.worldZ,
      yaw: DIR_YAW[this.facing],
    };
    this.animating = true;
    this.animProgress = 0;
    this.bobActive = false;
  }

  getCamera(): Camera {
    // Head bob offset
    let bobY = 0;
    if (this.bobActive && this.animating) {
      bobY = Math.sin(this.bobPhase) * 0.06;
    }

    const direction = {
      x: Math.sin(this.worldYaw),
      y: 0,
      z: Math.cos(this.worldYaw),
    };

    return {
      position: {
        x: this.worldX,
        y: this.eyeHeight + bobY,
        z: this.worldZ,
      },
      direction,
      up: { x: 0, y: 1, z: 0 },
      fov: this.fov,
    };
  }
}
