/**
 * 后期处理管线（HDR + Bloom）
 *
 * ── 整体流程 ──
 *
 *   1. 场景 → sceneRT（半浮点，线性 HDR，>1 的亮度被保留）
 *   2. sceneRT → brightPass → bloomMips[0]（半分辨率，亮部提取）
 *   3. bloomMips[0] → 逐级降采样 → bloomMips[1..N-1]
 *   4. bloomMips[N-1] → 逐级上采样累加 → bloomMips[N-2..0]
 *   5. sceneRT + bloomMips[0] → composite → 屏幕
 *      （合成 + ACES + 颗粒 + 暗角 + sRGB 一次做完）
 *
 * ── 为什么用「逐级降采样 + 上采样」而不是一个大 Gaussian ──
 *   一个 σ=64 的 Gaussian 需要 ~128 次采样，全屏算下来非常贵。
 *   金字塔方案总共只有 2N 次采样，却能得到同等宽度甚至更自然的光晕，
 *   而且每一级都自带抗锯齿。这是游戏工业的标准做法。
 *
 * ── 为什么必须用半浮点 RT ──
 *   bloom 的价值就在于抓 >1 的高光。如果 RT 是 RGBA8，写进去的 3.0
 *   会被截断成 1.0，bloom 就变成了「给已经很亮的像素再加一点亮」，
 *   光晕完全没有层次。HalfFloatType 能存到 65504，绰绰有余。
 */

import * as THREE from 'three';
import postVert from '../shaders/post.vert';
import brightFrag from '../shaders/bloom-bright.frag';
import downFrag from '../shaders/bloom-down.frag';
import upFrag from '../shaders/bloom-up.frag';
import compositeFrag from '../shaders/composite.frag';

/** 降采样金字塔的级数。5 级可以覆盖到 1/32 分辨率，光晕很宽。 */
const MIP_COUNT = 5;

type FullscreenPass = {
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  material: THREE.ShaderMaterial;
};

