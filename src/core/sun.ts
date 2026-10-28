/**
 * 太阳位置求解
 *
 * ── 为什么改成「照抄原站公式」而不是天文算法 ──
 * 早期版本用的是 Cooper 公式 + 均时差 + 真太阳时，物理上更「正确」，
 * 但和原站对不上：同一个 time=7.08，我们算出太阳高度 -5.3°，
 * 原站是 -11.7°，差了 6.4°。暮光正好落在这个区间里，
 * 差 6° 就是「灰蓝」和「橙金」的区别。
 *
 * 原站的实现（从线上 bundle 逆向，变量名已还原）：
 *
 *   const M9 = 47.15 * DEG;                                  // 纬度
 *   const N9 = -asin(0.39779 * cos(0.98565*DEG*298
 *                                  + 1.914*DEG*sin(0.98565*DEG*286)));
 *   const _Se = -2 + 2.2/15 + 14.2/60;                       // 时区+经度+均时差
 *   const t = (hour + _Se - 12) * 15 * DEG;                  // 时角
 *   el = asin(sin(M9)sin(N9) + cos(M9)cos(N9)cos(t));
 *   az = atan2(sin(t), cos(t)sin(M9) - tan(N9)cos(M9)) + PI;
 *
 * 注意日期是**写死的第 298 天**（10 月 25 日）。原站不跟随系统日期 ——
 * 这很重要：如果跟随 `new Date()`，同一时刻在 6 月和 10 月能差 40° 太阳高度，
 * 整个默认观感就完全不可复现了。
 *
 * ── 关键：太阳方位是相对舷窗定义的 ──
 * 原站把太阳方向直接写进着色器世界的相机坐标系：
 *
 *   const _ = az - PI;                 // ySe = 180°
 *   sunDir = (cos(_)*cos(el), sin(el), sin(_)*cos(el));
 *
 * 也就是说，「az = 90°（正东）」映射到着色器世界的 -Z，
 * 而 -Z 正是 yaw = 0 时相机看出去的方向。
 * 结果就是：**日出永远发生在舷窗正前方**，默认 yaw = -18° 把它推到画面右侧，
 * 正好压着窗框边缘 —— 和原站截图完全一致。
 *
 * 我们之前把太阳放在真实地理坐标系里，默认视角在太阳反方向 123°，
 * 于是暮光再物理也看不见（反日点天顶辐亮度只有 5e-5，本该接近全黑）。
 */

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** 观测点纬度（度）。REV */
const SITE_LAT_DEG = 47.15;
/** 写死的儒略日序号（10 月 25 日）。REV: 原站用 298 */
const FIXED_DAY_OF_YEAR = 298;
/** 时区 + 经度 + 均时差（小时）。REV: -2 + 2.2/15 + 14.2/60 */
const TIME_OFFSET_H = -2 + 2.2 / 15 + 14.2 / 60;

export type SunDir = {
  /** 高度角（度） */
  elevationDeg: number;
  /** 方位角（度，从北顺时针）。注意：这是相对舷窗坐标系的方位，不是地理方位 */
  azimuthDeg: number;
};

/**
 * 计算太阳位置。
 *
 * @param hour 当地时间（小时，含小数）
 */
export function computeSun(hour: number): SunDir {
  const lat = SITE_LAT_DEG * DEG;
  // 赤纬（弧度）。原站把符号取反，但方位角又 +PI，两者不抵消 ——
  // 这里原样保留，因为要复现的是他们的画面，不是天文年历。
  const decl = -Math.asin(
    0.39779 *
      Math.cos(
        0.98565 * DEG * FIXED_DAY_OF_YEAR +
          1.914 * DEG * Math.sin(0.98565 * DEG * (FIXED_DAY_OF_YEAR - 2)),
      ),
  );

  const t = (hour + TIME_OFFSET_H - 12) * 15 * DEG;

  const sinEl =
    Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(t);
  const elevation = Math.asin(Math.max(-1, Math.min(1, sinEl)));

  const azimuth =
    Math.atan2(
      Math.sin(t),
      Math.cos(t) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat),
    ) + Math.PI;

  return {
    elevationDeg: elevation * RAD,
    azimuthDeg: azimuth * RAD,
  };
}

