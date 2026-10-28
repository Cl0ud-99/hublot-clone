/**
 * 机翼表面纹理（颜色 / 法线 / 粗糙度）
 *
 * ── 为什么机翼需要这层细节 ──
 * 放样出来的机翼是一个光滑曲面，在大气散射 + bloom 的照射下
 * 会呈现「一整片均匀的灰」——这是最明显的 CG 感来源。
 *
 * ── 为什么光有颜色贴图还不够（塑料感的根源）──
 * 只画颜色的话，面板缝只是一条「暗线」：法线没变、粗糙度没变。
 * 光照打在它上面和打在平面上完全一样，所以缝看起来像印上去的，
 * 整个机翼像一块印花塑料板。
 *
 * 真实蒙皮缝隙是**凹槽**，它同时改变三件事：
 *   1) 颜色：缝底进阴影 → 暗
 *   2) 法线：凹槽的两壁朝向不同 → 掠射光下有明暗对比
 *   3) 粗糙度：缝里积灰 + 没漆 → 更粗糙，高光散开
 *
 * 所以这里从**同一套布局**派生出三张图：颜色、法线、粗糙度。
 *
 * ── UV 约定 ──
 *   u = 弦向（0 = 前缘，1 = 后缘）
 *   v = 展向（0 = 翼根，1 = 翼尖）
 */

import * as THREE from 'three';

/** 绘制模式：颜色贴图 / 高度图（高度图再转成法线与粗糙度） */
type DrawMode = 'color' | 'height';

/**
 * 画一条「凹缝」。
 *
 * ── 为什么不能只画一条黑线 ──
 * 只加深黑线会让机翼看起来像用马克笔描过边，是典型的「卡通化」翻车。
 *
 * @param highlight 是否加一侧亮边（只有主缝需要）
 */
function softLine(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  width: number,
  alpha: number,
  highlight = false,
) {
  ctx.save();
  ctx.lineCap = 'round';

  // 暗缝本体
  ctx.strokeStyle = `rgba(0, 0, 0, ${alpha})`;
  ctx.lineWidth = width;
  // 轻微模糊：真实缝隙不是硬边，而是有半影
  ctx.filter = 'blur(0.6px)';
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  if (highlight) {
    // 亮边：沿垂直于线段的方向偏移约 0.7 个线宽
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const off = width * 0.7;

    ctx.strokeStyle = `rgba(255, 255, 255, ${alpha * 0.85})`;
    ctx.lineWidth = Math.max(1.5, width * 0.45);
    ctx.filter = 'blur(0.8px)';
    ctx.beginPath();
    ctx.moveTo(x1 + nx * off, y1 + ny * off);
    ctx.lineTo(x2 + nx * off, y2 + ny * off);
    ctx.stroke();
  }

  ctx.restore();
}

/** 高度图上的缝：纯黑 = 凹到底 */
function heightLine(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  width: number,
  depth = 1.0,
) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = `rgba(0, 0, 0, ${depth})`;
  ctx.lineWidth = width;
  ctx.filter = 'blur(0.8px)';
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.restore();
}

/**
 * 在给定 canvas 上绘制整套面板布局。
 *
 * 颜色模式和高度模式共用同一个布局，保证三张贴图的缝隙**严丝合缝**
 * ——否则法线凹凸和颜色暗线会错位，比不加还难看。
 */
