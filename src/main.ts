import { Renderer } from './renderer';
import { createCube } from './scene/geometry';
import { CameraController } from './camera';

async function main() {
  const errorDiv = document.getElementById('error') as HTMLDivElement;
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;

  if (!navigator.gpu) {
    errorDiv.textContent = 'WebGPU is not supported in this browser. Please use Chrome or Edge with WebGPU enabled.';
    errorDiv.style.display = 'block';
    canvas.style.display = 'none';
    return;
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    errorDiv.textContent = 'Failed to get WebGPU adapter. Please ensure your browser supports WebGPU.';
    errorDiv.style.display = 'block';
    canvas.style.display = 'none';
    return;
  }

  const device = await adapter.requestDevice();

  const context = canvas.getContext('webgpu');
  if (!context) {
    errorDiv.textContent = 'Failed to get WebGPU context.';
    errorDiv.style.display = 'block';
    canvas.style.display = 'none';
    return;
  }

  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({
    device,
    format,
    alphaMode: 'premultiplied',
  });

  // Camera controller - positioned to see the cube at an angle
  // Camera at (3, 2, -3) looking toward origin: yaw ≈ -0.78 rad (-45°)
  const cameraController = new CameraController(
    { x: 3, y: 2, z: -3 },  // position
    -0.78,                    // yaw (radians) - points toward -x, +z
    -0.35,                    // pitch (radians) - look slightly down
    60,                       // fov
    5,                        // move speed
    0.002                     // look sensitivity
  );
  cameraController.attach(canvas);

  // Create a cube at the origin
  const triangles = createCube({ x: 0, y: 0, z: 0 }, 2);

  const renderer = new Renderer(device, context, format, canvas.width, canvas.height, cameraController.getCamera(), triangles);
  await renderer.initialize();

  let lastTime = performance.now();

  function frame(currentTime: number) {
    const deltaTime = (currentTime - lastTime) / 1000;
    lastTime = currentTime;

    cameraController.update(deltaTime);
    renderer.updateCamera(cameraController.getCamera());
    renderer.render();

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

main().catch(console.error);
