import { Renderer, Camera } from './renderer';
import { createCornellBox, SceneData } from './scene/geometry';
import { CameraController } from './camera';
import { WadParser } from './doom/wad-parser';
import { convertLevelToScene, setTextureAtlas } from './doom/level-converter';
import { CollisionDetector } from './doom/collision';
import { TextureExtractor, TextureAtlas } from './doom/textures';
import { createDungeonScene } from './scene/dungeon';
import { DungeonCameraController } from './scene/dungeon-camera';

type ActiveScene = 'doom' | 'dungeon';

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

  // --- Scene 1: Doom (or Cornell box fallback) ---
  let doomScene: SceneData;
  let doomCameraController: CameraController;
  let doomTextureAtlas: TextureAtlas | null = null;

  try {
    const response = await fetch('/wads/DOOM1.WAD');
    if (!response.ok) throw new Error('WAD not found');
    const wadBuffer = await response.arrayBuffer();
    const wad = new WadParser(wadBuffer);

    console.log('Available levels:', wad.getLevelNames());

    const textureExtractor = new TextureExtractor(wad);
    textureExtractor.extractAll();
    doomTextureAtlas = textureExtractor.buildAtlas();

    setTextureAtlas(doomTextureAtlas);

    const levelData = wad.parseLevel('E1M2');
    doomScene = convertLevelToScene(levelData);

    const playerStart = levelData.things.find(t => t.type === 1);
    const startX = playerStart ? playerStart.x / 64 : 0;
    const startZ = playerStart ? playerStart.y / 64 : 0;
    const startAngle = playerStart ? (playerStart.angle * Math.PI / 180) : 0;

    const collision = new CollisionDetector(levelData);
    const floorY = collision.getFloorHeight(startX, startZ);
    const eyeHeight = 0.875;

    doomCameraController = new CameraController(
      { x: startX, y: floorY + eyeHeight, z: startZ },
      startAngle - Math.PI / 2,
      0,
      90,
      5,
      0.002
    );

    doomCameraController.setCollision(collision);

    console.log(`Loaded Doom: ${doomScene.triangles.length} triangles, ${doomScene.materials.length} materials`);
  } catch (e) {
    console.warn('Failed to load WAD, using Cornell box:', e);

    doomScene = createCornellBox();
    doomCameraController = new CameraController(
      { x: 0, y: 0, z: -4.5 },
      0,
      0,
      60,
      3,
      0.002
    );

    console.log(`Scene: ${doomScene.triangles.length} triangles, ${doomScene.materials.length} materials`);
  }

  // --- Scene 2: Dungeon Crawler ---
  const dungeonScene = createDungeonScene();
  const dungeonCameraController = new DungeonCameraController();

  // --- Scene switching ---
  let activeScene: ActiveScene = 'doom';
  let currentCamera: { update(dt: number): void; getCamera(): Camera; attach(c: HTMLCanvasElement): void } = doomCameraController;

  function getActiveSceneData(): { scene: SceneData; atlas: TextureAtlas | null } {
    if (activeScene === 'dungeon') {
      return { scene: dungeonScene, atlas: null };
    }
    return { scene: doomScene, atlas: doomTextureAtlas };
  }

  // Attach both controllers for input, but only the active one will be updated
  doomCameraController.attach(canvas);
  dungeonCameraController.attach(canvas);

  let { scene, atlas } = getActiveSceneData();
  let renderer = new Renderer(device, context, format, canvas.width, canvas.height, currentCamera.getCamera(), scene.triangles, scene.materials, atlas);
  await renderer.initialize();

  // UI Controls
  const samplesSlider = document.getElementById('samples') as HTMLInputElement;
  const samplesValue = document.getElementById('samples-value') as HTMLSpanElement;
  const bouncesSlider = document.getElementById('bounces') as HTMLInputElement;
  const bouncesValue = document.getElementById('bounces-value') as HTMLSpanElement;
  const resolutionSelect = document.getElementById('resolution') as HTMLSelectElement;
  const temporalSlider = document.getElementById('temporal') as HTMLInputElement;
  const temporalValue = document.getElementById('temporal-value') as HTMLSpanElement;
  const denoiseCheckbox = document.getElementById('denoise') as HTMLInputElement;
  const playerLightSlider = document.getElementById('player-light') as HTMLInputElement;
  const playerLightValue = document.getElementById('player-light-value') as HTMLSpanElement;
  const playerLightLabel = document.getElementById('player-light-label') as HTMLLabelElement;
  const playerFalloffSlider = document.getElementById('player-falloff') as HTMLInputElement;
  const playerFalloffValue = document.getElementById('player-falloff-value') as HTMLSpanElement;
  const playerFalloffLabel = document.getElementById('player-falloff-label') as HTMLLabelElement;

  // Set initial values from renderer
  // Samples slider: 0 = 1 sample, 1-16 = 4, 8, 12, ... 64 (increments of 4)
  const sliderFromSamples = (s: number) => s === 1 ? 0 : s / 4;
  const samplesToSlider = (v: number) => v === 0 ? 1 : v * 4;
  samplesSlider.value = String(sliderFromSamples(renderer.samplesPerPixel));
  samplesValue.textContent = String(renderer.samplesPerPixel);
  resolutionSelect.value = String(Renderer.RESOLUTION_SCALE);
  temporalSlider.value = String(renderer.temporalFrames);
  temporalValue.textContent = String(renderer.temporalFrames);
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

  // Helper to recreate the renderer with current scene
  async function recreateRenderer() {
    const data = getActiveSceneData();
    scene = data.scene;
    atlas = data.atlas;
    renderer = new Renderer(device, context, format, canvas.width, canvas.height, currentCamera.getCamera(), scene.triangles, scene.materials, atlas);
    await renderer.initialize();
    renderer.samplesPerPixel = samplesToSlider(parseInt(samplesSlider.value));
    renderer.maxBounces = parseInt(bouncesSlider.value);
    renderer.temporalFrames = parseInt(temporalSlider.value);
    renderer.enableSpatialDenoise = denoiseCheckbox.checked;
    const showDungeon = activeScene === 'dungeon' ? '' : 'none';
    playerLightLabel.style.display = showDungeon;
    playerFalloffLabel.style.display = showDungeon;
    applyPlayerLight();
  }

  // Scene switching: 1 = Doom, 2 = Dungeon
  window.addEventListener('keydown', async (e) => {
    if (e.code === 'Digit1' && activeScene !== 'doom') {
      activeScene = 'doom';
      currentCamera = doomCameraController;
      dungeonCameraController.active = false;
      await recreateRenderer();
      console.log('Switched to Doom scene');
    } else if (e.code === 'Digit2' && activeScene !== 'dungeon') {
      activeScene = 'dungeon';
      currentCamera = dungeonCameraController;
      dungeonCameraController.active = true;
      await recreateRenderer();
      console.log('Switched to Dungeon scene');
    }
  });

  // Resolution scale (requires recreating renderer)
  resolutionSelect.addEventListener('change', async () => {
    Renderer.RESOLUTION_SCALE = parseFloat(resolutionSelect.value);
    await recreateRenderer();
  });

  // Temporal reprojection
  temporalSlider.addEventListener('input', () => {
    const frames = parseInt(temporalSlider.value);
    renderer.temporalFrames = frames;
    temporalValue.textContent = String(frames);
  });

  // Spatial denoise
  denoiseCheckbox.addEventListener('change', () => {
    renderer.enableSpatialDenoise = denoiseCheckbox.checked;
  });

  // Player torch light intensity and falloff
  function applyPlayerLight() {
    const intensity = parseFloat(playerLightSlider.value) / 10.0;
    const falloff = parseFloat(playerFalloffSlider.value) / 10.0;
    playerLightValue.textContent = playerLightSlider.value;
    playerFalloffValue.textContent = playerFalloffSlider.value;
    if (activeScene === 'dungeon' && intensity > 0) {
      renderer.playerLightColor = { x: 3.5 * intensity, y: 2.4 * intensity, z: 1.0 * intensity };
      renderer.playerLightRadius = 6.0;
      renderer.playerLightFalloff = falloff;
    } else {
      renderer.playerLightColor = { x: 0, y: 0, z: 0 };
      renderer.playerLightRadius = 0;
    }
  }
  playerLightSlider.addEventListener('input', applyPlayerLight);
  playerFalloffSlider.addEventListener('input', applyPlayerLight);

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

    currentCamera.update(deltaTime);
    renderer.updateCamera(currentCamera.getCamera());
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
