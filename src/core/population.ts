/**
 * 人口密度图（城市灯光的引导图）
 *
 * ── 为什么要这张图，而不是纯程序化 ──
 * 真实城市的形状由河流、海岸、山脉、历史决定，纯噪声永远造不出
 * 「看起来像欧洲」的分布。原站也是这么做的：他们用一张真实的夜间
 * 灯光图（nightlights.png）作为「哪里可能有人」的概率场，
 * 只取 R 通道平方做阈值化，细节再用程序化补。
 *
 * ── 本文件的定位 ──
 * 这里提供一个**离线生成的近似图**：按真实欧洲城市的经纬度撒高斯核，
 * 再叠加分形噪声模拟村镇。它不追求精确，但能保证：
 *   - 城市位置正确（巴黎在巴黎、伦敦在伦敦）
 *   - 有「大城市连片、小城镇稀疏」的层次
 *   - 海岸线附近和山区自动稀疏（通过噪声调制）
 *
 * ── 换成真实数据 ──
 * 把 NASA Black Marble / VIIRS Day-Night Band 的夜光图裁剪到同一经纬范围，
 * 存成 public/nightlights.png，然后在 scene 里替换这张纹理即可。
 * 注意：真实数据需要做对数或平方压缩，否则大城市会糊成一片。
 */

/** 经纬范围：覆盖西欧 + 中欧 */
export const POP_LON_MIN = -12;
export const POP_LON_MAX = 32;
export const POP_LAT_MIN = 34;
export const POP_LAT_MAX = 62;

/**
 * 真实城市坐标与权重。
 * 格式：[经度, 纬度, 强度 0..1, 影响半径（度）]
 */
const CITIES: Array<[number, number, number, number]> = [
  // ── 法国及周边（观测点所在区域，密度最高）──
  [2.35, 48.86, 1.0, 0.55], // Paris
  [4.85, 45.76, 0.62, 0.3], // Lyon
  [5.37, 43.3, 0.6, 0.3], // Marseille
  [-0.58, 44.84, 0.55, 0.28], // Bordeaux
  [1.44, 43.6, 0.5, 0.26], // Toulouse
  [3.06, 50.63, 0.58, 0.28], // Lille
  [-1.55, 47.22, 0.42, 0.22], // Nantes
  [7.75, 48.58, 0.42, 0.22], // Strasbourg
  [5.04, 47.32, 0.36, 0.2], // Dijon
  [4.03, 49.26, 0.36, 0.2], // Reims
  [1.1, 49.44, 0.4, 0.22], // Rouen
  [0.11, 49.49, 0.36, 0.2], // Le Havre
  [1.9, 47.9, 0.32, 0.18], // Orléans
  [0.69, 47.39, 0.32, 0.18], // Tours
  [3.09, 45.78, 0.34, 0.18], // Clermont-Ferrand
  [3.88, 43.61, 0.4, 0.2], // Montpellier
  [7.27, 43.7, 0.4, 0.2], // Nice
  [-1.68, 48.11, 0.36, 0.2], // Rennes
  [2.35, 48.86, 0.5, 1.1], // Paris 都市圈（大范围低强度光晕）
  // ── 英国 / 爱尔兰 ──
  [-0.13, 51.51, 1.0, 0.6], // London
  [-2.24, 53.48, 0.55, 0.3], // Manchester
  [-1.9, 52.48, 0.5, 0.28], // Birmingham
  [-4.25, 55.86, 0.42, 0.24], // Glasgow
  [-3.19, 55.95, 0.36, 0.2], // Edinburgh
  [-6.26, 53.35, 0.45, 0.26], // Dublin
  [-2.99, 51.48, 0.32, 0.18], // Cardiff
  // ── 低地国家 / 德国 ──
  [4.35, 50.85, 0.55, 0.3], // Brussels
  [4.9, 52.37, 0.6, 0.32], // Amsterdam
  [4.48, 51.92, 0.42, 0.22], // Rotterdam
  [8.68, 50.11, 0.6, 0.32], // Frankfurt
  [13.4, 52.52, 0.7, 0.36], // Berlin
  [11.58, 48.14, 0.55, 0.28], // München
  [9.99, 53.55, 0.55, 0.28], // Hamburg
  [6.96, 50.94, 0.5, 0.26], // Köln
  [9.18, 48.78, 0.42, 0.22], // Stuttgart
  [9.73, 52.37, 0.4, 0.22], // Hannover
  [12.37, 51.34, 0.4, 0.22], // Leipzig
  [7.47, 51.51, 0.42, 0.24], // Ruhr
  // ── 中欧 / 东欧 ──
  [16.37, 48.21, 0.55, 0.3], // Wien
  [8.54, 47.38, 0.42, 0.22], // Zürich
  [6.14, 46.2, 0.36, 0.18], // Genève
  [14.42, 50.09, 0.5, 0.26], // Praha
  [21.01, 52.23, 0.55, 0.3], // Warszawa
  [19.04, 47.5, 0.5, 0.26], // Budapest
  [17.11, 48.15, 0.38, 0.2], // Bratislava
  [14.51, 46.06, 0.34, 0.18], // Ljubljana
  [16.37, 48.21, 0.3, 0.8], // Wien 光晕
  // ── 南欧 ──
  [9.19, 45.46, 0.6, 0.32], // Milano
  [7.69, 45.07, 0.42, 0.22], // Torino
  [12.5, 41.9, 0.6, 0.32], // Roma
  [14.25, 40.85, 0.45, 0.24], // Napoli
  [11.34, 44.49, 0.32, 0.18], // Bologna
  [12.34, 45.44, 0.34, 0.18], // Venezia
  [2.17, 41.39, 0.55, 0.3], // Barcelona
  [-3.7, 40.42, 0.65, 0.34], // Madrid
  [-0.38, 39.47, 0.42, 0.22], // Valencia
  [-5.98, 37.39, 0.42, 0.22], // Sevilla
  [-8.61, 41.15, 0.42, 0.24], // Porto
  [-9.14, 38.72, 0.5, 0.26], // Lisboa
  [23.73, 37.98, 0.5, 0.26], // Athina
  [28.98, 41.01, 0.8, 0.4], // İstanbul
  [19.82, 41.33, 0.3, 0.18], // Tirana
  // ── 北欧 ──
  [12.57, 55.68, 0.5, 0.26], // København
  [18.07, 59.33, 0.5, 0.26], // Stockholm
  [10.75, 59.91, 0.4, 0.22], // Oslo
  [24.94, 60.17, 0.4, 0.22], // Helsinki
  [12.57, 55.68, 0.3, 0.9],
];

