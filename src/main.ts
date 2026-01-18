import { Renderer } from './renderer';
import { createCubeGrid } from './scene/geometry';
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

  // Camera controller - positioned to see the cube grid
  const cameraController = new CameraController(
    { x: 15, y: 10, z: -15 },  // position - further back to see grid
    -0.78,                      // yaw (radians)
    -0.3,                       // pitch (radians)
    60,                         // fov
    10,                         // move speed - faster for larger scene
    0.002                       // look sensitivity
  );
  cameraController.attach(canvas);

  // Create a 5x5x5 grid of cubes = 125 cubes = 1500 triangles
  // This tests BVH acceleration with 1000+ triangles
  const triangles = createCubeGrid(5, 3, 1);
  console.log(`Scene: ${triangles.length} triangles`);

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
