/**
 * 天空环境贴图（equirect）
 *
 * ── 为什么机翼必须有环境反射 ──
 * `MeshStandardMaterial` 在 `metalness ≈ 0` 时，镜面项只有光源的 GGX 高光，
 * **完全没有环境**。太阳是一个点，所以整片翼面要么是均匀的漫反射，
 * 要么是一条孤立的高光 —— 这正是「塑料感」的物理来源。
 *
 * 真实机翼是光滑涂装，它会把整个上半球的天空映在表面上：
 * 抬头那侧偏蓝、地平线那侧偏白。这个**缓慢的渐变反射**才是
 * 「金属/涂装」和「塑料」的分界。
 *
 * ── 为什么用 equirect 而不是 CubeCamera ──
 * CubeCamera 要渲染 6 个面，而我们的天空是一个依赖 uCamBasis/uniform 的
 * 全屏 shader，塞进 cube 渲染要改一大堆状态。
 * 而机翼需要的环境信息本来就极其低频（天空渐变），
 * 一张 256×128 的手绘 equirect 就够了，成本几乎为零。
 *
 * 后续如果要做精确反射，把这里换成 PMREMGenerator.fromScene 即可，
 * 接口不用动。
 */

import * as THREE from 'three';

/**
 * 生成天空环境贴图。
 *
 * @param dayness 0 = 深夜，1 = 白天。控制整体亮度与色温。
 */
export function createSkyEnvTexture(dayness = 1): THREE.CanvasTexture {
  const W = 256;
  const H = 128;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D canvas 上下文');

  /**
   * ── 关键：地平线必须在 v = 0.5 ──
   * equirect 的 v 从 0（天顶）到 1（天底），所以地平线在正中间。
   * 天空一侧的渐变不能是对称的：天顶是最深的蓝，越接近地平线越白
   * （大气路径变长、Mie 散射占主导），地平线处最亮。
   */
  const grad = ctx.createLinearGradient(0, 0, 0, H);

  // 白天 / 夜晚两组色标，按 dayness 插值
  const mix = (a: [number, number, number], b: [number, number, number]): string => {
    const r = Math.round(a[0] + (b[0] - a[0]) * dayness);
    const g = Math.round(a[1] + (b[1] - a[1]) * dayness);
    const bl = Math.round(a[2] + (b[2] - a[2]) * dayness);
    return `rgb(${r},${g},${bl})`;
  };

  // 天顶
  grad.addColorStop(0.0, mix([26, 34, 58], [70, 120, 205]));
  // 中空
  grad.addColorStop(0.28, mix([40, 58, 96], [120, 165, 225]));
  // 地平线上方
  grad.addColorStop(0.44, mix([62, 86, 130], [190, 215, 245]));
  // 地平线（最亮）
  grad.addColorStop(0.5, mix([54, 66, 92], [240, 246, 255]));
  // 地平线下方（地面反射）
  grad.addColorStop(0.56, mix([24, 26, 30], [120, 122, 108]));
  // 天底（地面）
  grad.addColorStop(1.0, mix([10, 11, 13], [38, 40, 34]));

  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  const tex = new THREE.CanvasTexture(canvas);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  /**
   * 环境贴图是**辐亮度**，必须按线性解读。
   * 设成 sRGB 会让 three 把它当成已编码颜色再解码一次，
   * 反射出来的天空会比真实暗一档。
   */
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