/**
 * 生成人口密度图。
 *
 * @param width  纹理宽（对应经度范围）
 * @param height 纹理高（对应纬度范围）
 * @returns 单通道 Float32 数据，0..1
 */
export function generatePopulationMap(width = 2048, height = 1024): Float32Array {
  const data = new Float32Array(width * height);

  const lonSpan = POP_LON_MAX - POP_LON_MIN;
  const latSpan = POP_LAT_MAX - POP_LAT_MIN;

  // --- 1. 城市高斯核 ---
  for (const [lon, lat, weight, radiusDeg] of CITIES) {
    // 换算到像素坐标
    const cx = ((lon - POP_LON_MIN) / lonSpan) * width;
    const cy = ((POP_LAT_MAX - lat) / latSpan) * height;
    // 经度方向在纬度圈上会被压缩
    const rPxX = (radiusDeg / lonSpan) * width;
    const rPxY = (radiusDeg / latSpan) * height;

    const x0 = Math.max(0, Math.floor(cx - rPxX * 2.2));
    const x1 = Math.min(width - 1, Math.ceil(cx + rPxX * 2.2));
    const y0 = Math.max(0, Math.floor(cy - rPxY * 2.2));
    const y1 = Math.min(height - 1, Math.ceil(cy + rPxY * 2.2));

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = (x - cx) / rPxX;
        const dy = (y - cy) / rPxY;
        const d2 = dx * dx + dy * dy;
        if (d2 > 6) continue;
        // 核心亮、外围弱。
        // 外围拖尾要收敛：太长的尾巴会让相邻城市连成一片光海。
        const core = Math.exp(-d2 * 1.35);
        const tail = 0.22 / (1 + d2 * 3.2);
        const v = weight * Math.max(core, tail);
        const i = y * width + x;
        if (v > data[i]) data[i] = v;
      }
    }
  }

  // --- 2. 分形噪声补村镇，并按「地形阻力」调制 ---
  // 用一个低频噪声模拟宜居带（平原/沿海更密，山区/海洋更疏）
  for (let y = 0; y < height; y++) {
    // 纬度越高，同样经度跨度对应的实际距离越短 → 宜居密度略调整
    const lat = POP_LAT_MAX - (y / height) * latSpan;
    const latScale = Math.cos((lat * Math.PI) / 180);

    for (let x = 0; x < width; x++) {
      const i = y * width + x;

      // 低频「宜居度」场：模拟平原/沿海更密，山区/海洋/沙漠更疏
      const hab = fbm2(x * 0.004, y * 0.004, 4, 7);
      // 高频：小村镇的点状分布
      const vill = fbm2(x * 0.05, y * 0.05, 3, 21);

      // 宜居度低的区域几乎不点灯
      const habitability = smoothstep(0.42, 0.68, hab);

      // 关键：村镇必须「稀疏且点状」。
      // 之前用 (vill - 0.55) * 2.2 再乘 0.22，几乎所有陆地都会拿到
      // 0.05~0.2 的密度，结果高空看下去整片大地都在发光 —— 那不像地球，
      // 像一块发光的电路板。真实的高空夜景是「漆黑大地 + 零星亮点」。
      //
      // 做法：提高阈值（只保留噪声峰值）、陡峭化曲线、整体压低强度。
      const peak = Math.max(0, vill - 0.72);
      const rural = Math.pow(peak * 6.0, 2.4) * 0.30 * habitability;

      data[i] = Math.min(1, data[i] + rural * (0.6 + 0.4 * latScale));
    }
  }

  // --- 3. 对比度提升：拉开「大城市」与「村镇」的差距 ---
  // 真实夜光图的动态范围极大（巴黎 vs 小镇可差 100 倍），
  // 线性存储会让大城市的溢出光晕淹没一切。这里做一次幂次压缩。
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v <= 0.02) {
      data[i] = 0;
      continue;
    }
    // 归一化后再开方，突出弱信号；同时整体衰减
    data[i] = Math.min(1, Math.pow(v, 0.78) * 0.85);
  }

  return data;
}

// ---------------------------------------------------------------------------
// 局部噪声工具（与 shader 用的同款 value noise，保证风格一致）
// ---------------------------------------------------------------------------

function hash2i(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041);
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function vnoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2i(x0, y0, seed);
  const b = hash2i(x0 + 1, y0, seed);
  const c = hash2i(x0, y0 + 1, seed);
  const d = hash2i(x0 + 1, y0 + 1, seed);
  return (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy;
}

function fbm2(x: number, y: number, octaves: number, seed: number): number {
  let v = 0;
  let amp = 0.5;
  let norm = 0;
  let px = x;
  let py = y;
  for (let i = 0; i < octaves; i++) {
    v += amp * vnoise(px, py, seed + i * 17);
    norm += amp;
    px *= 2.03;
    py *= 2.03;
    amp *= 0.5;
  }
  return v / norm;
}
