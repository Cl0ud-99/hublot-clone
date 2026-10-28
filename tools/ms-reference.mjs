/**
 * 大气多重散射 —— 双精度 CPU 参考实现
 *
 * 目的不是「再写一遍」，而是给 GPU 侧提供三样东西：
 *   1) 数值真值：同样公式、同样的离散化，用 double 计算，排除 GPU 精度问题
 *   2) 收敛性检查：提高 LUT 分辨率 / 方向数 / 阶数，看结果差多少
 *   3) 物理标定：天顶天空辐亮度随太阳高度的曲线，对照文献中的晨昏蒙影亮度
 *
 * 用法：
 *   node tools/ms-reference.mjs             # 标准 32×32 LUT + 曲线
 *   node tools/ms-reference.mjs --hi        # 128×128 / 256 方向的高精度版
 *   node tools/ms-reference.mjs --dump      # 输出 JSON 供与其他实现对比
 */

const PI = Math.PI;

// ---------------------------------------------------------------------------
// 大气参数（必须与 src/config.ts 完全一致）
// ---------------------------------------------------------------------------
const A = {
  R: 6360,
  Rt: 6460,
  Hr: 8.0,
  Hm: 1.2,
  ozoneC: 25.0,
  ozoneW: 15.0,
  betaR: [0.00867, 0.013558, 0.0265],
  betaM: 0.003996,
  betaMAbs: 0.00444,
  betaO: [0.00277, 0.001881, 0.00026],
  g: 0.8,
};

const MS_TOP = 100;

// ---------------------------------------------------------------------------
// 基础函数
// ---------------------------------------------------------------------------

function density(h) {
  const hh = Math.max(h, 0);
  return [
    Math.exp(-hh / A.Hr),
    Math.exp(-hh / A.Hm),
    Math.exp(-(((hh - A.ozoneC) / A.ozoneW) ** 2)),
  ];
}

function sphereNearest(o, d, r) {
  const b = o[0] * d[0] + o[1] * d[1] + o[2] * d[2];
  const c = o[0] * o[0] + o[1] * o[1] + o[2] * o[2] - r * r;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  const t0 = -b - sq;
  const t1 = -b + sq;
  if (t0 > 0) return t0;
  if (t1 > 0) return t1;
  return -1;
}

function sphereFar(o, d, r) {
  const b = o[0] * d[0] + o[1] * d[1] + o[2] * d[2];
  const c = o[0] * o[0] + o[1] * o[1] + o[2] * o[2] - r * r;
  const disc = b * b - c;
  if (disc < 0) return -1;
  return -b + Math.sqrt(disc);
}

function opticalDepth(o, d, tEnd, steps) {
  if (tEnd <= 0) return [0, 0, 0];
  const ds = tEnd / steps;
  let r = 0,
    m = 0,
    z = 0;
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * ds;
    const px = o[0] + d[0] * t;
    const py = o[1] + d[1] * t;
    const pz = o[2] + d[2] * t;
    const h = Math.sqrt(px * px + py * py + pz * pz) - A.R;
    const dd = density(h);
    r += dd[0] * ds;
    m += dd[1] * ds;
    z += dd[2] * ds;
  }
  return [r, m, z];
}

function transmittance(od) {
  return [
    Math.exp(-(A.betaR[0] * od[0] + (A.betaM + A.betaMAbs) * od[1] + A.betaO[0] * od[2])),
    Math.exp(-(A.betaR[1] * od[0] + (A.betaM + A.betaMAbs) * od[1] + A.betaO[1] * od[2])),
    Math.exp(-(A.betaR[2] * od[0] + (A.betaM + A.betaMAbs) * od[1] + A.betaO[2] * od[2])),
  ];
}

const phaseR = (c) => (3 / (16 * PI)) * (1 + c * c);
function phaseM(c, g) {
  const gg = g * g;
  const denom = Math.pow(Math.max(1 + gg - 2 * g * c, 1e-4), 1.5);
  return (1 - gg) / (4 * PI * denom);
}
/** Cornette-Shanks（与 GLSL 的 phaseMieCS 一致） */
function phaseMDual(c, g) {
  const g2 = g * g;
  const k = (3 / (8 * PI)) * ((1 - g2) / (2 + g2));
  return (k * (1 + c * c)) / Math.pow(Math.max(1 + g2 - 2 * g * c, 1e-4), 1.5);
}

// ---------------------------------------------------------------------------
// LUT
// ---------------------------------------------------------------------------

