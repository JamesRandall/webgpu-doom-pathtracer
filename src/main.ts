import { Renderer } from './renderer';
import { createCornellBox } from './scene/geometry';
import { CameraController } from './camera';
import { WadParser } from './doom/wad-parser';
import { convertLevelToScene, setTextureAtlas } from './doom/level-converter';
import { CollisionDetector } from './doom/collision';
import { TextureExtractor, TextureAtlas } from './doom/textures';

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

  // Try to load Doom WAD, fall back to Cornell box
  let scene;
  let cameraController: CameraController;
  let textureAtlas: TextureAtlas | null = null;

  try {
    const response = await fetch('/wads/DOOM1.WAD');
    if (!response.ok) throw new Error('WAD not found');
    const wadBuffer = await response.arrayBuffer();
    const wad = new WadParser(wadBuffer);

    console.log('Available levels:', wad.getLevelNames());

    // Extract textures and build atlas
    const textureExtractor = new TextureExtractor(wad);
    textureExtractor.extractAll();
    textureAtlas = textureExtractor.buildAtlas();

    // Set the atlas for UV generation
    setTextureAtlas(textureAtlas);

    const levelData = wad.parseLevel('E1M2');
    scene = convertLevelToScene(levelData);

    // Find player start position from THINGS
    const playerStart = levelData.things.find(t => t.type === 1);  // Type 1 = Player 1 start
    const startX = playerStart ? playerStart.x / 64 : 0;
    const startZ = playerStart ? playerStart.y / 64 : 0;
    const startAngle = playerStart ? (playerStart.angle * Math.PI / 180) : 0;

    // Find floor height at player start
    const startY = 0.8;  // Approximate eye height

    // Create collision detector
    const collision = new CollisionDetector(levelData);

    // Get floor height at player start for accurate Y position
    const floorY = collision.getFloorHeight(startX, startZ);
    const eyeHeight = 0.875;  // ~56 Doom units

    cameraController = new CameraController(
      { x: startX, y: floorY + eyeHeight, z: startZ },
      startAngle - Math.PI / 2,  // Convert Doom angle to our yaw
      0,
      90,   // fov
      5,    // move speed (faster for larger level)
      0.002
    );

    // Enable collision detection
    cameraController.setCollision(collision);

    console.log(`Loaded E1M1: ${scene.triangles.length} triangles, ${scene.materials.length} materials`);
  } catch (e) {
    console.warn('Failed to load WAD, using Cornell box:', e);

    // Fall back to Cornell box
    scene = createCornellBox();
    cameraController = new CameraController(
      { x: 0, y: 0, z: -4.5 },
      0,
      0,
      60,
      3,
      0.002
    );

    console.log(`Scene: ${scene.triangles.length} triangles, ${scene.materials.length} materials`);
  }

  cameraController.attach(canvas);

  let renderer = new Renderer(device, context, format, canvas.width, canvas.height, cameraController.getCamera(), scene.triangles, scene.materials, textureAtlas);
  await renderer.initialize();

  // UI Controls
  const samplesSlider = document.getElementById('samples') as HTMLInputElement;
  const samplesValue = document.getElementById('samples-value') as HTMLSpanElement;
  const bouncesSlider = document.getElementById('bounces') as HTMLInputElement;
  const bouncesValue = document.getElementById('bounces-value') as HTMLSpanElement;
  const resolutionSelect = document.getElementById('resolution') as HTMLSelectElement;
  const temporalCheckbox = document.getElementById('temporal') as HTMLInputElement;
  const denoiseCheckbox = document.getElementById('denoise') as HTMLInputElement;

  // Set initial values from renderer
  // Samples slider: 0 = 1 sample, 1-16 = 4, 8, 12, ... 64 (increments of 4)
  const sliderFromSamples = (s: number) => s === 1 ? 0 : s / 4;
  const samplesToSlider = (v: number) => v === 0 ? 1 : v * 4;
  samplesSlider.value = String(sliderFromSamples(renderer.samplesPerPixel));
  samplesValue.textContent = String(renderer.samplesPerPixel);
  resolutionSelect.value = String(Renderer.RESOLUTION_SCALE);
  temporalCheckbox.checked = renderer.enableTemporalReprojection;
  denoiseCheckbox.checked = renderer.enableSpatialDenoise;

  // Samples per pixel: 1, 4, 8, 12, 16, ... 64
  samplesSlider.addEventListener('input', () => {
    const samples = samplesToSlider(parseInt(samplesSlider.value));
    renderer.samplesPerPixel = samples;
    samplesValue.textContent = String(samples);
  });

  // Max bounces
  bouncesSlider.addEventListener('input', () => {
    const bounces = parseInt(bouncesSlider.value);
    renderer.maxBounces = bounces;
    bouncesValue.textContent = String(bounces);
  });

  // Resolution scale (requires recreating renderer)
  resolutionSelect.addEventListener('change', async () => {
    Renderer.RESOLUTION_SCALE = parseFloat(resolutionSelect.value);
    renderer = new Renderer(device, context, format, canvas.width, canvas.height, cameraController.getCamera(), scene.triangles, scene.materials, textureAtlas);
    await renderer.initialize();
    // Restore settings
    renderer.samplesPerPixel = samplesToSlider(parseInt(samplesSlider.value));
    renderer.maxBounces = parseInt(bouncesSlider.value);
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
  const fpsValueElement = document.getElementById('fps-value') as HTMLSpanElement;
  const raysValueElement = document.getElementById('rays-value') as HTMLSpanElement;
  const samplesDisplayElement = document.getElementById('samples-display') as HTMLSpanElement;
  const resDisplayElement = document.getElementById('res-display') as HTMLSpanElement;
  let frameCount = 0;
  let fpsAccumulator = 0;
  let lastFpsUpdate = performance.now();

  // Helper to format large numbers
  function formatNumber(n: number): string {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return n.toFixed(0);
  }

  function frame(currentTime: number) {
    const deltaTime = (currentTime - lastTime) / 1000;
    lastTime = currentTime;

    cameraController.update(deltaTime);
    renderer.updateCamera(cameraController.getCamera());
    renderer.render();

    // Performance metrics tracking
    frameCount++;
    fpsAccumulator += deltaTime;
    if (currentTime - lastFpsUpdate >= 500) {
      const fps = frameCount / fpsAccumulator;

      // Calculate rays per second
      // Render resolution
      const renderWidth = Math.floor(canvas.width * Renderer.RESOLUTION_SCALE);
      const renderHeight = Math.floor(canvas.height * Renderer.RESOLUTION_SCALE);
      const pixels = renderWidth * renderHeight;
      const samples = renderer.samplesPerPixel;
      const raysPerSecond = pixels * samples * fps;

      // Update display
      fpsValueElement.textContent = fps.toFixed(1);
      raysValueElement.textContent = formatNumber(raysPerSecond);
      samplesDisplayElement.textContent = `${samples}/px`;
      resDisplayElement.textContent = `${renderWidth}x${renderHeight}`;

      frameCount = 0;
      fpsAccumulator = 0;
      lastFpsUpdate = currentTime;
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

main().catch(console.error);
