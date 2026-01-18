import { Renderer } from './renderer';
import { createCornellBox } from './scene/geometry';
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

  // Camera inside the Cornell box, looking at back wall
  const cameraController = new CameraController(
    { x: 0, y: 0, z: -4.5 },  // position near front of box
    0,                          // yaw (looking +z toward back wall)
    0,                          // pitch
    60,                         // fov
    3,                          // move speed
    0.002                       // look sensitivity
  );
  cameraController.attach(canvas);

  // Create Cornell box scene
  const triangles = createCornellBox();
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