export function makeLUT({
  size = 32,
  dirsFirst = 64,
  dirsHigher = 32,
  steps = 28,
  orders = 5,
  sunSteps = 6,
} = {}) {
  // lut[order][y*size+x] = [r,g,b]
  const lut = [];
  for (let o = 0; o < orders; o++) lut.push(new Float64Array(size * size * 3));

  const altitudeOf = (u) => MS_TOP * u * u;

  for (let order = 1; order <= orders; order++) {
    const prev = order > 1 ? lut[order - 2] : null;
    const nd = order === 1 ? dirsFirst : dirsHigher;
    const out = lut[order - 1];

    for (let y = 0; y < size; y++) {
      const v = (y + 0.5) / size;
      const sunCos = v * 2 - 1;
      const sinZ = Math.sqrt(Math.max(0, 1 - sunCos * sunCos));
      const sunDir = [sinZ, sunCos, 0];

      for (let x = 0; x < size; x++) {
        const u = (x + 0.5) / size;
        const h = altitudeOf(u);
        const pos = [0, A.R + h, 0];

        let ar = 0,
          ag = 0,
          ab = 0;
        for (let i = 0; i < nd; i++) {
          const fi = (i + 0.5) / nd;
          const ct = 1 - 2 * fi;
          const st = Math.sqrt(Math.max(0, 1 - ct * ct));
          const phi = i * 2.399963229728653;
          const w = [st * Math.cos(phi), ct, st * Math.sin(phi)];

          const c = msTrace(pos, w, sunDir, order, prev, size, steps, sunSteps);
          ar += c[0];
          ag += c[1];
          ab += c[2];
        }
        const idx = (y * size + x) * 3;
        out[idx] = ar / nd;
        out[idx + 1] = ag / nd;
        out[idx + 2] = ab / nd;
      }
    }
  }

  // 求和
  const total = new Float64Array(size * size * 3);
  for (let o = 0; o < orders; o++) {
    for (let i = 0; i < total.length; i++) total[i] += lut[o][i];
  }
  return { size, orders, each: lut, total };
}

function lutSample(prev, size, h, cosSunZenith) {
  // 最近邻 / 双线性都可以，这里做双线性以匹配 GPU 线性过滤
  const u = Math.sqrt(Math.max(0, Math.min(1, h / MS_TOP)));
  const v = cosSunZenith * 0.5 + 0.5;
  const fx = u * size - 0.5;
  const fy = v * size - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const cl = (i, n) => Math.max(0, Math.min(n - 1, i));
  const g = (x, y, ch) => prev[(cl(y, size) * size + cl(x, size)) * 3 + ch];
  const out = [0, 0, 0];
  for (let ch = 0; ch < 3; ch++) {
    const a = g(x0, y0, ch) * (1 - tx) + g(x0 + 1, y0, ch) * tx;
    const b = g(x0, y0 + 1, ch) * (1 - tx) + g(x0 + 1, y0 + 1, ch) * tx;
    out[ch] = a * (1 - ty) + b * ty;
  }
  return out;
}

