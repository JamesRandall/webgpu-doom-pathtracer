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

  attach(canvas: HTMLCanvasElement): void {
    // Keyboard events
    window.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
    });

    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
    });

    // Mouse look with pointer lock
    canvas.addEventListener('click', () => {
      canvas.requestPointerLock();
    });

    document.addEventListener('pointerlockchange', () => {
      this.isLocked = document.pointerLockElement === canvas;
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.isLocked) return;

      this.yaw -= e.movementX * this.lookSensitivity;
      this.pitch -= e.movementY * this.lookSensitivity;

      // Clamp pitch to avoid gimbal lock
      const maxPitch = Math.PI / 2 - 0.01;
      this.pitch = Math.max(-maxPitch, Math.min(maxPitch, this.pitch));
    });
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
