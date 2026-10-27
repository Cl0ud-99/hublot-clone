/**
 * 太阳位置求解
 *
 * 目标：给定「巴黎当地时间」与站点经纬度，算出太阳方向。
 *
 * 精度要求：不要用完整 NREL SPA（那有上千行）。这里用两组足够好的近似：
 *   1. 赤纬 + 时角（Cooper 公式 + 均时差）
 *   2. 转换成地平坐标系（方位角/高度角）
 *
 * 在本项目的时间窗口（6:00–10:30，10 月下旬的巴黎）里，误差在 ~1° 内，
 * 肉眼完全不可分辨。
 */

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

export type SunDir = {
  /** 单位向量，y 向上，x 向东，z 向南（three.js 右手系，-z 为北） */
  direction: [number, number, number];
  /** 高度角（度） */
  altitudeDeg: number;
  /** 方位角（度，从北顺时针） */
  azimuthDeg: number;
};

/**
 * 一年中的第几天（1–366）。
 */
function dayOfYear(year: number, month: number, day: number): number {
  const start = Date.UTC(year, 0, 0);
  const now = Date.UTC(year, month - 1, day);
  return Math.floor((now - start) / 86400000);
}

/**
 * 均时差（分钟）。Spencer 公式，误差 < 30 秒。
 */
function equationOfTime(n: number): number {
  const b = ((n - 1) * 2 * Math.PI) / 364;
  return (
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(b) -
      0.032077 * Math.sin(b) -
      0.014615 * Math.cos(2 * b) -
      0.040849 * Math.sin(2 * b))
  );
}

/**
 * 太阳赤纬（弧度）。Cooper 公式。
 */
function solarDeclination(n: number): number {
  return 23.45 * DEG * Math.sin(((2 * Math.PI) / 365) * (284 + n));
}

/**
 * 计算太阳方向。
 *
 * @param hour    当地时间（小时，含小数）
 * @param latDeg  纬度（度，北正）
 * @param lonDeg  经度（度，东正）
 * @param timezoneHours 时区偏移（法国夏令时 +2，冬令时 +1）
 * @param date    用于取日期（默认现在）
 */
export function computeSun(
  hour: number,
  latDeg: number,
  lonDeg: number,
  timezoneHours = 2,
  date: Date = new Date(),
): SunDir {
  const n = dayOfYear(date.getFullYear(), date.getMonth() + 1, date.getDate());
  const decl = solarDeclination(n);
  const eot = equationOfTime(n); // 分钟

  // 真太阳时（分钟）
  const solarTime = hour * 60 + eot + 4 * lonDeg - 60 * timezoneHours;
  // 时角（度 → 弧度），正午为 0，下午为正
  const hourAngle = ((solarTime / 4 - 180) % 360) * DEG;

  const lat = latDeg * DEG;

  // 地平坐标
  const sinAlt =
    Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle);
  const altitude = Math.asin(Math.max(-1, Math.min(1, sinAlt)));

  const cosAz =
    (Math.sin(decl) - Math.sin(altitude) * Math.sin(lat)) / (Math.cos(altitude) * Math.cos(lat));
  let azimuth = Math.acos(Math.max(-1, Math.min(1, cosAz))); // 从北起算
  if (hourAngle > 0) azimuth = 2 * Math.PI - azimuth; // 下午转向西

  // 转成 three.js 向量（x 东，y 上，z 南；北 = -z）
  // 方位角从北顺时针：az=0 → -z；az=90° → +x
  const dir: [number, number, number] = [
    Math.sin(azimuth) * Math.cos(altitude),
    Math.sin(altitude),
    -Math.cos(azimuth) * Math.cos(altitude),
  ];

  return {
    direction: dir,
    altitudeDeg: altitude * RAD,
    azimuthDeg: azimuth * RAD,
  };
}

/**
 * 太阳辐照度（线性 RGB）。
 *
 * ── 尺度是怎么定的 ──
 * 这个常数不能随便取，它决定了整幅画面的曝光基准。推导过程：
 *
 *   地面朗伯辐射  L = E · cosθ / π · albedo
 *   取正午 cosθ≈0.9、albedo≈0.12，希望 L ≈ 0.55（线性）
 *   （0.55 经 ACES 后约 0.65，再经 sRGB 编码约 0.82，即明亮但不过曝）
 *   ⇒ E = 0.55 · π / (0.9 · 0.12) ≈ 16
 *
 * 反过来验证天空：该尺度下天顶散射辐亮度约 (0.027, 0.047, 0.097)，
 * 经 ACES + sRGB 得到约 RGB(35, 57, 97) —— 正是晴空天顶该有的深蓝。
 *
 * 如果用原站那种 E≈100 的量级（他们的内部管线有自己的归一化），
 * 地面会算到 3.4，ACES 之后直接死白，层次全丢。
 *
 * 地平线以下平滑衰减（保留暮光），-8° 以下完全熄灭。
 */
export function sunIrradiance(altitudeDeg: number): [number, number, number] {
  // 基准辐照度（蓝色通道 = 16，见上面的标定推导）
  const SUN_IRRADIANCE_SCALE = 16.0;
  const norm = SUN_IRRADIANCE_SCALE / 2.03;
  const base: [number, number, number] = [1.7 * norm, 1.85 * norm, 2.03 * norm];

  // 接近地平线时大气路径变长 → 瑞利散射把蓝光散射掉 → 偏红
  const t = Math.max(0, Math.min(1, altitudeDeg / 12));
  const r = base[0];
  const g = base[1] * (0.55 + 0.45 * t);
  const b = base[2] * (0.25 + 0.75 * t * t);

  // 地平线以下的平滑过渡：-8° 完全熄灭
  const visible = Math.max(0, Math.min(1, (altitudeDeg + 8) / 10));
  const fade = visible * visible * (3 - 2 * visible); // smoothstep

  return [r * fade, g * fade, b * fade];
}

/**
 * 给 UI 用的时间格式化。
 */
export function formatHour(hour: number): string {
  const h = Math.floor(hour) % 24;
  const m = Math.floor((hour % 1) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
