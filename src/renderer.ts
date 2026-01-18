import raytraceShaderCode from './shaders/raytrace.wgsl?raw';

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

  private computePipeline!: GPUComputePipeline;
  private renderPipeline!: GPURenderPipeline;
  private outputTexture!: GPUTexture;
  private computeBindGroup!: GPUBindGroup;
  private renderBindGroup!: GPUBindGroup;
  private cameraBuffer!: GPUBuffer;
  private sampler!: GPUSampler;

  constructor(
    device: GPUDevice,
    context: GPUCanvasContext,
    format: GPUTextureFormat,
    width: number,
    height: number,
    camera: Camera
  ) {
    this.device = device;
    this.context = context;
    this.format = format;
    this.width = width;
    this.height = height;
    this.camera = camera;
  }

  async initialize(): Promise<void> {
    // Create output storage texture
    this.outputTexture = this.device.createTexture({
      size: { width: this.width, height: this.height },
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    // Create camera uniform buffer
    this.cameraBuffer = this.device.createBuffer({
      size: 64, // 4 vec4s worth of data
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.updateCameraBuffer();

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
            format: 'rgba8unorm',
            viewDimension: '2d',
          },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform' },
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
          // Full-screen triangle
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
          return textureSample(outputTex, outputSampler, uv);
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
      // Camera position (vec3 + padding)
      this.camera.position.x,
      this.camera.position.y,
      this.camera.position.z,
      0,
      // Camera direction (vec3 + padding)
      this.camera.direction.x,
      this.camera.direction.y,
      this.camera.direction.z,
      0,
      // Camera up (vec3 + padding)
      this.camera.up.x,
      this.camera.up.y,
      this.camera.up.z,
      0,
      // Resolution and FOV
      this.width,
      this.height,
      this.camera.fov * (Math.PI / 180), // Convert to radians
      0,
    ]);
    this.device.queue.writeBuffer(this.cameraBuffer, 0, data);
  }

  updateCamera(camera: Camera): void {
    this.camera = camera;
    this.updateCameraBuffer();
  }

  render(): void {
    const commandEncoder = this.device.createCommandEncoder();

    // Compute pass - ray trace
    const computePass = commandEncoder.beginComputePass();
    computePass.setPipeline(this.computePipeline);
    computePass.setBindGroup(0, this.computeBindGroup);

    const workgroupSize = 8;
    const dispatchX = Math.ceil(this.width / workgroupSize);
    const dispatchY = Math.ceil(this.height / workgroupSize);
    computePass.dispatchWorkgroups(dispatchX, dispatchY);
    computePass.end();

    // Render pass - blit to canvas
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
