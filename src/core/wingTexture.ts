/**
 * 机翼表面纹理（面板分割线）
 *
 * ── 为什么机翼需要这层细节 ──
 * 放样出来的机翼是一个光滑曲面，在大气散射 + bloom 的照射下
 * 会呈现「一整片均匀的灰」——这是最明显的 CG 感来源。
 *
 * 真实机翼表面由大量蒙皮壁板拼接而成，板与板之间留有细缝
 * （panel line）。这些细缝在掠射光下会产生极细的暗线，
 * 让整个曲面「有尺度感」——这是判断物体大小的关键视觉线索。
 *
 * ── 为什么用纹理而不是几何 ──
 * 用几何去刻缝需要成千上万个顶点，而且在不同距离下会闪烁。
 * 用带 mipmap 的纹理，远处自动模糊成平均值，天然抗锯齿。
 *
 * ── UV 约定 ──
 *   u = 弦向（0 = 前缘，1 = 后缘）
 *   v = 展向（0 = 翼根，1 = 翼尖）
 * 所以纹理的横轴是弦向、纵轴是展向。
 */

import * as THREE from 'three';

/** 画一条带柔和边缘的细线（模拟真实缝隙的微阴影） */
function softLine(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  width: number,
  alpha: number,
) {
  ctx.save();
  ctx.strokeStyle = `rgba(0, 0, 0, ${alpha})`;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  // 轻微模糊：真实缝隙不是硬边，而是有半影
  ctx.filter = 'blur(0.6px)';
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.restore();
}

/**
 * 生成机翼面板纹理。
 *
 * @param maxAnisotropy 硬件支持的最大各向异性过滤倍数
 * @param width  纹理宽（对应弦向）
 * @param height 纹理高（对应展向）
 */
export function createWingPanelTexture(
  maxAnisotropy = 4,
  width = 1024,
  height = 2048,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D canvas 上下文');

  // ── 底色：略偏灰的白，作为颜色乘数（1.0 = 不改变材质颜色）──
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  // ── 蒙皮整体的细微色差 ──
  // 真实机翼不同壁板的涂装老化程度不同，会有很淡的色块差异。
  // 用几个大范围的低透明度矩形来模拟，避免表面过于均匀。
  const patches: Array<[number, number, number, number, number]> = [
    // [x, y, w, h, alpha]
    [0.0, 0.0, 0.34, 0.22, 0.012],
    [0.34, 0.0, 0.3, 0.4, 0.008],
    [0.62, 0.18, 0.38, 0.3, 0.014],
    [0.0, 0.55, 0.4, 0.45, 0.009],
    [0.45, 0.7, 0.55, 0.3, 0.011],
  ];
  for (const [x, y, w, h, a] of patches) {
    ctx.fillStyle = `rgba(0, 0, 0, ${a})`;
    ctx.fillRect(x * width, y * height, w * width, h * height);
  }

  // ── 弦向面板线（纹理上是竖线）──
  //
  // ── 线宽为什么要「夸大」──
  // 真实面板缝隙只有 2~5 mm，按物理尺寸换算到纹理里约 3 px。
  // 但机翼在舷窗里只占约 270×110 屏幕像素，弦向压缩后
  // 3 px / 1024 × 110 px ≈ 0.3 屏幕像素 —— 亚像素级，
  // mipmap 直接把它抹成平均值，完全看不见。
  //
  // 所以这里必须按「视觉可读」而不是「物理真实」来定线宽：
  // 主缝 10~14 px（约 1.2~1.6 屏幕像素），次要缝 6~8 px。
  // 实测这是让面板线在舷窗距离下刚好能看出来的区间。
  const chordwiseLines: Array<[number, number, number]> = [
    // [u 位置, 线宽 px, 透明度]
    [0.055, 13, 0.42], // 缝翼后缘缝（最明显）
    [0.085, 8, 0.30], // 缝翼滑轨盖板边界
    [0.30, 7, 0.26], // 前梁检修口
    [0.48, 7, 0.24], // 中央翼盒
    [0.64, 11, 0.36], // 襟翼/扰流板铰链线
    [0.86, 7, 0.26], // 后缘检修口
    [0.94, 9, 0.32], // 襟翼后缘
  ];
  for (const [u, w, a] of chordwiseLines) {
    softLine(ctx, u * width, 0, u * width, height, w, a);
  }

  // ── 展向面板线（纹理上是横线）──
  // 真实机翼按结构分段，大约每 1.5~2 m 一道
  const spanwiseCount = 9;
  for (let i = 1; i < spanwiseCount; i++) {
    const v = i / spanwiseCount;
    softLine(ctx, 0, v * height, width, v * height, 7, 0.26);
  }

  // ── 扰流板（spoiler）面板轮廓 ──
  // 机翼上表面后段有 3~5 块扰流板，用矩形轮廓表示
  const spoilers: Array<[number, number, number, number]> = [
    // [u0, u1, v0, v1]
    [0.66, 0.84, 0.12, 0.28],
    [0.66, 0.84, 0.32, 0.48],
    [0.66, 0.84, 0.52, 0.68],
    [0.66, 0.84, 0.72, 0.88],
  ];
  for (const [u0, u1, v0, v1] of spoilers) {
    const x0 = u0 * width;
    const x1 = u1 * width;
    const y0 = v0 * height;
    const y1 = v1 * height;
    // 轮廓比普通缝略明显
    softLine(ctx, x0, y0, x1, y0, 8, 0.34);
    softLine(ctx, x1, y0, x1, y1, 8, 0.34);
    softLine(ctx, x1, y1, x0, y1, 8, 0.34);
    softLine(ctx, x0, y1, x0, y0, 8, 0.34);
  }

  // ── 襟翼滑轨盖板（flap track fairing 的根部）──
  // 机翼后缘有 3 个滑轨整流罩，在翼面上留下三条短的分割线
  const trackV = [0.22, 0.5, 0.78];
  for (const v of trackV) {
    softLine(ctx, 0.64 * width, v * height, 0.9 * width, v * height, 9, 0.30);
  }

  // ── 前缘：一条略深的带 ──
  // 前缘是铝合金裸露区（防冰带），颜色比涂装深
  const leadingGrad = ctx.createLinearGradient(0, 0, 0.055 * width, 0);
  leadingGrad.addColorStop(0, 'rgba(0, 0, 0, 0.30)');
  leadingGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = leadingGrad;
  ctx.fillRect(0, 0, 0.055 * width, height);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  // 线性过滤 + mipmap：远处自动模糊成平均值，避免面板线闪烁
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  // 颜色贴图需要 sRGB 解码
  tex.colorSpace = THREE.SRGBColorSpace;
  /**
   * ── 各向异性过滤是这层面板线能否看见的关键 ──
   * 机翼在舷窗视角下是极度掠射的：
   *   弦向 ≈ 1.7 纹素/像素（清晰）
   *   展向 ≈ 13 纹素/像素（高度压缩）
   * 比例约 8:1。如果 anisotropy 只有 4，GPU 会按最差方向
   * （13 纹素/像素 → mip 3.7 级）统一采样，
   * 结果把弦向那侧本来清晰的面板线也一起模糊掉了 ——
   * 表现就是「纹理明明画对了，但画面上什么都看不到」。
   *
   * 所以要设成硬件支持的最大值（通常 16）。
   */
  tex.anisotropy = Math.max(1, maxAnisotropy);
  tex.needsUpdate = true;

  return tex;
}