/**
 * 太阳方向在「舷窗参考坐标系」里的分量。
 *
 * 坐标系（与着色器世界一致）：
 *   X = yaw=0 时屏幕右方
 *   Y = 本地天顶
 *   -Z = yaw=0 时视线方向
 *
 * 这个函数只返回无量纲分量 (x, y, z)，由调用方用相机基向量映射到世界。
 */
export function sunDirectionInWindowFrame(sun: SunDir): [number, number, number] {
  const el = sun.elevationDeg * DEG;
  const rel = sun.azimuthDeg * DEG - Math.PI; // ySe = 180°
  return [Math.cos(rel) * Math.cos(el), Math.sin(el), Math.sin(rel) * Math.cos(el)];
}

/**
 * 太阳辐照度（线性 RGB）—— 大气层外（TOA）的常数。
 *
 * 早期版本在这里按太阳高度做了一次「经验红化 + -8° 以下熄灯」，
 * 但着色器内部已经按真实路径长度算了 atmosphereTransmittance()，
 * 同一份消光被乘了两次。现在只返回大气层外的辐照度，
 * 所有消光、红化、地球本影都交给 atmosphere.glsl 的物理模型。
 *
 * 尺度标定：地面朗伯辐射 L = E·cosθ/π·albedo，
 * 取正午 cosθ≈0.9、albedo≈0.12，希望 L≈0.55 ⇒ E≈16。
 *
 * @param _elevationDeg 保留参数以兼容调用方；物理上不再使用
 */
export function sunIrradiance(_elevationDeg: number): [number, number, number] {
  const SUN_IRRADIANCE_SCALE = 16.0;
  const norm = SUN_IRRADIANCE_SCALE / 2.03;
  return [1.7 * norm, 1.85 * norm, 2.03 * norm];
}

/**
 * 相机自动曝光（EV）。
 *
 * ── 为什么必须有 ──
 * 从正午到民用暮光，天空辐亮度的跨度约 5 个数量级（1e-1 → 1e-6）。
 * 固定曝光不可能同时照顾两头：要么白天死白，要么暮光全黑。
 * 真实相机/人眼都在做这件事（眼睛的暗适应跨 6 个数量级）。
 *
 * 原站面板里的 Exposure 是「手动偏移」，底层同样有一条随昼夜变化的曲线，
 * 否则他们不可能在 time=7.08（太阳 -11.7°）拍到那样明亮的橙色地平线。
 *
 * 曲线按太阳高度分段（数值是用 tools/ms-reference.mjs 算出的地平线辐亮度
 * 反推的：目标是让「太阳方位的地平线」在屏幕上始终落在 0.15~0.25 线性区间）：
 *
 *   太阳高度      地平线辐亮度      曝光 EV
 *     +12°         0.7             0
 *       0°         0.26            1.0
 *      -3°         0.07            1.0
 *      -6°         0.011           3.9
 *     -12°         2.2e-4          9.3
 *     -18°         1e-8            11（上限）
 *
 * 注意 -3° 到 0° 这一段刻意压平：日出瞬间地平线辐亮度变化极快，
 * 如果曝光跟着线性追，画面会「呼吸」得很明显。压平这一段相当于
 * 相机的曝光已经锁死，让太阳自己把画面提亮 —— 这也是真实拍摄的做法。
 */
export function autoExposureEV(elevationDeg: number): number {
  const alt = elevationDeg;
  if (alt >= 12) return 0;
  if (alt >= 0) return 0.6 * ((12 - alt) / 12);
  const ev = 0.6 + Math.max(0, -alt - 3) * 0.95;
  return Math.min(ev, 9);
}

/**
 * 给 UI 用的时间格式化。
 */
export function formatHour(hour: number): string {
  const h = Math.floor(hour) % 24;
  const m = Math.floor((hour % 1) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