function msTrace(pos, dir, sunDir, order, prev, size, steps, sunSteps) {
  const tGround = sphereNearest(pos, dir, A.R);
  const tAtmo = sphereFar(pos, dir, A.Rt);
  if (tAtmo <= 0) return [0, 0, 0];
  const tMax = tGround > 0 ? Math.min(tGround, tAtmo) : tAtmo;
  if (tMax <= 0) return [0, 0, 0];

  const cosTheta = dir[0] * sunDir[0] + dir[1] * sunDir[1] + dir[2] * sunDir[2];
  const pR = phaseR(cosTheta);
  const pM = phaseMDual(cosTheta, A.g);

  let sr = 0,
    sg = 0,
    sb = 0;
  let odR = 0,
    odM = 0,
    odO = 0;

  for (let i = 0; i < steps; i++) {
    const a = i / steps;
    const b = (i + 1) / steps;
    const t0 = tMax * a * a;
    const t1 = tMax * b * b;
    const ds = t1 - t0;
    if (ds <= 0) continue;
    const tm = 0.5 * (t0 + t1);
    const p = [pos[0] + dir[0] * tm, pos[1] + dir[1] * tm, pos[2] + dir[2] * tm];
    const h = Math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]) - A.R;
    const dd = density(h);
    odR += dd[0] * ds;
    odM += dd[1] * ds;
    odO += dd[2] * ds;
    const vt = transmittance([odR, odM, odO]);

    let s0, s1, s2;
    if (order === 1) {
      const tSun = sphereFar(p, sunDir, A.Rt);
      let st = transmittance(opticalDepth(p, sunDir, tSun, sunSteps));
      if (sphereNearest(p, sunDir, A.R) > 0) st = [0, 0, 0];
      s0 = (A.betaR[0] * dd[0] * pR + A.betaM * dd[1] * pM) * st[0];
      s1 = (A.betaR[1] * dd[0] * pR + A.betaM * dd[1] * pM) * st[1];
      s2 = (A.betaR[2] * dd[0] * pR + A.betaM * dd[1] * pM) * st[2];
    } else {
      const pl = Math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]);
      const cosZ = (p[0] * sunDir[0] + p[1] * sunDir[1] + p[2] * sunDir[2]) / pl;
      const f = lutSample(prev, size, h, cosZ);
      s0 = (A.betaR[0] * dd[0] + A.betaM * dd[1]) * f[0];
      s1 = (A.betaR[1] * dd[0] + A.betaM * dd[1]) * f[1];
      s2 = (A.betaR[2] * dd[0] + A.betaM * dd[1]) * f[2];
    }
    sr += s0 * vt[0] * ds;
    sg += s1 * vt[1] * ds;
    sb += s2 * vt[2] * ds;
  }
  return [sr, sg, sb];
}

// ---------------------------------------------------------------------------
// 天空辐亮度（与 atmosphere.glsl 的 skyRadiance 对应）
// ---------------------------------------------------------------------------

export function skyRadiance(lut, camPos, rayDir, sunDir, sunColor, steps = 16, msMode = 1) {
  const tGround = sphereNearest(camPos, rayDir, A.R);
  const tAtmo = sphereFar(camPos, rayDir, A.Rt);
  if (tAtmo <= 0) return [0, 0, 0];
  const tMax = tGround > 0 ? tGround : tAtmo;
  if (tMax <= 0) return [0, 0, 0];

  const cosTheta =
    rayDir[0] * sunDir[0] + rayDir[1] * sunDir[1] + rayDir[2] * sunDir[2];
  const pR = phaseR(cosTheta);
  const pM = phaseMDual(cosTheta, A.g);

  let sum = [0, 0, 0];
  let odR = 0,
    odM = 0,
    odO = 0;

  for (let i = 0; i < steps; i++) {
    const a = i / steps;
    const b = (i + 1) / steps;
    const t0 = tMax * a * a;
    const t1 = tMax * b * b;
    const ds = t1 - t0;
    if (ds <= 0) continue;
    const tm = 0.5 * (t0 + t1);
    const p = [
      camPos[0] + rayDir[0] * tm,
      camPos[1] + rayDir[1] * tm,
      camPos[2] + rayDir[2] * tm,
    ];
    const h = Math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]) - A.R;
    const dd = density(h);
    odR += dd[0] * ds;
    odM += dd[1] * ds;
    odO += dd[2] * ds;
    const vt = transmittance([odR, odM, odO]);

    // 多次散射
    let ms = [0, 0, 0];
    if (msMode > 0 && lut) {
      const pl = Math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]);
      const cosZ =
        (p[0] * sunDir[0] + p[1] * sunDir[1] + p[2] * sunDir[2]) / pl;
      const f = lutSample(lut.total, lut.size, h, cosZ);
      ms = [
        (A.betaR[0] * dd[0] + A.betaM * dd[1]) * f[0],
        (A.betaR[1] * dd[0] + A.betaM * dd[1]) * f[1],
        (A.betaR[2] * dd[0] + A.betaM * dd[1]) * f[2],
      ];
    }

    if (msMode === 2) {
      sum[0] += ms[0] * vt[0] * ds;
      sum[1] += ms[1] * vt[1] * ds;
      sum[2] += ms[2] * vt[2] * ds;
      continue;
    }

    const tSun = sphereFar(p, sunDir, A.Rt);
    let st = transmittance(opticalDepth(p, sunDir, tSun, 6));
    if (sphereNearest(p, sunDir, A.R) > 0) st = [0, 0, 0];

    const s0 = A.betaR[0] * dd[0] * pR + A.betaM * dd[1] * pM;
    const s1 = A.betaR[1] * dd[0] * pR + A.betaM * dd[1] * pM;
    const s2 = A.betaR[2] * dd[0] * pR + A.betaM * dd[1] * pM;

    sum[0] += (s0 * st[0] * ds + ms[0] * ds) * vt[0];
    sum[1] += (s1 * st[1] * ds + ms[1] * ds) * vt[1];
    sum[2] += (s2 * st[2] * ds + ms[2] * ds) * vt[2];
  }

  return [
    sum[0] * sunColor[0],
    sum[1] * sunColor[1],
    sum[2] * sunColor[2],
  ];
}

