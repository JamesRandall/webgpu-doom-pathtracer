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

  let renderer = new Renderer(device, context, format, canvas.width, canvas.height, cameraController.getCamera(), triangles);
  await renderer.initialize();

  // UI Controls
  const samplesSlider = document.getElementById('samples') as HTMLInputElement;
  const samplesValue = document.getElementById('samples-value') as HTMLSpanElement;
  const resolutionSelect = document.getElementById('resolution') as HTMLSelectElement;
  const temporalCheckbox = document.getElementById('temporal') as HTMLInputElement;
  const denoiseCheckbox = document.getElementById('denoise') as HTMLInputElement;

  // Set initial values from renderer
  // Samples slider uses powers of 2: slider value 0-10 maps to 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024
  const samplesPow = Math.log2(renderer.samplesPerPixel);
  samplesSlider.value = String(samplesPow);
  samplesValue.textContent = String(renderer.samplesPerPixel);
  resolutionSelect.value = String(Renderer.RESOLUTION_SCALE);
  temporalCheckbox.checked = renderer.enableTemporalReprojection;
  denoiseCheckbox.checked = renderer.enableSpatialDenoise;

  // Samples per pixel (powers of 2: 1, 2, 4, 8, ... 1024)
  samplesSlider.addEventListener('input', () => {
    const samples = Math.pow(2, parseInt(samplesSlider.value));
    renderer.samplesPerPixel = samples;
    samplesValue.textContent = String(samples);
  });

  // Resolution scale (requires recreating renderer)
  resolutionSelect.addEventListener('change', async () => {
    Renderer.RESOLUTION_SCALE = parseFloat(resolutionSelect.value);
    renderer = new Renderer(device, context, format, canvas.width, canvas.height, cameraController.getCamera(), triangles);
    await renderer.initialize();
    // Restore settings
    renderer.samplesPerPixel = Math.pow(2, parseInt(samplesSlider.value));
    renderer.enableTemporalReprojection = temporalCheckbox.checked;
    renderer.enableSpatialDenoise = denoiseCheckbox.checked;
  });

  // Temporal reprojection
  temporalCheckbox.addEventListener('change', () => {
    renderer.enableTemporalReprojection = temporalCheckbox.checked;
  });

  // Spatial denoise
  denoiseCheckbox.addEventListener('change', () => {
    renderer.enableSpatialDenoise = denoiseCheckbox.checked;
  });

  let lastTime = performance.now();
  const fpsElement = document.getElementById('fps') as HTMLDivElement;
  let frameCount = 0;
  let fpsAccumulator = 0;
  let lastFpsUpdate = performance.now();

  function frame(currentTime: number) {
    const deltaTime = (currentTime - lastTime) / 1000;
    lastTime = currentTime;

    cameraController.update(deltaTime);
    renderer.updateCamera(cameraController.getCamera());
    renderer.render();

    // FPS tracking
    frameCount++;
    fpsAccumulator += deltaTime;
    if (currentTime - lastFpsUpdate >= 500) {
      const fps = frameCount / fpsAccumulator;
      fpsElement.textContent = `FPS: ${fps.toFixed(1)}`;
      frameCount = 0;
      fpsAccumulator = 0;
      lastFpsUpdate = currentTime;
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

main().catch(console.error);
