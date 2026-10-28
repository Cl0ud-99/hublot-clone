/**
 * 大气多重散射 LUT 生成器
 *
 * 启动时跑 6 个 32×32 的全屏 pass（5 阶散射 + 1 次求和），
 * 得到一张 RGBA16F 纹理，供天空着色器逐采样点查询。
 *
 * ── 为什么用纹理而不是在片元里现算 ──
 * 现算需要「对每个采样点、对 64 个方向、每个方向再 march 28 步」，
 * 等于每像素几千次密度求值 —— 完全不可能实时。
 * 而这个场对 (海拔, 太阳天顶角) 是光滑且与观察方位无关的，
 * 32×32 的查询表 + 线性过滤就足够，误差在 1% 量级（见 README 的验证章节）。
 *
 * ── 精度验证 ──
 * tools/ms-reference.mjs 里有一份双精度 CPU 参考实现，可以做三件事：
 *   1) 与 GPU LUT 逐 texel 对比（验证 GPU 侧没有写错）
 *   2) 与更高分辨率 / 更多方向 / 更多阶数的版本对比（验证离散化误差）
 *   3) 输出天顶天空亮度随太阳高度的曲线，与文献值对照（验证物理）
 */

import * as THREE from 'three';
import msFrag from '../shaders/multiscatter.frag';
import combineFrag from '../shaders/multiscatter-combine.frag';
import fullscreenVert from '../shaders/fullscreen.vert';
import * as C from '../config';

/** LUT 边长（texel）。32 已经足够：这个场在二维上都非常光滑。 */
const LUT_SIZE = 32;

/** 各阶的入射方向采样数。第一阶有 Mie 前向峰，需要更多样本。 */
const DIR_COUNT_FIRST = 64;
const DIR_COUNT_HIGHER = 32;

/** 阶数。5 阶之后残余项 < 0.1%（见 tools/ms-reference.mjs 的收敛表）。 */
const ORDER_COUNT = 5;

export class AtmosphereLUT {
  /** 最终的多次散射场纹理，绑定到 uMultiScatterLUT */
  readonly texture: THREE.Texture;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly targets: THREE.WebGLRenderTarget[] = [];
  private readonly msMaterial: THREE.ShaderMaterial;
  private readonly combineMaterial: THREE.ShaderMaterial;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.Camera;
  private readonly quad: THREE.Mesh;
  private readonly u: Record<string, THREE.IUniform>;
  private disposed = false;

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;

    const canFloat =
      renderer.extensions.has('EXT_color_buffer_float') ||
      renderer.extensions.has('EXT_color_buffer_half_float');

    // 32×32×RGBA32F = 16 KB/张，总共不到 100 KB，用全精度浮点最省心：
    // 半精度虽然够存辐亮度，但 readRenderTargetPixels 读回时类型对不上，
    // 调试阶段会被误判成「LUT 全 0」。精度余量换调试确定性，值。
    const type = canFloat ? THREE.FloatType : THREE.UnsignedByteType;

    const rtOptions: THREE.RenderTargetOptions = {
      type,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    };

    for (let i = 0; i < ORDER_COUNT; i++) {
      this.targets.push(new THREE.WebGLRenderTarget(LUT_SIZE, LUT_SIZE, rtOptions));
    }
    const out = new THREE.WebGLRenderTarget(LUT_SIZE, LUT_SIZE, rtOptions);
    this.targets.push(out);
    this.texture = out.texture;
    this.texture.colorSpace = THREE.NoColorSpace;