// ---------------------------------------------------------------------------
// 独立的方位角工具（太阳高度 → 方向）
// ---------------------------------------------------------------------------

/** 以「太阳高度角（度）」构造一组测试用的太阳方向 / 相机方向 */
export function sunDirFromAltitude(altDeg, azimuthDeg = 0) {
  const alt = (altDeg * PI) / 180;
  const az = (azimuthDeg * PI) / 180;
  return [Math.sin(az) * Math.cos(alt), Math.sin(alt), -Math.cos(az) * Math.cos(alt)];
}

/** 由仰角 + 方位角构造视线方向（本地坐标：y 向上） */
export function viewDir(elevDeg, azimuthDeg = 0) {
  const e = (elevDeg * PI) / 180;
  const a = (azimuthDeg * PI) / 180;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)];
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && process.argv[1].endsWith('ms-reference.mjs');

if (isMain) {
  const hi = process.argv.includes('--hi');
  const t0 = Date.now();
  const opts = hi
    ? { size: 96, dirsFirst: 192, dirsHigher: 96, steps: 96, orders: 6, sunSteps: 12 }
    : { size: 32, dirsFirst: 64, dirsHigher: 32, steps: 28, orders: 5, sunSteps: 6 };
  console.log(`生成 LUT: ${opts.size}², dirs=${opts.dirsFirst}/${opts.dirsHigher}, steps=${opts.steps}, orders=${opts.orders}`);
  const lut = makeLUT(opts);
  console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  // --- 各阶收敛情况（取 h=10.4km, 太阳高度 -5.33°）---
  const uu = Math.sqrt(10.4 / MS_TOP);
  const xi = Math.min(opts.size - 1, Math.round(uu * opts.size - 0.5));
  const sunCos = Math.sin((-5.33 * PI) / 180);
  const yi = Math.min(opts.size - 1, Math.round((sunCos * 0.5 + 0.5) * opts.size - 0.5));
  console.log('\n各阶在 (h=10.4km, 太阳 -5.33°) 处的值：');
  let acc = [0, 0, 0];
  for (let o = 0; o < opts.orders; o++) {
    const idx = (yi * opts.size + xi) * 3;
    const v = [lut.each[o][idx], lut.each[o][idx + 1], lut.each[o][idx + 2]];
    acc = [acc[0] + v[0], acc[1] + v[1], acc[2] + v[2]];
    console.log(
      `  F${o + 1}: ${v.map((x) => x.toExponential(3)).join('  ')}   累计 ${acc.map((x) => x.toExponential(3)).join('  ')}`,
    );
  }

  // --- 天顶天空辐亮度 vs 太阳高度 ---
  const E = [16 * 1.7 / 2.03, 16 * 1.85 / 2.03, 16];
  const camPos = [0, A.R + 10.4, 0];
  console.log('\n天顶天空辐亮度（线性，E=16 归一化）：');
  console.log('太阳高度   单次散射                多次散射                合计');
  for (const alt of [20, 10, 5, 2, 0, -2, -4, -5.33, -6, -8, -10, -12, -15, -18]) {
    const sd = sunDirFromAltitude(alt);
    const vd = [0, 1, 0];
    const s1 = skyRadiance(lut, camPos, vd, sd, E, 24, 0);
    const s2 = skyRadiance(lut, camPos, vd, sd, E, 24, 2);
    const tot = skyRadiance(lut, camPos, vd, sd, E, 24, 1);
    console.log(
      `${String(alt).padStart(6)}   ${s1.map((x) => x.toExponential(2)).join(' ')}   ${s2.map((x) => x.toExponential(2)).join(' ')}   ${tot.map((x) => x.toExponential(2)).join(' ')}`,
    );
  }

  if (process.argv.includes('--dump')) {
    console.log('\n--dump LUT JSON');
    const obj = {
      size: opts.size,
      total: Array.from(lut.total),
      each: lut.each.map((a) => Array.from(a)),
    };
    console.log(JSON.stringify(obj));
  }
}