/** 创建一块贴在全屏三角形上的 Pass */
function createPass(fragmentShader: string, uniforms: Record<string, THREE.IUniform>): FullscreenPass {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
  );

  const material = new THREE.ShaderMaterial({
    vertexShader: postVert,
    fragmentShader,
    uniforms,
    depthTest: false,
    depthWrite: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;

  const scene = new THREE.Scene();
  scene.add(mesh);

  // 后期 pass 不需要真实投影，用单位正交相机即可
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  return { scene, camera, material };
}

export type BloomParams = {
  strength: number;
  threshold: number;
  softKnee: number;
  scatter: number;
};

export const DEFAULT_BLOOM: BloomParams = {
  strength: 0.55,
  threshold: 0.85,
  softKnee: 0.6,
  scatter: 0.85,
};

export class PostPipeline {
  private readonly renderer: THREE.WebGLRenderer;

  /** 场景渲染目标（线性 HDR） */
  private sceneRT: THREE.WebGLRenderTarget;
  /** bloom 降采样金字塔 */
  private mips: THREE.WebGLRenderTarget[] = [];
  /**
   * bloom 上采样累加缓冲。
   *
   * ── 为什么需要额外一组 RT ──
   * 上采样的输入是「低一级的已累加结果」，输出是「当前级的累加结果」。
   * 如果直接写回 mips[i]，就会让同一个纹理既被采样又被当作渲染目标，
   * WebGL 会报 `Feedback loop formed between Framebuffer and active Texture`
   * 并静默拒绝执行 —— 表现是 bloom 完全不出现，但控制台没有 error。
   *
   * 所以用一组独立的 RT 做 ping-pong：读 mips/upsampled[i+1]，写 upsampled[i]。
   */
  private upsampled: THREE.WebGLRenderTarget[] = [];

  private brightPass!: FullscreenPass;
  private downPass!: FullscreenPass;
  private upPass!: FullscreenPass;
  private compositePass!: FullscreenPass;

  private width = 1;
  private height = 1;

  /** 是否启用 bloom */
  enabled = true;

  /** 调试：把 bloom 缓冲直接输出到屏幕 */
  debugBloom = false;

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;

    const rtOptions = {
      type: THREE.HalfFloatType,
      // 线性过滤，上采样时才有平滑的帐篷插值
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      // 各 Pass 之间不需要深度
      depthBuffer: false,
      stencilBuffer: false,
      // 关掉 three 自动注入的 sRGB 转换：这些都是线性 HDR 缓冲
      colorSpace: THREE.NoColorSpace,
    } as const;

    this.sceneRT = new THREE.WebGLRenderTarget(1, 1, {
      ...rtOptions,
      // 只有场景 RT 需要深度（机舱几何要正确遮挡）
      depthBuffer: true,
    });

    for (let i = 0; i < MIP_COUNT; i++) {
      this.mips.push(new THREE.WebGLRenderTarget(1, 1, rtOptions));
      this.upsampled.push(new THREE.WebGLRenderTarget(1, 1, rtOptions));
    }

    this.createPasses();
  }

  private createPasses() {
    // 1) 亮部提取
    this.brightPass = createPass(brightFrag, {
      tDiffuse: { value: null },
      uThreshold: { value: DEFAULT_BLOOM.threshold },
      uSoftKnee: { value: DEFAULT_BLOOM.softKnee },
      uExposure: { value: 1 },
    });

    // 2) 降采样
    this.downPass = createPass(downFrag, {
      tDiffuse: { value: null },
      uTexelSize: { value: new THREE.Vector2() },
      uThreshold: { value: 0 },
    });

    // 3) 上采样
    this.upPass = createPass(upFrag, {
      tLow: { value: null },
      tHigh: { value: null },
      uTexelSize: { value: new THREE.Vector2() },
      uScatter: { value: DEFAULT_BLOOM.scatter },
    });

    // 4) 合成
    this.compositePass = createPass(compositeFrag, {
      tScene: { value: null },
      tBloom: { value: null },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uExposure: { value: 1 },
      uBloomStrength: { value: DEFAULT_BLOOM.strength },
      uGrainAmount: { value: 0.012 },
      uTime: { value: 0 },
      uVignette: { value: 0.25 },
      uDebugBloom: { value: 0 },
    });
  }

  /**
   * 尺寸变化时重建所有渲染目标。
   * @param w 实际像素宽
   * @param h 实际像素高
   */
  setSize(w: number, h: number) {
    const width = Math.max(1, Math.floor(w));
    const height = Math.max(1, Math.floor(h));
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;

    this.sceneRT.setSize(width, height);

    // 金字塔逐级减半。用 Math.max(1, ...) 兜底，避免极小窗口下尺寸为 0。
    let mw = width;
    let mh = height;
    for (let i = 0; i < MIP_COUNT; i++) {
      // 第一级从半分辨率开始（亮部提取后立刻缩小，省一半带宽）
      mw = Math.max(1, mw >> 1);
      mh = Math.max(1, mh >> 1);
      this.mips[i].setSize(mw, mh);
      this.upsampled[i].setSize(mw, mh);
    }

    (this.compositePass.material.uniforms.uResolution.value as THREE.Vector2).set(width, height);
  }

  /** 用给定材质把一个全屏 Pass 画到目标上 */
  private drawPass(pass: FullscreenPass, target: THREE.WebGLRenderTarget | null) {
    this.renderer.setRenderTarget(target);
    this.renderer.clear();
    this.renderer.render(pass.scene, pass.camera);
  }

  /**
   * 渲染一帧。
   *
   * @param scene  主场景（天空 + 机舱）
   * @param camera 主相机
   * @param frame 渲染参数
   */
  render(
    scene: THREE.Scene,
    camera: THREE.Camera,
    frame: {
      exposure: number;
      time: number;
      bloom: BloomParams;
      grain: number;
      vignette: number;
    },
  ) {
    const { exposure, time, bloom, grain, vignette } = frame;

    // ── 1. 场景 → HDR 缓冲 ──
    // 关键：渲染到 RT 时必须关掉色调映射和色彩空间编码，
    // 否则写进缓冲的已经是 LDR 压缩过的值，bloom 就抓不到高光了。
    const prevToneMapping = this.renderer.toneMapping;
    const prevColorSpace = this.renderer.outputColorSpace;

    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

    this.renderer.setRenderTarget(this.sceneRT);
    this.renderer.clear();
    this.renderer.render(scene, camera);

    // 恢复，以免影响后续 Pass（虽然它们都是原生 ShaderMaterial）
    this.renderer.toneMapping = prevToneMapping;
    this.renderer.outputColorSpace = prevColorSpace;

    // ── 2. 亮部提取 → mip0 ──
    if (this.enabled) {
      const bu = this.brightPass.material.uniforms;
      bu.tDiffuse.value = this.sceneRT.texture;
      bu.uThreshold.value = bloom.threshold;
      bu.uSoftKnee.value = bloom.softKnee;
      bu.uExposure.value = exposure;
      this.drawPass(this.brightPass, this.mips[0]);

      // ── 3. 逐级降采样 ──
      const du = this.downPass.material.uniforms;
      du.uThreshold.value = 0; // 只有第一级用软膝盖
      for (let i = 1; i < MIP_COUNT; i++) {
        const src = this.mips[i - 1];
        du.tDiffuse.value = src.texture;
        (du.uTexelSize.value as THREE.Vector2).set(1 / src.width, 1 / src.height);
        this.drawPass(this.downPass, this.mips[i]);
      }

      // ── 4. 逐级上采样累加 ──
      //
      // 用独立的 upsampled[] 做 ping-pong，绝不能读 mips[i] 又写 mips[i]
      // （会触发 WebGL 的 framebuffer feedback loop，静默失效）。
      //
      // 起点：最粗一级直接作为累加初值（拷一份到 upsampled[last]）。
      // 之后每一级：读 upsampled[i+1]（更模糊），写 upsampled[i]。
      const uu = this.upPass.material.uniforms;
      uu.uScatter.value = bloom.scatter;

      const last = MIP_COUNT - 1;

      // 最粗一级：tent 采样自己，等价于原样拷贝（保证后续输入是干净的）
      uu.tLow.value = this.mips[last].texture;
      uu.tHigh.value = this.mips[last].texture;
      (uu.uTexelSize.value as THREE.Vector2).set(1 / this.mips[last].width, 1 / this.mips[last].height);
      // 拷贝时把 scatter 临时置 0，避免自己叠加自己
      uu.uScatter.value = 0;
      this.drawPass(this.upPass, this.upsampled[last]);
      uu.uScatter.value = bloom.scatter;

      for (let i = last - 1; i >= 0; i--) {
        uu.tLow.value = this.upsampled[i + 1].texture; // 更模糊的一级
        uu.tHigh.value = this.mips[i].texture; // 当前级原始降采样
        (uu.uTexelSize.value as THREE.Vector2).set(1 / this.mips[i].width, 1 / this.mips[i].height);
        this.drawPass(this.upPass, this.upsampled[i]);
      }
    }

    // ── 5. 合成到屏幕 ──
    const cu = this.compositePass.material.uniforms;
    cu.tScene.value = this.sceneRT.texture;
    cu.tBloom.value = this.enabled ? this.upsampled[0].texture : null;
    cu.uExposure.value = exposure;
    cu.uBloomStrength.value = this.enabled ? bloom.strength : 0;
    cu.uGrainAmount.value = grain;
    cu.uVignette.value = vignette;
    cu.uTime.value = time;
    cu.uDebugBloom.value = this.debugBloom ? 1 : 0;

    this.drawPass(this.compositePass, null);
  }

  dispose() {
    this.sceneRT.dispose();
    for (const m of this.mips) m.dispose();
    for (const m of this.upsampled) m.dispose();
    for (const p of [this.brightPass, this.downPass, this.upPass, this.compositePass]) {
      p.material.dispose();
      // 全屏三角形的几何体
      (p.scene.children[0] as THREE.Mesh).geometry.dispose();
    }
  }
}