    // --- 统一的大气参数 ---
    this.u = {
      uEarthRadius: { value: C.EARTH_RADIUS_KM },
      uAtmosphereRadius: { value: C.ATMOSPHERE_RADIUS_KM },
      uRayleighScaleHeight: { value: C.RAYLEIGH_SCALE_HEIGHT_KM },
      uMieScaleHeight: { value: C.MIE_SCALE_HEIGHT_KM },
      uOzoneCenter: { value: C.OZONE_CENTER_KM },
      uOzoneWidth: { value: C.OZONE_WIDTH_KM },
      uRayleighBeta: { value: new THREE.Vector3(...C.RAYLEIGH_BETA) },
      uMieBeta: { value: C.MIE_BETA },
      uMieAbsorb: { value: C.MIE_ABSORB },
      uOzoneBeta: { value: new THREE.Vector3(...C.OZONE_BETA) },
      uMieG: { value: C.MIE_G },
      uMultiScatterLUT: { value: null },
      uMSStrength: { value: 1 },
      uOrder: { value: 1 },
      uDirCount: { value: DIR_COUNT_FIRST },
      uDebug: { value: 0 },
    };

    this.msMaterial = new THREE.ShaderMaterial({
      vertexShader: fullscreenVert,
      fragmentShader: msFrag,
      uniforms: this.u,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });

    this.combineMaterial = new THREE.ShaderMaterial({
      vertexShader: fullscreenVert,
      fragmentShader: combineFrag,
      uniforms: {
        uMS1: { value: null },
        uMS2: { value: null },
        uMS3: { value: null },
        uMS4: { value: null },
        uMS5: { value: null },
      },
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });

    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
    );
    this.quad = new THREE.Mesh(geo, this.msMaterial);
    this.quad.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.quad);
    this.camera = new THREE.Camera();

    this.generate();

    if (!canFloat) {
      console.warn(
        '[AtmosphereLUT] EXT_color_buffer_float 不可用，多重散射 LUT 降级为 8 位精度。',
      );
    }
  }

  /** 跑完所有 pass，把结果留在 this.texture 里。 */
  private generate() {
    const renderer = this.renderer;
    const prevTarget = renderer.getRenderTarget();

    renderer.setClearColor(0x000000, 1);
    this.quad.material = this.msMaterial;

    let prevTexture: THREE.Texture | null = null;
    for (let order = 1; order <= ORDER_COUNT; order++) {
      this.u.uOrder.value = order;
      this.u.uDirCount.value = order === 1 ? DIR_COUNT_FIRST : DIR_COUNT_HIGHER;
      // 生成阶段：msLookup 采样的是「上一阶」
      this.u.uMultiScatterLUT.value = prevTexture;
      renderer.setRenderTarget(this.targets[order - 1]);
      renderer.clear(true, false, false);
      renderer.render(this.scene, this.camera);
      prevTexture = this.targets[order - 1].texture;
    }

    // --- 求和 ---
    this.quad.material = this.combineMaterial;
    const cu = this.combineMaterial.uniforms;
    cu.uMS1.value = this.targets[0].texture;
    cu.uMS2.value = this.targets[1].texture;
    cu.uMS3.value = this.targets[2].texture;
    cu.uMS4.value = this.targets[3].texture;
    cu.uMS5.value = this.targets[4].texture;
    renderer.setRenderTarget(this.targets[ORDER_COUNT]);
    renderer.clear(true, false, false);
    renderer.render(this.scene, this.camera);

    renderer.setRenderTarget(prevTarget);
  }

  /**
   * 把 LUT 读回 CPU（Float32Array，RGBA，行优先，行 0 = v 最小）。
   * 只用于测试与调试 —— 正式渲染路径不会调用。
   */
  readback(): Float32Array {
    const buf = new Float32Array(LUT_SIZE * LUT_SIZE * 4);
    this.renderer.readRenderTargetPixels(
      this.targets[ORDER_COUNT],
      0,
      0,
      LUT_SIZE,
      LUT_SIZE,
      buf,
    );
    return buf;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.msMaterial.dispose();
    this.combineMaterial.dispose();
    this.quad.geometry.dispose();
    for (const rt of this.targets) rt.dispose();
  }
}

export const LUT_RESOLUTION = LUT_SIZE;
