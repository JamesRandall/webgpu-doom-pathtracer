import raytraceShaderCode from './shaders/raytrace.wgsl?raw';
import denoiseShaderCode from './shaders/denoise.wgsl?raw';
import temporalShaderCode from './shaders/temporal.wgsl?raw';
import { Triangle, Material, packTriangles, packMaterials, packTriangleVerts, packTriangleAttribs } from './scene/geometry';
import { BVHBuilder, flattenBVH, packBVHNodes } from './bvh/builder';
import { TextureAtlas, AtlasEntry } from './doom/textures';

export interface Camera {
  position: { x: number; y: number; z: number };
  direction: { x: number; y: number; z: number };
  up: { x: number; y: number; z: number };
  fov: number;
}

export class Renderer {
  private device: GPUDevice;
  private context: GPUCanvasContext;
  private format: GPUTextureFormat;
  private canvasWidth: number;
  private canvasHeight: number;
  private renderWidth: number;
  private renderHeight: number;
  private camera: Camera;
  private triangles: Triangle[];
  private materials: Material[];
  private textureAtlas: TextureAtlas | null;
  private walkablePositions: { x: number; z: number }[] | undefined;

  // Resolution scale (0.5 = half res, 1.0 = full res, 2.0 = supersampling)
  public static RESOLUTION_SCALE = 1.0;
  private static readonly MAX_DENOISE_PASSES = 5;
  private frameCount: number = 0;
  private nodeCount: number = 0;
  private triangleCount: number = 0;

  private computePipeline!: GPUComputePipeline;
  private temporalPipeline!: GPUComputePipeline;
  private denoisePipeline!: GPUComputePipeline;
  private renderPipeline!: GPURenderPipeline;
  private outputTexture!: GPUTexture;
  private temporalOutputTexture!: GPUTexture;
  private denoisedTexture!: GPUTexture;
  private normalTexture!: GPUTexture;
  private depthTexture!: GPUTexture;
  private historyColorTexture!: GPUTexture;
  private historyDepthTexture!: GPUTexture;
  private computeBindGroup!: GPUBindGroup;
  private temporalBindGroup!: GPUBindGroup;
  private denoiseBindGroups!: GPUBindGroup[];
  private renderBindGroup!: GPUBindGroup;
  private cameraBuffer!: GPUBuffer;
  private triangleBuffer!: GPUBuffer;
  private triAttribsBuffer!: GPUBuffer;
  private lightsBuffer!: GPUBuffer;
  private materialBuffer!: GPUBuffer;
  private bvhBuffer!: GPUBuffer;
  private sceneInfoBuffer!: GPUBuffer;
  private temporalParamsBuffer!: GPUBuffer;
  private cameraMatricesBuffer!: GPUBuffer;
  private sampler!: GPUSampler;
  private denoiseParamsBuffers: GPUBuffer[] = [];
  private pingPongTexture!: GPUTexture;
  private atlasTexture!: GPUTexture;
  private atlasEntriesBuffer!: GPUBuffer;
  private atlasSampler!: GPUSampler;
  private atlasWidth: number = 1;
  private atlasHeight: number = 1;

  // Previous frame camera for temporal reprojection
  private prevCamera: Camera | null = null;
  private staticFrameCount: number = 0;

  // Denoise settings
  public denoisePasses = 1; // 0 = off, 1-5 = number of passes
  public denoiseMode: 'atrous' | 'median' | 'adaptive' = 'atrous'; // algorithm

  // Post-processing options (public for UI control)
  public temporalFrames = 1;  // 0 = off, 1+ = enabled

  public samplesPerPixel = 4;
  public maxBounces = 3;

  // Player light (emissive sphere at camera position)
  public playerLightColor = { x: 0, y: 0, z: 0 };
  public playerLightRadius = 0;
  public playerLightFalloff = 0.5;

  // Distance culling (world units) for precomputed BVH
  public renderDistance = 10;
  private allTriangles: Triangle[] = [];

  // Precomputed BVH per tile position
  private precomputedBVHs: Map<string, { bvhData: ArrayBuffer; triVertsData: Float32Array; triAttribsData: Float32Array; lightData: Float32Array; nodeCount: number; triCount: number; lightCount: number }> = new Map();
  private currentTileKey: string = '';

  // Dynamic (non-BVH) triangles — e.g. monsters, items
  private dynamicTriangles: Triangle[] = [];
  private dynamicTriOffset: number = 0;
  private dynamicAABBMin = { x: 0, y: 0, z: 0 };
  private dynamicAABBMax = { x: 0, y: 0, z: 0 };
  private lightCount: number = 0;

  constructor(
    device: GPUDevice,
    context: GPUCanvasContext,
    format: GPUTextureFormat,
    width: number,
    height: number,
    camera: Camera,
    triangles: Triangle[],
    materials: Material[],
    textureAtlas: TextureAtlas | null = null,
    walkablePositions?: { x: number; z: number }[]
  ) {
    this.device = device;
    this.context = context;
    this.format = format;
    this.canvasWidth = width;
    this.canvasHeight = height;
    this.renderWidth = Math.floor(width * Renderer.RESOLUTION_SCALE);
    this.renderHeight = Math.floor(height * Renderer.RESOLUTION_SCALE);
    this.camera = camera;
    this.triangles = triangles;
    this.materials = materials;
    this.textureAtlas = textureAtlas;
    this.walkablePositions = walkablePositions;
    console.log(`Render resolution: ${this.renderWidth}x${this.renderHeight} (${Renderer.RESOLUTION_SCALE}x scale)`);
  }

