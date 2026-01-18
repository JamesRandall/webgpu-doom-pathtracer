import raytraceShaderCode from './shaders/raytrace.wgsl?raw';
import { Triangle, packTriangles } from './scene/geometry';
import { BVHBuilder, flattenBVH, packBVHNodes } from './bvh/builder';

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
  private width: number;
  private height: number;
  private camera: Camera;
  private triangles: Triangle[];
  private frameCount: number = 0;
  private nodeCount: number = 0;
  private triangleCount: number = 0;

  private computePipeline!: GPUComputePipeline;
  private renderPipeline!: GPURenderPipeline;
  private outputTexture!: GPUTexture;
  private accumulationTexture!: GPUTexture;
  private computeBindGroup!: GPUBindGroup;
  private renderBindGroup!: GPUBindGroup;
  private cameraBuffer!: GPUBuffer;
  private triangleBuffer!: GPUBuffer;
  private bvhBuffer!: GPUBuffer;
  private sceneInfoBuffer!: GPUBuffer;
  private sampler!: GPUSampler;
  private lastCameraPosition = { x: 0, y: 0, z: 0 };
  private lastCameraDirection = { x: 0, y: 0, z: 1 };

  constructor(
    device: GPUDevice,
    context: GPUCanvasContext,
    format: GPUTextureFormat,
    width: number,
    height: number,
    camera: Camera,
    triangles: Triangle[]
  ) {
    this.device = device;
    this.context = context;
    this.format = format;
    this.width = width;
    this.height = height;
    this.camera = camera;
    this.triangles = triangles;
  }

  async initialize(): Promise<void> {
    // Build BVH
    const bvhBuilder = new BVHBuilder();
    const { nodes, orderedTriangles } = bvhBuilder.build(this.triangles);
    const flatNodes = flattenBVH(nodes);
    const bvhData = packBVHNodes(flatNodes);

    this.nodeCount = nodes.length;
    this.triangleCount = orderedTriangles.length;

    console.log(`BVH built: ${nodes.length} nodes for ${orderedTriangles.length} triangles`);

    // Create output storage texture
    this.outputTexture = this.device.createTexture({
      size: { width: this.width, height: this.height },
      format: 'rgba16float',
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    // Create accumulation texture for temporal averaging
    this.accumulationTexture = this.device.createTexture({
      size: { width: this.width, height: this.height },
      format: 'rgba16float',
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST,
    });

    // Create camera uniform buffer
    this.cameraBuffer = this.device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.updateCameraBuffer();

    // Create triangle storage buffer (using BVH-ordered triangles)
    const triangleData = packTriangles(orderedTriangles);
    this.triangleBuffer = this.device.createBuffer({
      size: Math.max(triangleData.byteLength, 32),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.triangleBuffer, 0, triangleData.buffer);

    // Create BVH storage buffer
    this.bvhBuffer = this.device.createBuffer({
      size: Math.max(bvhData.byteLength, 32),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.bvhBuffer, 0, bvhData);

    // Create scene info buffer (triangle count, node count, frame, bounces)
    this.sceneInfoBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
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
          buffer: { type: 'uniform' },
        },
        {
          binding: 5,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'float', viewDimension: '2d' },
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
          resource: { buffer: this.bvhBuffer },
        },
        {
          binding: 4,
          resource: { buffer: this.sceneInfoBuffer },
        },
        {
          binding: 5,
          resource: this.accumulationTexture.createView(),
        },
      ],
    });

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
          let color = textureSample(outputTex, outputSampler, uv).rgb;
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
          resource: this.outputTexture.createView(),
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
      this.width,
      this.height,
      this.camera.fov * (Math.PI / 180),
      0,
    ]);
    this.device.queue.writeBuffer(this.cameraBuffer, 0, data);
  }

  private updateSceneInfoBuffer(): void {
    const sceneInfo = new Uint32Array([
      this.triangleCount,
      this.nodeCount,
      this.frameCount,
      4, // max bounces
    ]);
    this.device.queue.writeBuffer(this.sceneInfoBuffer, 0, sceneInfo);
  }

  updateCamera(camera: Camera): void {
    // Check if camera moved - reset accumulation if so
    const posChanged =
      Math.abs(camera.position.x - this.lastCameraPosition.x) > 0.0001 ||
      Math.abs(camera.position.y - this.lastCameraPosition.y) > 0.0001 ||
      Math.abs(camera.position.z - this.lastCameraPosition.z) > 0.0001;
    const dirChanged =
      Math.abs(camera.direction.x - this.lastCameraDirection.x) > 0.0001 ||
      Math.abs(camera.direction.y - this.lastCameraDirection.y) > 0.0001 ||
      Math.abs(camera.direction.z - this.lastCameraDirection.z) > 0.0001;

    if (posChanged || dirChanged) {
      this.frameCount = 0;
      this.lastCameraPosition = { ...camera.position };
      this.lastCameraDirection = { ...camera.direction };
    }

    this.camera = camera;
    this.updateCameraBuffer();
  }

  render(): void {
    // Update frame counter for RNG
    this.updateSceneInfoBuffer();
    this.frameCount++;

    const commandEncoder = this.device.createCommandEncoder();

    const computePass = commandEncoder.beginComputePass();
    computePass.setPipeline(this.computePipeline);
    computePass.setBindGroup(0, this.computeBindGroup);

    const workgroupSize = 8;
    const dispatchX = Math.ceil(this.width / workgroupSize);
    const dispatchY = Math.ceil(this.height / workgroupSize);
    computePass.dispatchWorkgroups(dispatchX, dispatchY);
    computePass.end();

    // Copy output to accumulation for next frame
    commandEncoder.copyTextureToTexture(
      { texture: this.outputTexture },
      { texture: this.accumulationTexture },
      { width: this.width, height: this.height }
    );

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
  }
}
