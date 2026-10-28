import * as THREE from 'three';
import skyVert from '../shaders/fullscreen.vert';
import skyFrag from '../shaders/sky.frag';
import { AtmosphereLUT } from './atmosphereLUT';
import { generateNoiseTextureData } from './noise';
import {
  generatePopulationMap,
  POP_LON_MIN,
  POP_LON_MAX,
  POP_LAT_MIN,
  POP_LAT_MAX,
} from './population';
import * as C from '../config';

/**
 * 天空渲染器
 *
 * 一块全屏三角形，挂着自定义 ShaderMaterial。
 *
 * 为什么不用 three 的 scene/camera 变换：
 *   片元着色器自己做了球面射线求交，相机位置是「世界坐标（km）」，
 *   而 three 的相机矩阵在 1e-6 的量级下会损失精度。所以位置走 uniform，
 *   相机对象只负责提供朝向矩阵。
 */
export class SkyRenderer {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;

  private readonly noiseTex: THREE.DataTexture;
  private readonly popTex: THREE.DataTexture;
  private readonly u: Record<string, THREE.IUniform>;
  private readonly lut: AtmosphereLUT;

  constructor(renderer: THREE.WebGLRenderer) {
    // --- 噪声纹理 ---
    const NOISE_SIZE = 512;
    const noiseData = generateNoiseTextureData(NOISE_SIZE, 1337);
    this.noiseTex = new THREE.DataTexture(noiseData, NOISE_SIZE, NOISE_SIZE, THREE.RGBAFormat);
    this.noiseTex.wrapS = THREE.RepeatWrapping;
    this.noiseTex.wrapT = THREE.RepeatWrapping;
    this.noiseTex.minFilter = THREE.LinearMipmapLinearFilter;
    this.noiseTex.magFilter = THREE.LinearFilter;
    this.noiseTex.generateMipmaps = true;
    this.noiseTex.anisotropy = 4;
    this.noiseTex.needsUpdate = true;

    // --- 人口密度图（城市灯光引导）---
    // 用 8 位单通道（RedFormat + UnsignedByteType）而不是 FloatType：
    //   浮点纹理在 WebGL2 里生成 mipmap 需要额外扩展，且线性过滤
    //   对 float 纹理的支持在部分设备上不可靠 —— 结果是远处出现
    //   严重的摩尔纹/噪点。8 位足够表达 0..1 的密度，且 mipmap 万无一失。
    const POP_W = 2048;
    const POP_H = 1024;
    const popFloat = generatePopulationMap(POP_W, POP_H);
    const popBytes = new Uint8Array(POP_W * POP_H);
    for (let i = 0; i < popFloat.length; i++) {
      // 注意：这里不做 sRGB 编码，存的是线性密度值
      popBytes[i] = Math.max(0, Math.min(255, Math.round(popFloat[i] * 255)));
    }
    this.popTex = new THREE.DataTexture(
      popBytes,
      POP_W,
      POP_H,
      THREE.RedFormat,
      THREE.UnsignedByteType,
    );
    this.popTex.wrapS = THREE.ClampToEdgeWrapping;
    this.popTex.wrapT = THREE.ClampToEdgeWrapping;
    this.popTex.minFilter = THREE.LinearMipmapLinearFilter;
    this.popTex.magFilter = THREE.LinearFilter;
    this.popTex.generateMipmaps = true;
    this.popTex.anisotropy = 4;
    this.popTex.needsUpdate = true;

    // --- uniforms ---
    // 多重散射 LUT：32×32 的 (海拔, 太阳天顶角) → 方向平均散射辐亮度。
    // 生成需要几个 GPU pass，所以放在构造函数里一次算完。
    this.lut = new AtmosphereLUT(renderer);

    this.u = {
      uResolution: { value: new THREE.Vector2(1, 1) },
      uTime: { value: 0 },
      uCamPos: { value: new THREE.Vector3(0, C.EARTH_RADIUS_KM + C.CRUISE_ALTITUDE_KM, 0) },
      uCamBasis: { value: new THREE.Matrix3() },
      uTanHalfFov: { value: Math.tan((C.CAMERA_FOV_CABIN * Math.PI) / 360) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Vector3(1, 1, 1) },
      uSunAngularRadius: { value: C.SUN_ANGULAR_RADIUS },
      uExposure: { value: 1 },

      // 大气
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

      // 多重散射
      uMultiScatterLUT: { value: this.lut.texture },
      uMSStrength: { value: 1 },
      // 星星亮度缩放：自动曝光提亮几百倍时，星星必须同比压回去，
      // 否则每颗星都会变成一团带 bloom 的白色光斑
      uStarScale: { value: 1 },

      // 城市灯光
      uCities: { value: 1 },
      uPopulationTex: { value: this.popTex },
      uPopBounds: {
        value: new THREE.Vector4(POP_LON_MIN, POP_LON_MAX, POP_LAT_MIN, POP_LAT_MAX),
      },
      uPopTexSize: { value: POP_W },
      uPixelAngle: { value: 0.001 },

      // 飞行位移（km）：让地表图案随时间流过
      uFlightOffset: { value: new THREE.Vector2(0, 0) },

      // 天气
      uLowClouds: { value: 0.3 },
      uCirrus: { value: 0.5 },

      // 性能
      uSteps: { value: 16 },

      // 调试通道（0 = 正常）
      uDebugMode: { value: 0 },

      uNoiseTex: { value: this.noiseTex },
    };

    this.material = new THREE.ShaderMaterial({
      vertexShader: skyVert,
      fragmentShader: skyFrag,
      uniforms: this.u,
      depthTest: false,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });

    // --- 全屏三角形 ---
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
    );
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    // 确保它最后渲染（其实场景里只有它）
    this.mesh.renderOrder = 0;
  }

  /** 每帧传入相机状态 */
  update(
    camera: THREE.PerspectiveCamera,
    camPosWorldKm: THREE.Vector3,
    sunDir: THREE.Vector3,
    sunColor: readonly [number, number, number],
    exposure: number,
    time: number,
  ) {
    this.u.uTime.value = time;
    (this.u.uCamPos.value as THREE.Vector3).copy(camPosWorldKm);
    (this.u.uSunDir.value as THREE.Vector3).copy(sunDir);
    (this.u.uSunColor.value as THREE.Vector3).set(sunColor[0], sunColor[1], sunColor[2]);
    this.u.uExposure.value = exposure;

    // 相机基向量：matrixWorld 列主序，列 0/1/2 = right / up / back
    const e = camera.matrixWorld.elements;
    (this.u.uCamBasis.value as THREE.Matrix3).set(e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]);

    this.u.uTanHalfFov.value = Math.tan((camera.fov * Math.PI) / 360);

    // pixelAngle 依赖 fov 与分辨率，两者都可能变，这里每帧同步一次（开销可忽略）
    const res = this.u.uResolution.value as THREE.Vector2;
    this.u.uPixelAngle.value = (2.0 * (this.u.uTanHalfFov.value as number)) / Math.max(res.y, 1);
  }

  /** @param w 实际像素宽 */
  setResolution(w: number, h: number) {
    (this.u.uResolution.value as THREE.Vector2).set(w, h);
    // 每个像素的张角。城市灯光的足迹估算依赖它。
    const tanHalf = this.u.uTanHalfFov.value as number;
    this.u.uPixelAngle.value = (2.0 * tanHalf) / Math.max(h, 1);
  }

  /** ray-march 步数。会被 clamp 到 shader 的 MAX_SKY_STEPS。 */
  setQuality(steps: number) {
    this.u.uSteps.value = Math.max(2, Math.min(24, Math.round(steps)));
  }

  setWeather(lowClouds: number, cirrus: number) {
    this.u.uLowClouds.value = lowClouds;
    this.u.uCirrus.value = cirrus;
  }

  /** 城市灯光强度 */
  setCities(intensity: number) {
    this.u.uCities.value = Math.max(0, intensity);
  }

  /** 多次散射强度（1 = 物理值，0 = 关闭）。用于 A/B 对比。 */
  setMSStrength(v: number) {
    this.u.uMSStrength.value = Math.max(0, v);
  }

  /** 星星亮度缩放（随自动曝光反向缩放） */
  setStarScale(v: number) {
    this.u.uStarScale.value = Math.max(0, v);
  }

  /**
   * 飞行位移（km）。驱动地表/云/灯光图案流过画面。
   *
   * 注意是「偏移采样坐标」而不是「移动相机」：
   * 移动相机会让地平线和球面求交结果抖动，
   * 而偏移采样坐标只让图案流动，几何完全稳定。
   */
  setFlightOffset(x: number, y: number) {
    (this.u.uFlightOffset.value as THREE.Vector2).set(x, y);
  }

  /**
   * 调试通道。
   * 0 正常 / 1 人口密度 / 2 像素足迹 / 3 城市灯光 /
   * 4 大气透射率 / 5 地面反照率 / 6 天空散射
   */
  setDebugMode(mode: number) {
    this.u.uDebugMode.value = Math.round(mode);
  }

  dispose() {
    this.material.dispose();
    this.mesh.geometry.dispose();
    this.noiseTex.dispose();
    this.popTex.dispose();
    this.lut.dispose();
  }
}