  async initialize(): Promise<void> {
    let orderedTriangles: Triangle[];
    let bvhData: ArrayBuffer;
    this.allTriangles = this.triangles;

    if (this.walkablePositions && this.walkablePositions.length > 0) {
      // Precompute a BVH per walkable tile
      this.precomputeBVHsForPositions();

      // Use the first position's data to initialize buffers
      const firstKey = `${this.walkablePositions[0].x},${this.walkablePositions[0].z}`;
      const first = this.precomputedBVHs.get(firstKey)!;
      bvhData = first.bvhData;
      orderedTriangles = this.triangles; // buffer sized for all; actual data swapped per tile
      this.nodeCount = first.nodeCount;
      this.triangleCount = first.triCount;
      this.currentTileKey = firstKey;
    } else {
      // Global BVH for all triangles
      const bvhBuilder = new BVHBuilder();
      const result = bvhBuilder.build(this.triangles);
      orderedTriangles = result.orderedTriangles;
      const flatNodes = flattenBVH(result.nodes);
      bvhData = packBVHNodes(flatNodes);
      this.nodeCount = result.nodes.length;
      console.log(`BVH built: ${result.nodes.length} nodes for ${orderedTriangles.length} triangles`);
    }

    if (!this.walkablePositions || this.walkablePositions.length === 0) {
      this.triangleCount = orderedTriangles.length;
    }

    // Create output storage texture (raw path trace output)
    this.outputTexture = this.device.createTexture({
      size: { width: this.renderWidth, height: this.renderHeight },
      format: 'rgba16float',
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    // Create temporal output texture (after temporal reprojection)
    this.temporalOutputTexture = this.device.createTexture({
      size: { width: this.renderWidth, height: this.renderHeight },
      format: 'rgba16float',
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST,
    });

    // History colour buffer for temporal reprojection
    this.historyColorTexture = this.device.createTexture({
      size: { width: this.renderWidth, height: this.renderHeight },
      format: 'rgba16float',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST,
    });

    // History depth buffer for temporal reprojection
    this.historyDepthTexture = this.device.createTexture({
      size: { width: this.renderWidth, height: this.renderHeight },
      format: 'r32float',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST,
    });

    // Create denoised texture (output of denoise pass)
    this.denoisedTexture = this.device.createTexture({
      size: { width: this.renderWidth, height: this.renderHeight },
      format: 'rgba16float',
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST,
    });

    // G-buffer: normals
    this.normalTexture = this.device.createTexture({
      size: { width: this.renderWidth, height: this.renderHeight },
      format: 'rgba16float',
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING,
    });

    // G-buffer: depth
    this.depthTexture = this.device.createTexture({
      size: { width: this.renderWidth, height: this.renderHeight },
      format: 'r32float',
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    // Ping-pong texture for denoise passes
    this.pingPongTexture = this.device.createTexture({
      size: { width: this.renderWidth, height: this.renderHeight },
      format: 'rgba16float',
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    // Create camera uniform buffer
    this.cameraBuffer = this.device.createBuffer({
      size: 96,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.updateCameraBuffer();

    // Compute max buffer sizes across all precomputed BVHs (or use current data)
    // Add extra space for dynamic triangles (monsters, items, etc.)
    const dynamicTriReserve = 512; // max dynamic triangles
    const bytesPerVert = 12 * 4; // 12 floats per TriangleVerts
    const bytesPerAttrib = 12 * 4; // 12 floats per TriangleAttribs
    let maxVertBytes = packTriangleVerts(orderedTriangles).byteLength + dynamicTriReserve * bytesPerVert;
    let maxAttribBytes = packTriangleAttribs(orderedTriangles).byteLength + dynamicTriReserve * bytesPerAttrib;
    let maxBvhBytes = bvhData.byteLength;
    if (this.precomputedBVHs.size > 0) {
      for (const entry of this.precomputedBVHs.values()) {
        maxVertBytes = Math.max(maxVertBytes, entry.triVertsData.byteLength + dynamicTriReserve * bytesPerVert);
        maxAttribBytes = Math.max(maxAttribBytes, entry.triAttribsData.byteLength + dynamicTriReserve * bytesPerAttrib);
        maxBvhBytes = Math.max(maxBvhBytes, entry.bvhData.byteLength);
      }
    }

    // Create triangle verts storage buffer (hot data — traversal)
    this.triangleBuffer = this.device.createBuffer({
      size: Math.max(maxVertBytes, 32),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    // Create triangle attribs storage buffer (cold data — closest hit only)
    this.triAttribsBuffer = this.device.createBuffer({
      size: Math.max(maxAttribBytes, 32),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    // Upload initial data and build light lists
    let maxLightBytes = 8;
    if (this.precomputedBVHs.size > 0) {
      const first = this.precomputedBVHs.get(this.currentTileKey)!;
      this.device.queue.writeBuffer(this.triangleBuffer, 0, first.triVertsData.buffer);
      this.device.queue.writeBuffer(this.triAttribsBuffer, 0, first.triAttribsData.buffer);
      this.triangleCount = first.triCount;
      this.dynamicTriOffset = first.triCount;
      this.lightCount = first.lightCount;
      for (const entry of this.precomputedBVHs.values()) {
        maxLightBytes = Math.max(maxLightBytes, entry.lightData.byteLength);
      }
    } else {
      const vertsData = packTriangleVerts(orderedTriangles);
      const attribsData = packTriangleAttribs(orderedTriangles);
      this.device.queue.writeBuffer(this.triangleBuffer, 0, vertsData.buffer);
      this.device.queue.writeBuffer(this.triAttribsBuffer, 0, attribsData.buffer);
      this.triangleCount = orderedTriangles.length;
      this.dynamicTriOffset = orderedTriangles.length;
    }

    // Create lights storage buffer (MIS — emissive triangle list)
    const initialLightData = this.precomputedBVHs.size > 0
      ? this.precomputedBVHs.get(this.currentTileKey)!.lightData
      : this.buildLightList(orderedTriangles);
    if (this.precomputedBVHs.size === 0) {
      this.lightCount = initialLightData.length / 2;
      maxLightBytes = Math.max(initialLightData.byteLength, 8);
    }
    this.lightsBuffer = this.device.createBuffer({
      size: Math.max(maxLightBytes, 8),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.lightsBuffer, 0, initialLightData.buffer);
    console.log(`Lights: ${this.lightCount} emissive triangles`);

    // Create material storage buffer
    const materialData = packMaterials(this.materials);
    this.materialBuffer = this.device.createBuffer({
      size: Math.max(materialData.byteLength, 32),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.materialBuffer, 0, materialData.buffer);
    console.log(`Materials: ${this.materials.length}`);

    // Create BVH storage buffer — sized for largest precomputed set
    this.bvhBuffer = this.device.createBuffer({
      size: Math.max(maxBvhBytes, 32),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.bvhBuffer, 0, bvhData);

    // Create scene info buffer
    this.sceneInfoBuffer = this.device.createBuffer({
      size: 96,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create texture atlas resources
    if (this.textureAtlas && this.textureAtlas.width > 0) {
      this.atlasWidth = this.textureAtlas.width;
      this.atlasHeight = this.textureAtlas.height;

      // Create atlas texture
      this.atlasTexture = this.device.createTexture({
        size: { width: this.atlasWidth, height: this.atlasHeight },
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });

      // Upload atlas image data
      this.device.queue.writeTexture(
        { texture: this.atlasTexture },
        this.textureAtlas.image.buffer,
        { bytesPerRow: this.atlasWidth * 4 },
        { width: this.atlasWidth, height: this.atlasHeight }
      );

      // Create atlas entries buffer
      const entriesArray = Array.from(this.textureAtlas.entries.values());
      const entriesData = new Float32Array(entriesArray.length * 4);
      for (let i = 0; i < entriesArray.length; i++) {
        const entry = entriesArray[i];
        entriesData[i * 4 + 0] = entry.x;
        entriesData[i * 4 + 1] = entry.y;
        entriesData[i * 4 + 2] = entry.width;
        entriesData[i * 4 + 3] = entry.height;
      }

      this.atlasEntriesBuffer = this.device.createBuffer({
        size: Math.max(entriesData.byteLength, 16),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(this.atlasEntriesBuffer, 0, entriesData);

      console.log(`Atlas: ${this.atlasWidth}x${this.atlasHeight}, ${entriesArray.length} entries`);
    } else {
      // Create dummy 1x1 texture and empty buffer for when no atlas
      this.atlasTexture = this.device.createTexture({
        size: { width: 1, height: 1 },
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this.device.queue.writeTexture(
        { texture: this.atlasTexture },
        new Uint8Array([255, 255, 255, 255]),
        { bytesPerRow: 4 },
        { width: 1, height: 1 }
      );

      this.atlasEntriesBuffer = this.device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
    }

    // Create atlas sampler with nearest filtering for pixel art look
    this.atlasSampler = this.device.createSampler({
      magFilter: 'nearest',
      minFilter: 'nearest',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
    });

    this.updateSceneInfoBuffer();

    // Create compute shader module
    const computeShaderModule = this.device.createShaderModule({
      code: raytraceShaderCode,
    });

    // Create compute pipeline
    const computeBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: {
            access: 'write-only',
            format: 'rgba16float',
            viewDimension: '2d',
          },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'read-only-storage' },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'read-only-storage' },
        },
        {
          binding: 4,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'read-only-storage' },
        },
        {
          binding: 5,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform' },
        },
        {
          binding: 6,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: {
            access: 'write-only',
            format: 'rgba16float',
            viewDimension: '2d',
          },
        },
        {
          binding: 7,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: {
            access: 'write-only',
            format: 'r32float',
            viewDimension: '2d',
          },
        },
        {
          binding: 8,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
        {
          binding: 9,
          visibility: GPUShaderStage.COMPUTE,
          sampler: { type: 'filtering' },
        },
        {
          binding: 10,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'read-only-storage' },
        },
        {
          binding: 11,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'read-only-storage' },
        },
        {
          binding: 12,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'read-only-storage' },
        },
      ],
    });

    this.computePipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [computeBindGroupLayout],
      }),
      compute: {
        module: computeShaderModule,
        entryPoint: 'main',
      },
    });

    // Create compute bind group
    this.computeBindGroup = this.device.createBindGroup({
      layout: computeBindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: this.outputTexture.createView(),
        },
        {
          binding: 1,
          resource: { buffer: this.cameraBuffer },
        },
        {
          binding: 2,
          resource: { buffer: this.triangleBuffer },
        },
        {
          binding: 3,
          resource: { buffer: this.materialBuffer },
        },
        {
          binding: 4,
          resource: { buffer: this.bvhBuffer },
        },
        {
          binding: 5,
          resource: { buffer: this.sceneInfoBuffer },
        },
        {
          binding: 6,
          resource: this.normalTexture.createView(),
        },
        {
          binding: 7,
          resource: this.depthTexture.createView(),
        },
        {
          binding: 8,
          resource: this.atlasTexture.createView(),
        },
        {
          binding: 9,
          resource: this.atlasSampler,
        },
        {
          binding: 10,
          resource: { buffer: this.atlasEntriesBuffer },
        },
        {
          binding: 11,
          resource: { buffer: this.triAttribsBuffer },
        },
        {
          binding: 12,
          resource: { buffer: this.lightsBuffer },
        },
      ],
    });

    // Create temporal reprojection params buffer
    this.temporalParamsBuffer = this.device.createBuffer({
      size: 32, // screen_width, screen_height, blend_factor, depth_threshold, static_frame_count, padding...
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create camera matrices buffer (inv_view_proj + prev_view_proj = 2 * 64 bytes)
    this.cameraMatricesBuffer = this.device.createBuffer({
      size: 128,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create temporal reprojection pipeline
    const temporalShaderModule = this.device.createShaderModule({
      code: temporalShaderCode,
    });

    const temporalBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float', viewDimension: '2d' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float', viewDimension: '2d' } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d' } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });

    this.temporalPipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [temporalBindGroupLayout] }),
      compute: { module: temporalShaderModule, entryPoint: 'main' },
    });

    this.temporalBindGroup = this.device.createBindGroup({
      layout: temporalBindGroupLayout,
      entries: [
        { binding: 0, resource: this.outputTexture.createView() },
        { binding: 1, resource: this.depthTexture.createView() },
        { binding: 2, resource: this.normalTexture.createView() },
        { binding: 3, resource: this.historyColorTexture.createView() },
        { binding: 4, resource: this.historyDepthTexture.createView() },
        { binding: 5, resource: this.temporalOutputTexture.createView() },
        { binding: 6, resource: { buffer: this.temporalParamsBuffer } },
        { binding: 7, resource: { buffer: this.cameraMatricesBuffer } },
      ],
    });

    // Create denoise shader module
    const denoiseShaderModule = this.device.createShaderModule({
      code: denoiseShaderCode,
    });

    // Create denoise pipeline
    const denoiseBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: {
            access: 'write-only',
            format: 'rgba16float',
            viewDimension: '2d',
          },
        },
        {
          binding: 4,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform' },
        },
      ],
    });

    this.denoisePipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [denoiseBindGroupLayout],
      }),
      compute: {
        module: denoiseShaderModule,
        entryPoint: 'main',
      },
    });

    // Create per-pass denoise params buffers with pre-baked step sizes
    this.denoiseParamsBuffers = [];
    this.denoiseBindGroups = [];

    for (let i = 0; i < Renderer.MAX_DENOISE_PASSES; i++) {
      const buffer = this.device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });

      const stepSize = 1 << i;
      const paramsData = new ArrayBuffer(16);
      const paramsUint = new Uint32Array(paramsData);
      const paramsFloat = new Float32Array(paramsData);
      paramsUint[0] = stepSize;
      paramsFloat[1] = 4.0;
      paramsFloat[2] = 128.0;
      paramsUint[3] = 0;
      this.device.queue.writeBuffer(buffer, 0, paramsData);

      this.denoiseParamsBuffers.push(buffer);
    }

    // Create per-pass bind groups with correct ping-pong textures
    for (let i = 0; i < Renderer.MAX_DENOISE_PASSES; i++) {
      let inputTexture: GPUTexture;
      let outputTexture: GPUTexture;

      if (i === 0) {
        inputTexture = this.temporalOutputTexture;
        outputTexture = this.pingPongTexture;
      } else if (i % 2 === 1) {
        inputTexture = this.pingPongTexture;
        outputTexture = this.denoisedTexture;
      } else {
        inputTexture = this.denoisedTexture;
        outputTexture = this.pingPongTexture;
      }

      this.denoiseBindGroups.push(this.device.createBindGroup({
        layout: denoiseBindGroupLayout,
        entries: [
          { binding: 0, resource: inputTexture.createView() },
          { binding: 1, resource: this.normalTexture.createView() },
          { binding: 2, resource: this.depthTexture.createView() },
          { binding: 3, resource: outputTexture.createView() },
          { binding: 4, resource: { buffer: this.denoiseParamsBuffers[i] } },
        ],
      }));
    }

    // Create sampler for blit
    this.sampler = this.device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });

    // Create render pipeline for blitting to screen
    const blitShaderModule = this.device.createShaderModule({
      code: `
        @group(0) @binding(0) var outputTex: texture_2d<f32>;
        @group(0) @binding(1) var outputSampler: sampler;

        struct VertexOutput {
          @builtin(position) position: vec4f,
          @location(0) uv: vec2f,
        }

        @vertex
        fn vs(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
          var positions = array<vec2f, 3>(
            vec2f(-1.0, -1.0),
            vec2f(3.0, -1.0),
            vec2f(-1.0, 3.0)
          );
          var uvs = array<vec2f, 3>(
            vec2f(0.0, 1.0),
            vec2f(2.0, 1.0),
            vec2f(0.0, -1.0)
          );

          var output: VertexOutput;
          output.position = vec4f(positions[vertexIndex], 0.0, 1.0);
          output.uv = uvs[vertexIndex];
          return output;
        }

        @fragment
        fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
          var color = textureSample(outputTex, outputSampler, uv).rgb;
          // Exposure adjustment
          color *= 1.5;
          // Simple tone mapping (Reinhard) and gamma correction
          let mapped = color / (color + vec3f(1.0));
          let gamma_corrected = pow(mapped, vec3f(1.0 / 2.2));
          return vec4f(gamma_corrected, 1.0);
        }
      `,
    });

    const renderBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'filtering' },
        },
      ],
    });

    this.renderPipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [renderBindGroupLayout],
      }),
      vertex: {
        module: blitShaderModule,
        entryPoint: 'vs',
      },
      fragment: {
        module: blitShaderModule,
        entryPoint: 'fs',
        targets: [{ format: this.format }],
      },
      primitive: {
        topology: 'triangle-list',
      },
    });

    this.renderBindGroup = this.device.createBindGroup({
      layout: renderBindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: this.denoisedTexture.createView(),
        },
        {
          binding: 1,
          resource: this.sampler,
        },
      ],
    });
  }

  private updateCameraBuffer(): void {
    const data = new Float32Array([
      this.camera.position.x,
      this.camera.position.y,
      this.camera.position.z,
      0,
      this.camera.direction.x,
      this.camera.direction.y,
      this.camera.direction.z,
      0,
      this.camera.up.x,
      this.camera.up.y,
      this.camera.up.z,
      0,
      this.renderWidth,
      this.renderHeight,
      this.camera.fov * (Math.PI / 180),
      0,
    ]);
    this.device.queue.writeBuffer(this.cameraBuffer, 0, data);
  }

  private precomputeBVHsForPositions(): void {
    const positions = this.walkablePositions!;
    const dist = this.renderDistance;
    const distSq = dist * dist;
    let maxTris = 0;
    let maxNodes = 0;

    const startTime = performance.now();

    for (const pos of positions) {
      // Cull triangles by distance from this tile center (XZ plane)
      const culled: Triangle[] = [];
      for (const tri of this.allTriangles) {
        const d0 = (tri.v0.x - pos.x) ** 2 + (tri.v0.z - pos.z) ** 2;
        const d1 = (tri.v1.x - pos.x) ** 2 + (tri.v1.z - pos.z) ** 2;
        const d2 = (tri.v2.x - pos.x) ** 2 + (tri.v2.z - pos.z) ** 2;
        if (Math.min(d0, d1, d2) <= distSq) {
          culled.push(tri);
        }
      }

      // Build BVH for this subset
      const builder = new BVHBuilder();
      const { nodes, orderedTriangles } = builder.build(culled);
      const flat = flattenBVH(nodes);
      const bvhData = packBVHNodes(flat);
      const triVertsData = packTriangleVerts(orderedTriangles);
      const triAttribsData = packTriangleAttribs(orderedTriangles);
      const lightData = this.buildLightList(orderedTriangles);

      const key = `${pos.x},${pos.z}`;
      this.precomputedBVHs.set(key, {
        bvhData,
        triVertsData,
        triAttribsData,
        lightData,
        nodeCount: nodes.length,
        triCount: orderedTriangles.length,
        lightCount: lightData.length / 2,
      });

      maxTris = Math.max(maxTris, orderedTriangles.length);
      maxNodes = Math.max(maxNodes, nodes.length);
    }

    const elapsed = (performance.now() - startTime).toFixed(0);
    console.log(`Precomputed ${positions.length} BVHs in ${elapsed}ms (max ${maxTris} tris, ${maxNodes} nodes per tile)`);
  }

  private swapBVHForTile(): void {
    if (this.precomputedBVHs.size === 0) return;

    // Find nearest walkable position to camera
    const cx = this.camera.position.x;
    const cz = this.camera.position.z;
    let bestKey = this.currentTileKey;
    let bestDist = Infinity;

    for (const pos of this.walkablePositions!) {
      const dx = pos.x - cx;
      const dz = pos.z - cz;
      const d = dx * dx + dz * dz;
      if (d < bestDist) {
        bestDist = d;
        bestKey = `${pos.x},${pos.z}`;
      }
    }

    if (bestKey === this.currentTileKey) return;

    const entry = this.precomputedBVHs.get(bestKey);
    if (!entry) return;

    // Upload this tile's BVH, triangles (verts + attribs), and light list
    this.device.queue.writeBuffer(this.bvhBuffer, 0, entry.bvhData);
    this.device.queue.writeBuffer(this.triangleBuffer, 0, entry.triVertsData.buffer);
    this.device.queue.writeBuffer(this.triAttribsBuffer, 0, entry.triAttribsData.buffer);
    this.device.queue.writeBuffer(this.lightsBuffer, 0, entry.lightData.buffer);
    this.nodeCount = entry.nodeCount;
    this.triangleCount = entry.triCount;
    this.dynamicTriOffset = entry.triCount;
    this.lightCount = entry.lightCount;
    this.currentTileKey = bestKey;

    // Re-upload dynamic triangles after static ones
    if (this.dynamicTriangles.length > 0) {
      this.setDynamicTriangles(this.dynamicTriangles);
    }
  }

  private buildLightList(orderedTriangles: Triangle[]): Float32Array {
    const entries: { triIndex: number; area: number }[] = [];
    for (let i = 0; i < orderedTriangles.length; i++) {
      const mat = this.materials[orderedTriangles[i].materialIndex];
      if (mat.emissive.x > 0 || mat.emissive.y > 0 || mat.emissive.z > 0) {
        const t = orderedTriangles[i];
        const e1x = t.v1.x - t.v0.x, e1y = t.v1.y - t.v0.y, e1z = t.v1.z - t.v0.z;
        const e2x = t.v2.x - t.v0.x, e2y = t.v2.y - t.v0.y, e2z = t.v2.z - t.v0.z;
        const cx = e1y * e2z - e1z * e2y, cy = e1z * e2x - e1x * e2z, cz = e1x * e2y - e1y * e2x;
        const area = 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
        if (area > 0) {
          entries.push({ triIndex: i, area });
        }
      }
    }
    // Pack as [triIndex(u32), area(f32)] pairs
    const buffer = new ArrayBuffer(Math.max(entries.length * 8, 8));
    const u32 = new Uint32Array(buffer);
    const f32 = new Float32Array(buffer);
    for (let i = 0; i < entries.length; i++) {
      u32[i * 2] = entries[i].triIndex;
      f32[i * 2 + 1] = entries[i].area;
    }
    return f32;
  }

  private updateSceneInfoBuffer(): void {
    const buffer = new ArrayBuffer(96);
    const u32View = new Uint32Array(buffer);
    const f32View = new Float32Array(buffer);

    u32View[0] = this.triangleCount;
    u32View[1] = this.nodeCount;
    u32View[2] = this.frameCount;
    u32View[3] = this.maxBounces;
    u32View[4] = this.samplesPerPixel;
    u32View[5] = this.atlasWidth;
    u32View[6] = this.atlasHeight;
    f32View[7] = this.playerLightFalloff;

    f32View[8] = this.playerLightColor.x;
    f32View[9] = this.playerLightColor.y;
    f32View[10] = this.playerLightColor.z;
    f32View[11] = this.playerLightRadius;

    u32View[12] = this.dynamicTriOffset;
    u32View[13] = this.dynamicTriangles.length;
    u32View[14] = this.lightCount;
    u32View[15] = 0;

    // Dynamic triangle AABB for early-out
    f32View[16] = this.dynamicAABBMin.x;
    f32View[17] = this.dynamicAABBMin.y;
    f32View[18] = this.dynamicAABBMin.z;
    f32View[19] = 0; // pad
    f32View[20] = this.dynamicAABBMax.x;
    f32View[21] = this.dynamicAABBMax.y;
    f32View[22] = this.dynamicAABBMax.z;
    f32View[23] = 0; // pad

    this.device.queue.writeBuffer(this.sceneInfoBuffer, 0, buffer);
  }

  // Build view matrix from camera
  private buildViewMatrix(cam: Camera): Float32Array {
    const forward = this.normalize3([cam.direction.x, cam.direction.y, cam.direction.z]);
    const right = this.normalize3(this.cross3(forward, [cam.up.x, cam.up.y, cam.up.z]));
    const up = this.cross3(right, forward);

    // View matrix (camera transform inverse)
    return new Float32Array([
      right[0], up[0], -forward[0], 0,
      right[1], up[1], -forward[1], 0,
      right[2], up[2], -forward[2], 0,
      -this.dot3(right, [cam.position.x, cam.position.y, cam.position.z]),
      -this.dot3(up, [cam.position.x, cam.position.y, cam.position.z]),
      this.dot3(forward, [cam.position.x, cam.position.y, cam.position.z]),
      1,
    ]);
  }

  // Build projection matrix
  private buildProjectionMatrix(fovRadians: number, aspect: number, near: number, far: number): Float32Array {
    const f = 1.0 / Math.tan(fovRadians / 2);
    const rangeInv = 1.0 / (near - far);

    return new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (near + far) * rangeInv, -1,
      0, 0, near * far * rangeInv * 2, 0,
    ]);
  }

  // Matrix multiplication (4x4)
  private multiplyMatrices(a: Float32Array, b: Float32Array): Float32Array {
    const result = new Float32Array(16);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        result[i * 4 + j] =
          a[i * 4 + 0] * b[0 * 4 + j] +
          a[i * 4 + 1] * b[1 * 4 + j] +
          a[i * 4 + 2] * b[2 * 4 + j] +
          a[i * 4 + 3] * b[3 * 4 + j];
      }
    }
    return result;
  }

  // Matrix inverse (4x4)
  private invertMatrix(m: Float32Array): Float32Array {
    const inv = new Float32Array(16);
    inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
    inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
    inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
    inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
    inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
    inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
    inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
    inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
    inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
    inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
    inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
    inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
    inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
    inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
    inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
    inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];

    const det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
    if (Math.abs(det) < 1e-10) {
      return new Float32Array(16); // Return identity-ish on failure
    }

    const detInv = 1.0 / det;
    for (let i = 0; i < 16; i++) {
      inv[i] *= detInv;
    }
    return inv;
  }

  // Vector helpers
  private normalize3(v: number[]): number[] {
    const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    return len > 0 ? [v[0] / len, v[1] / len, v[2] / len] : [0, 0, 0];
  }

  private cross3(a: number[], b: number[]): number[] {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
  }

  private dot3(a: number[], b: number[]): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  }

  // Build view-projection matrix for a camera
  private buildViewProjMatrix(cam: Camera): Float32Array {
    const view = this.buildViewMatrix(cam);
    const fovRad = cam.fov * (Math.PI / 180);
    const aspect = this.renderWidth / this.renderHeight;
    const proj = this.buildProjectionMatrix(fovRad, aspect, 0.1, 1000);
    return this.multiplyMatrices(proj, view);
  }

  setDynamicTriangles(triangles: Triangle[]): void {
    this.dynamicTriangles = triangles;
    if (triangles.length > 0) {
      const vertsData = packTriangleVerts(triangles);
      const attribsData = packTriangleAttribs(triangles);
      this.device.queue.writeBuffer(this.triangleBuffer, this.dynamicTriOffset * 12 * 4, vertsData.buffer);
      this.device.queue.writeBuffer(this.triAttribsBuffer, this.dynamicTriOffset * 12 * 4, attribsData.buffer);

      // Compute AABB for early-out in shader
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (const tri of triangles) {
        for (const v of [tri.v0, tri.v1, tri.v2]) {
          minX = Math.min(minX, v.x); minY = Math.min(minY, v.y); minZ = Math.min(minZ, v.z);
          maxX = Math.max(maxX, v.x); maxY = Math.max(maxY, v.y); maxZ = Math.max(maxZ, v.z);
        }
      }
      this.dynamicAABBMin = { x: minX, y: minY, z: minZ };
      this.dynamicAABBMax = { x: maxX, y: maxY, z: maxZ };
    } else {
      this.dynamicAABBMin = { x: 0, y: 0, z: 0 };
      this.dynamicAABBMax = { x: 0, y: 0, z: 0 };
    }
  }

  updateCamera(camera: Camera): void {
    // Check if camera moved
    if (this.prevCamera !== null) {
      const posChanged =
        Math.abs(camera.position.x - this.prevCamera.position.x) > 0.0001 ||
        Math.abs(camera.position.y - this.prevCamera.position.y) > 0.0001 ||
        Math.abs(camera.position.z - this.prevCamera.position.z) > 0.0001;
      const dirChanged =
        Math.abs(camera.direction.x - this.prevCamera.direction.x) > 0.0001 ||
        Math.abs(camera.direction.y - this.prevCamera.direction.y) > 0.0001 ||
        Math.abs(camera.direction.z - this.prevCamera.direction.z) > 0.0001;

      if (posChanged || dirChanged) {
        this.staticFrameCount = 0;
      } else {
        this.staticFrameCount++;
      }
    }

    // Store previous camera for temporal reprojection (before updating)
    this.prevCamera = {
      position: { ...this.camera.position },
      direction: { ...this.camera.direction },
      up: { ...this.camera.up },
      fov: this.camera.fov,
    };

    this.camera = camera;
    this.updateCameraBuffer();
  }

  render(): void {
    // Swap precomputed BVH when player changes tile
    if (this.precomputedBVHs.size > 0) {
      this.swapBVHForTile();
    }

    // Update frame counter for RNG
    this.updateSceneInfoBuffer();
    this.frameCount++;

    const temporalParamsData = new ArrayBuffer(32);
    const temporalParamsFloat = new Float32Array(temporalParamsData);
    const temporalParamsUint = new Uint32Array(temporalParamsData);
    temporalParamsFloat[0] = this.renderWidth;
    temporalParamsFloat[1] = this.renderHeight;
    temporalParamsFloat[2] = 0.05;  // moving_blend_factor (current frame contribution when moving)
    temporalParamsFloat[3] = 0.1;   // depth_threshold (relative)
    temporalParamsUint[4] = this.staticFrameCount;
    this.device.queue.writeBuffer(this.temporalParamsBuffer, 0, temporalParamsData);

    // Update camera matrices for temporal reprojection
    const currentViewProj = this.buildViewProjMatrix(this.camera);
    const currentInvViewProj = this.invertMatrix(currentViewProj);
    const prevViewProj = this.prevCamera
      ? this.buildViewProjMatrix(this.prevCamera)
      : currentViewProj;

    const matricesData = new Float32Array(32);
    matricesData.set(currentInvViewProj, 0);
    matricesData.set(prevViewProj, 16);
    this.device.queue.writeBuffer(this.cameraMatricesBuffer, 0, matricesData);

    const commandEncoder = this.device.createCommandEncoder();

    const workgroupSize = 8;
    const dispatchX = Math.ceil(this.renderWidth / workgroupSize);
    const dispatchY = Math.ceil(this.renderHeight / workgroupSize);

    // 1. Path tracing pass
    const computePass = commandEncoder.beginComputePass();
    computePass.setPipeline(this.computePipeline);
    computePass.setBindGroup(0, this.computeBindGroup);
    computePass.dispatchWorkgroups(dispatchX, dispatchY);
    computePass.end();

    // 2. Temporal reprojection pass (optional)
    if (this.temporalFrames > 0) {
      const temporalPass = commandEncoder.beginComputePass();
      temporalPass.setPipeline(this.temporalPipeline);
      temporalPass.setBindGroup(0, this.temporalBindGroup);
      temporalPass.dispatchWorkgroups(dispatchX, dispatchY);
      temporalPass.end();

      // Copy current frame to history for next frame
      commandEncoder.copyTextureToTexture(
        { texture: this.temporalOutputTexture },
        { texture: this.historyColorTexture },
        { width: this.renderWidth, height: this.renderHeight }
      );
      commandEncoder.copyTextureToTexture(
        { texture: this.depthTexture },
        { texture: this.historyDepthTexture },
        { width: this.renderWidth, height: this.renderHeight }
      );
    }

    // Determine input for denoise/display
    const postTemporalTexture = this.temporalFrames > 0
      ? this.temporalOutputTexture
      : this.outputTexture;

    // 3. Denoise passes (optional)
    const numDenoisePasses = this.denoisePasses;

    if (numDenoisePasses > 0) {
      // Update mode and sigma_color on all active params buffers
      const modeMap = { atrous: 0, median: 1, adaptive: 2 } as const;
      const mode = modeMap[this.denoiseMode];
      const sigmaColor = this.denoiseMode === 'atrous' ? 1.0 : 1.5;

      for (let i = 0; i < numDenoisePasses; i++) {
        const paramsData = new ArrayBuffer(16);
        const paramsUint = new Uint32Array(paramsData);
        const paramsFloat = new Float32Array(paramsData);
        paramsUint[0] = 1 << i;
        paramsFloat[1] = sigmaColor;
        paramsFloat[2] = 128.0;
        paramsUint[3] = mode;
        this.device.queue.writeBuffer(this.denoiseParamsBuffers[i], 0, paramsData);
      }

      // If temporal is disabled, copy raw output to temporalOutputTexture
      // so bind group 0 reads the correct input
      if (!(this.temporalFrames > 0)) {
        commandEncoder.copyTextureToTexture(
          { texture: this.outputTexture },
          { texture: this.temporalOutputTexture },
          { width: this.renderWidth, height: this.renderHeight }
        );
      }

      for (let i = 0; i < numDenoisePasses; i++) {
        const denoisePass = commandEncoder.beginComputePass();
        denoisePass.setPipeline(this.denoisePipeline);
        denoisePass.setBindGroup(0, this.denoiseBindGroups[i]);
        denoisePass.dispatchWorkgroups(dispatchX, dispatchY);
        denoisePass.end();
      }

      // If odd number of passes, final output is in pingPongTexture — copy to denoised
      if (numDenoisePasses % 2 === 1) {
        commandEncoder.copyTextureToTexture(
          { texture: this.pingPongTexture },
          { texture: this.denoisedTexture },
          { width: this.renderWidth, height: this.renderHeight }
        );
      }
    } else {
      // No denoising - copy directly to denoised texture for display
      commandEncoder.copyTextureToTexture(
        { texture: postTemporalTexture },
        { texture: this.denoisedTexture },
        { width: this.renderWidth, height: this.renderHeight }
      );
    }

    // 5. Render to screen
    const textureView = this.context.getCurrentTexture().createView();
    const renderPass = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: textureView,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    renderPass.setPipeline(this.renderPipeline);
    renderPass.setBindGroup(0, this.renderBindGroup);
    renderPass.draw(3);
    renderPass.end();

    this.device.queue.submit([commandEncoder.finish()]);

    // Store current camera as previous for next frame
    this.prevCamera = {
      position: { ...this.camera.position },
      direction: { ...this.camera.direction },
      up: { ...this.camera.up },
      fov: this.camera.fov,
    };
  }
}
