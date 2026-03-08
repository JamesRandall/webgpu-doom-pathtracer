import { Camera } from './renderer';
import { CollisionDetector } from './doom/collision';

export class CameraController {
  private position: { x: number; y: number; z: number };
  private yaw: number;   // Horizontal rotation (radians)
  private pitch: number; // Vertical rotation (radians)
  private readonly up = { x: 0, y: 1, z: 0 };
  private fov: number;

  private keys: Set<string> = new Set();
  private moveSpeed: number;
  private lookSensitivity: number;
  private isLocked: boolean = false;
  private collision: CollisionDetector | null = null;

  // Stored references for detach()
  private canvas: HTMLCanvasElement | null = null;
  private keyTarget: EventTarget | null = null;
  private onKeyDown: ((e: Event) => void) | null = null;
  private onKeyUp: ((e: Event) => void) | null = null;
  private onClick: (() => void) | null = null;
  private onPointerLockChange: (() => void) | null = null;
  private onMouseMove: ((e: Event) => void) | null = null;

  constructor(
    position: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 },
    yaw: number = 0,
    pitch: number = 0,
    fov: number = 60,
    moveSpeed: number = 5,
    lookSensitivity: number = 0.002
  ) {
    this.position = { ...position };
    this.yaw = yaw;
    this.pitch = pitch;
    this.fov = fov;
    this.moveSpeed = moveSpeed;
    this.lookSensitivity = lookSensitivity;
  }

  setCollision(collision: CollisionDetector): void {
    this.collision = collision;
  }

  attach(canvas: HTMLCanvasElement, keyboardTarget?: EventTarget): void {
    this.detach();
    this.canvas = canvas;
    this.keyTarget = keyboardTarget || window;

    this.onKeyDown = (e: Event) => {
      this.keys.add((e as KeyboardEvent).code);
    };
    this.onKeyUp = (e: Event) => {
      this.keys.delete((e as KeyboardEvent).code);
    };
    this.keyTarget.addEventListener('keydown', this.onKeyDown);
    this.keyTarget.addEventListener('keyup', this.onKeyUp);

    this.onClick = () => { canvas.requestPointerLock(); };
    canvas.addEventListener('click', this.onClick);

    this.onPointerLockChange = () => {
      this.isLocked = document.pointerLockElement === canvas;
    };
    document.addEventListener('pointerlockchange', this.onPointerLockChange);

    this.onMouseMove = (e: Event) => {
      if (!this.isLocked) return;
      const me = e as MouseEvent;
      this.yaw -= me.movementX * this.lookSensitivity;
      this.pitch -= me.movementY * this.lookSensitivity;
      const maxPitch = Math.PI / 2 - 0.01;
      this.pitch = Math.max(-maxPitch, Math.min(maxPitch, this.pitch));
    };
    document.addEventListener('mousemove', this.onMouseMove);
  }

  detach(): void {
    if (this.keyTarget && this.onKeyDown) {
      this.keyTarget.removeEventListener('keydown', this.onKeyDown);
      this.keyTarget.removeEventListener('keyup', this.onKeyUp!);
    }
    if (this.canvas && this.onClick) {
      this.canvas.removeEventListener('click', this.onClick);
    }
    if (this.onPointerLockChange) {
      document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    }
    if (this.onMouseMove) {
      document.removeEventListener('mousemove', this.onMouseMove);
    }
    this.keys.clear();
    this.canvas = null;
    this.keyTarget = null;
  }

  update(deltaTime: number): void {
    // Calculate forward and right vectors from yaw
    const forward = {
      x: Math.sin(this.yaw),
      y: 0,
      z: Math.cos(this.yaw),
    };

    const right = {
      x: -Math.cos(this.yaw),
      y: 0,
      z: Math.sin(this.yaw),
    };

    const speed = this.moveSpeed * deltaTime;

    // Calculate desired new position
    let newPos = { ...this.position };

    // WASD movement
    if (this.keys.has('KeyW')) {
      newPos.x += forward.x * speed;
      newPos.z += forward.z * speed;
    }
    if (this.keys.has('KeyS')) {
      newPos.x -= forward.x * speed;
      newPos.z -= forward.z * speed;
    }
    if (this.keys.has('KeyA')) {
      newPos.x -= right.x * speed;
      newPos.z -= right.z * speed;
    }
    if (this.keys.has('KeyD')) {
      newPos.x += right.x * speed;
      newPos.z += right.z * speed;
    }

    // Vertical movement (Space/Shift)
    if (this.keys.has('Space')) {
      newPos.y += speed;
    }
    if (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')) {
      newPos.y -= speed;
    }

    // Apply collision detection if available
    if (this.collision) {
      newPos = this.collision.checkMove(this.position, newPos);
    }

    this.position = newPos;

    // Rotation (Q/E)
    const rotateSpeed = 2.0 * deltaTime;  // radians per second
    if (this.keys.has('KeyQ')) {
      this.yaw += rotateSpeed;
    }
    if (this.keys.has('KeyE')) {
      this.yaw -= rotateSpeed;
    }
  }

  getCamera(): Camera {
    // Calculate look direction from yaw and pitch
    const direction = {
      x: Math.sin(this.yaw) * Math.cos(this.pitch),
      y: Math.sin(this.pitch),
      z: Math.cos(this.yaw) * Math.cos(this.pitch),
    };

    return {
      position: { ...this.position },
      direction,
      up: { ...this.up },
      fov: this.fov,
    };
  }
}