function drawPanelLayout(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  mode: DrawMode,
) {
  const isColor = mode === 'color';

  /**
   * ── 底色 ──
   * 颜色模式：纯白，作为 color 的乘数（1.0 = 不改变材质颜色）
   * 高度模式：0xE8（0.91），给缝留出向下凹的余量 ——
   *   如果底色就是 1.0，凹缝没有向上凸的对比，法线会显得「只有沟没有包边」。
   */
  ctx.fillStyle = isColor ? '#ffffff' : '#e8e8e8';
  ctx.fillRect(0, 0, width, height);

  // ── 蒙皮整体的细微色差（只影响颜色）──
  if (isColor) {
    const patches: Array<[number, number, number, number, number]> = [
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
  }

  /**
   * ── 弦向面板线（纹理上是竖线）──
   *
   * 线宽是「按视觉可读」而不是「物理真实」定的：
   * 真实缝隙 2~5 mm，换算到纹理约 3 px，但机翼在舷窗里只占约
   * 270×110 屏幕像素，弦向压缩后 3px/1024×110 ≈ 0.3 屏幕像素 ——
   * 亚像素级，mipmap 直接抹平。所以必须夸大到 9~15 px。
   */
  const chordwiseLines: Array<[number, number, number, boolean]> = [
    [0.055, 15, 0.68, true], // 缝翼后缘缝（最明显）
    [0.085, 10, 0.48, true], // 缝翼滑轨盖板边界
    [0.30, 9, 0.44, false],  // 前梁检修口
    [0.48, 9, 0.42, false],  // 中央翼盒
    [0.64, 13, 0.60, true],  // 襟翼/扰流板铰链线
    [0.86, 9, 0.44, false],  // 后缘检修口
    [0.94, 11, 0.52, true],  // 襟翼后缘
  ];
  for (const [u, w, a, hl] of chordwiseLines) {
    if (isColor) {
      softLine(ctx, u * width, 0, u * width, height, w, a, hl);
    } else {
      heightLine(ctx, u * width, 0, u * width, height, w);
    }
  }

  // ── 展向面板线（纹理上是横线）──
  const spanwiseCount = 9;
  for (let i = 1; i < spanwiseCount; i++) {
    const v = i / spanwiseCount;
    if (isColor) {
      softLine(ctx, 0, v * height, width, v * height, 9, 0.48, i % 3 === 0);
    } else {
      heightLine(ctx, 0, v * height, width, v * height, 9);
    }
  }

  // ── 扰流板面板轮廓 ──
  const spoilers: Array<[number, number, number, number]> = [
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
    if (isColor) {
      softLine(ctx, x0, y0, x1, y0, 10, 0.55, true);
      softLine(ctx, x1, y0, x1, y1, 10, 0.55, true);
      softLine(ctx, x1, y1, x0, y1, 10, 0.55, true);
      softLine(ctx, x0, y1, x0, y0, 10, 0.55, true);
    } else {
      heightLine(ctx, x0, y0, x1, y0, 10);
      heightLine(ctx, x1, y0, x1, y1, 10);
      heightLine(ctx, x1, y1, x0, y1, 10);
      heightLine(ctx, x0, y1, x0, y0, 10);
    }
  }

  // ── 襟翼滑轨盖板分割线 ──
  const trackV = [0.22, 0.5, 0.78];
  for (const v of trackV) {
    if (isColor) {
      softLine(ctx, 0.64 * width, v * height, 0.9 * width, v * height, 11, 0.5, true);
    } else {
      heightLine(ctx, 0.64 * width, v * height, 0.9 * width, v * height, 11);
    }
  }

  // ── 前缘防冰带：表面有一层明显的凹槽（只做颜色）──
  if (isColor) {
    const leadingGrad = ctx.createLinearGradient(0, 0, 0.055 * width, 0);
    leadingGrad.addColorStop(0, 'rgba(0, 0, 0, 0.45)');
    leadingGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = leadingGrad;
    ctx.fillRect(0, 0, 0.055 * width, height);
  }
}

/** 统一设置纹理过滤参数（三张图共用） */
function tuneTexture(tex: THREE.Texture, maxAnisotropy: number, srgb: boolean) {
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  /**
   * ── 各向异性是面板线能否看见的关键 ──
   * 机翼在舷窗视角下极度掠射：弦向 ≈ 1.7 纹素/像素，展向 ≈ 13。
   * 比例 8:1。anisotropy 只有 4 时 GPU 按最差方向选 mip，
   * 会把弦向本来清晰的面板线一起糊掉 —— 表现就是
   * 「纹理明明画对了，但画面上什么都看不到」。
   */
  tex.anisotropy = Math.max(1, maxAnisotropy);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
}

/**
 * 从高度图生成法线贴图（Sobel 梯度）。
 *
 * @param strength 凹凸强度。0.8 左右既有立体感又不会出现假浮雕。
 */
function heightToNormal(
  src: HTMLCanvasElement,
  strength: number,
): THREE.CanvasTexture {
  const w = src.width;
  const h = src.height;
  const sctx = src.getContext('2d');
  if (!sctx) throw new Error('height canvas has no ctx');
  const srcData = sctx.getImageData(0, 0, w, h).data;

  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const octx = out.getContext('2d');
  if (!octx) throw new Error('normal canvas has no ctx');
  const img = octx.createImageData(w, h);
  const dst = img.data;

  const at = (x: number, y: number) => {
    const xx = x < 0 ? 0 : x >= w ? w - 1 : x;
    const yy = y < 0 ? 0 : y >= h ? h - 1 : y;
    return srcData[(yy * w + xx) * 4] / 255;
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Sobel
      const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
      const l = at(x - 1, y), r = at(x + 1, y);
      const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);

      const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);

      // 切线空间法线：(−dx, −dy, 1) 归一化后映射到 0..1
      let nx = -dx * strength;
      let ny = -dy * strength;
      const len = Math.hypot(nx, ny, 1);
      nx /= len;
      ny /= len;
      const nz = 1 / len;

      const i = (y * w + x) * 4;
      dst[i] = Math.round((nx * 0.5 + 0.5) * 255);
      dst[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      dst[i + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      dst[i + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(out);
  // 法线贴图是纯数据，不能做 sRGB 解码
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

/**
 * 从高度图生成粗糙度贴图。
 *
 * 缝里积灰 + 没漆 → 粗糙（0.88）；平整蒙皮是光滑涂装（0.32）。
 * 这会让人字缝在掠射光下的高光「断掉」，是塑料感消失的关键之一。
 */
function heightToRoughness(
  src: HTMLCanvasElement,
): THREE.CanvasTexture {
  const w = src.width;
  const h = src.height;
  const sctx = src.getContext('2d');
  if (!sctx) throw new Error('height canvas has no ctx');
  const srcData = sctx.getImageData(0, 0, w, h).data;

  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const octx = out.getContext('2d');
  if (!octx) throw new Error('roughness canvas has no ctx');
  const img = octx.createImageData(w, h);
  const dst = img.data;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const heightV = srcData[i] / 255;
      // 高度 1（平面）→ 0.46；高度 0（缝底）→ 0.88
      const rough = 0.46 + (1 - heightV) * 0.42;
      dst[i] = 255;
      dst[i + 1] = Math.round(rough * 255); // three 的 roughnessMap 用 G 通道
      dst[i + 2] = 0; // metalnessMap 用 B 通道：涂装是绝缘层
      dst[i + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(out);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

export type WingSurfaceMaps = {
  /** 颜色乘数（白底 + 暗缝） */
  color: THREE.CanvasTexture;
  /** 切线空间法线 */
  normal: THREE.CanvasTexture;
  /** G = roughness，B = metalness(0) */
  roughness: THREE.CanvasTexture;
};

/**
 * 生成机翼的整套表面贴图。
 *
 * 尺寸：颜色 1024×2048，法线/粗糙度 512×1024。
 * 法线用一半分辨率是刻意的 —— 凹凸是低频信息，减半能省 75% 的内存，
 * 视觉上看不出差别（缝隙本身就有 blur）。
 */
export function createWingSurfaceMaps(maxAnisotropy = 4): WingSurfaceMaps {
  const W = 1024;
  const H = 2048;

  // --- 颜色 ---
  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = W;
  colorCanvas.height = H;
  const cctx = colorCanvas.getContext('2d');
  if (!cctx) throw new Error('无法创建 2D canvas 上下文');
  drawPanelLayout(cctx, W, H, 'color');
  const color = new THREE.CanvasTexture(colorCanvas);
  tuneTexture(color, maxAnisotropy, true);

  // --- 高度（中间产物）---
  const HW = 512;
  const HH = 1024;
  const heightCanvas = document.createElement('canvas');
  heightCanvas.width = HW;
  heightCanvas.height = HH;
  // willReadFrequently：高度图会被 getImageData 读两次（算法线 + 算粗糙度），
  // 不加这个标志浏览器会用 GPU 后端存画布，读回时每次都要同步，启动会卡一下。
  const hctx = heightCanvas.getContext('2d', { willReadFrequently: true });
  if (!hctx) throw new Error('无法创建 2D canvas 上下文');
  // 线宽按分辨率比例缩放，保证和颜色图的缝**同宽**
  hctx.save();
  hctx.scale(HW / W, HH / H);
  drawPanelLayout(hctx, W, H, 'height');
  hctx.restore();

  // --- 法线 ---
  const normal = heightToNormal(heightCanvas, 0.9);
  tuneTexture(normal, maxAnisotropy, false);

  // --- 粗糙度 ---
  const roughness = heightToRoughness(heightCanvas);
  tuneTexture(roughness, maxAnisotropy, false);

  return { color, normal, roughness };
}

/** 兼容旧接口：只要颜色图。 */
export function createWingPanelTexture(
  maxAnisotropy = 4,
  _width = 1024,
  _height = 2048,
): THREE.CanvasTexture {
  return createWingSurfaceMaps(maxAnisotropy).color;
}
