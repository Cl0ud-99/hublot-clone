/**
 * 全局常数与配置
 *
 * 标注 "REV" 的数值是从 hublot.darkroom.engineering 的线上 bundle 里逆向出来的，
 * 用于 1:1 对拍（同样的 URL 参数能渲染出同样的画面）。
 */

// ---------------------------------------------------------------------------
// 世界尺度
// ---------------------------------------------------------------------------

/** 地球半径。注意：单位是「千米」，1 单位 ≈ 1 km。REV */
export const EARTH_RADIUS_KM = 6360;
/** 大气顶半径（地球 + 约 100 km）。REV: 原站用 6460 */
export const ATMOSPHERE_RADIUS_KM = 6460;

/**
 * 巡航高度，单位 km。
 * 原站没有直接暴露这个参数，但从地平线位置反推约在 10~11 km。
 */
/** 巡航高度，单位 km。 */
export const CRUISE_ALTITUDE_KM = 10.4;

/**
 * 巡航速度（km/s）。
 *
 * 真实客机约 900 km/h ≈ 0.25 km/s。
 * REV 原站用 elapsed * 0.21（约 756 km/h），稍慢一点：
 * 太快的会让近景地面糊成一片，0.21 在「明显在动」和「不晕」之间比较平衡。
 */
export const FLIGHT_SPEED_KM_S = 0.21;

/** 观测点纬度 / 经度（度）。REV: 巴黎以南 47.15N 2.2E */
export const SITE_LAT = 47.15;
export const SITE_LON = 2.2;

// ---------------------------------------------------------------------------
// 时间
// ---------------------------------------------------------------------------

/** 巴黎时间的小时数范围。REV: 6.0 ~ 10.5 */
export const HOUR_MIN = 6.0;
export const HOUR_MAX = 10.5;
/** 默认时刻（日出前后）。REV: 7.08 */
export const HOUR_DEFAULT = 7.08;
/** 自动播放速度倍率（小时/秒 的基准）。REV: speed 默认 1 */
export const HOUR_SPEED_DEFAULT = 1;

// ---------------------------------------------------------------------------
// 大气（单次散射版）
// ---------------------------------------------------------------------------

/**
 * Rayleigh 散射系数（每千米），RGB。REV
 * 这些值对应地面气压下的波长相关散射强度。
 */
export const RAYLEIGH_BETA = [0.00867, 0.013558, 0.0265] as const;

/** Mie 散射系数（每千米）。REV: 0.003996 */
export const MIE_BETA = 0.003996;
/** Mie 吸收系数（每千米）。REV: 0.00444 */
export const MIE_ABSORB = 0.00444;
/** Mie 相位函数的各向异性参数 g（前向散射）。REV: 原站 Cornette-Shanks 默认 0.8 */
export const MIE_G = 0.8;

/**
 * 臭氧吸收系数（每千米，RGB）。REV
 *
 * ── 这里曾经多写了一个零 ──
 * 原站 bundle 里是 `V5(.00277,.001881,26e-5)`，即 [0.00277, 0.001881, 0.00026]。
 * 我们之前把最后一项写成了 0.0026 —— 蓝通道吸收被放大 10 倍。
 * 后果：任何长光程（地平线附近、暮光）蓝光被吃光，
 * 天空从蓝渐变变成**黄绿色**，而且暮光越深越明显。
 * 这个常数对暮光观感的影响远大于它的数值大小，属于「差一个量级就全错」的类型。
 */
export const OZONE_BETA = [0.00277, 0.001881, 0.00026] as const;
/** 臭氧层中心高度（km）与半宽（km）。 */
export const OZONE_CENTER_KM = 25.0;
export const OZONE_WIDTH_KM = 15.0;

/** Rayleigh 标高（km）——密度随高度指数衰减的特征高度。 */
export const RAYLEIGH_SCALE_HEIGHT_KM = 8.0;
/** Mie 标高（km）。 */
export const MIE_SCALE_HEIGHT_KM = 1.2;

/** 太阳角半径（弧度）。REV: 0.004675 */
export const SUN_ANGULAR_RADIUS = 0.004675;
/** 太阳辐照度基准。REV: (1.7, 1.85, 2.03) 归一化到 100 */
export const SUN_IRRADIANCE = [0.0, 0.0, 0.0] as const; // 由 sun.ts 运行时计算

// ---------------------------------------------------------------------------
// 相机
// ---------------------------------------------------------------------------

/** 舱内镜头 fov（度）。REV: 54 */
export const CAMERA_FOV_CABIN = 54;
/** 外部 Canvas fov（度）。REV: 52 */
export const CAMERA_FOV_OUTER = 52;
/** 近裁面。REV: 0.02 */
export const CAMERA_NEAR = 0.02;
/**
 * 远裁面（机舱 Pass）。
 *
 * REV 原站是 2e5，但他们用 WebGPU 且天空/机舱在同一个大范围里。
 * 我们这里把天空做成「不写深度的全屏三角形」，所以机舱只需要覆盖
 * 内壁（0.2 m）到机翼（十几米）的范围 —— 深度比 1e4，精度充裕。
 * 取 200 是为了留余量（机翼在 6.5 m 外，翼展 3.2 m）。
 */
export const CAMERA_FAR_CABIN = 200;
export const CAMERA_FAR_SKY = 2e5;

// ---------------------------------------------------------------------------
// 舷窗几何（米）。REV: { w: .25, h: .35, r: .105, z: -1.86, depth: .06 }
// ---------------------------------------------------------------------------

export const WINDOW = {
  /** 窗洞宽 */
  width: 0.25,
  /** 窗洞高 */
  height: 0.35,
  /** 圆角半径 */
  radius: 0.105,
  /** 窗所在平面（相对相机）的 z 偏移 */
  z: -1.86,
  /** 内壁厚度 */
  depth: 0.06,
} as const;

/** 座位排数范围。REV: row 参数范围 1~28，默认 11（能看到机翼） */
export const ROW_MIN = 1;
export const ROW_MAX = 28;
export const ROW_DEFAULT = 11;

// ---------------------------------------------------------------------------
// 性能自适应
// ---------------------------------------------------------------------------

export type QualityTier = {
  name: string;
  /** 分辨率倍率（相对 CSS 像素） */
  dprScale: number;
  /** 大气 ray-march 步数 */
  skySteps: number;
  /** 地面 fbm 层数 */
  fbmOctaves: number;
  /** 是否启用城市灯光细节 */
  cityDetail: boolean;
};

/** 从高到低排列。降档从这里往下走，升档往上走。 */
export const QUALITY_TIERS: QualityTier[] = [
  { name: 'ultra', dprScale: 2.0, skySteps: 20, fbmOctaves: 5, cityDetail: true },
  { name: 'high', dprScale: 1.5, skySteps: 16, fbmOctaves: 4, cityDetail: true },
  { name: 'medium', dprScale: 1.0, skySteps: 12, fbmOctaves: 3, cityDetail: true },
  { name: 'low', dprScale: 0.75, skySteps: 8, fbmOctaves: 2, cityDetail: false },
  { name: 'minimal', dprScale: 0.55, skySteps: 6, fbmOctaves: 2, cityDetail: false },
];

// ---------------------------------------------------------------------------
// 默认参数（与 dialkit 面板同名，便于 URL 对拍）
// ---------------------------------------------------------------------------

export type Params = {
  /** 巴黎时间，小时 */
  hour: number;
  /** 是否自动推进时间 */
  play: boolean;
  /** 时间推进速度 */
  speed: number;
  /** 座位排数 */
  row: number;
  /**
   * 是否显示舷窗（含内壁与机翼）。
   * false = 「框景」模式，相机贴近窗玻璃
   */
  hublot: boolean;
  /** 相机位置微调（cm） */
  px: number;
  py: number;
  /** 相机到窗的距离（cm） */
  pd: number;
  /** 视线偏航（度） */
  yaw: number;
  /** 视线俯仰（度） */
  pitch: number;
  /** 城市灯光强度 */
  cities: number;
  /** 低云覆盖 */
  lowClouds: number;
  /** 卷云覆盖 */
  cirrus: number;
  /** 湍流（影响抖动与音频） */
  turbulence: number;
  /** 曝光档位（EV） */
  ev: number;
  /** 舷内补光强度 */
  cabin: number;
  /** 声音开关 */
  sound: boolean;
  /** 音量 */
  volume: number;
  /** 调试：显示三分线 */
  thirds: boolean;
  /**
   * 调试通道：
   * 0 正常 / 1 人口密度 / 2 像素足迹 / 3 城市灯光 /
   * 4 大气透射率 / 5 地面反照率 / 6 天空散射
   */
  debugMode: number;
  /** bloom 强度 */
  bloomStrength: number;
  /** bloom 起辉阈值（线性辐亮度） */
  bloomThreshold: number;
  /** 胶片颗粒强度 */
  grain: number;
};

export const DEFAULT_PARAMS: Params = {
  hour: HOUR_DEFAULT,
  play: true,
  speed: HOUR_SPEED_DEFAULT,
  row: ROW_DEFAULT,
  hublot: true,
  px: 10,
  py: 0,
  pd: 25,
  yaw: -18,
  pitch: 0,
  cities: 1,
  lowClouds: 0.3,
  cirrus: 0.5,
  turbulence: 0.35,
  ev: 0,
  cabin: 0,
  sound: true,
  volume: 0.6,
  thirds: false,
  debugMode: 0,
  bloomStrength: 0.55,
  /**
   * bloom 起辉阈值。
   * 0 = 自动（按昼夜在 0.06 ~ 1.2 之间插值）。
   * 夜景的线性辐亮度只有零点零几，固定高阈值会让 bloom 完全失效。
   */
  bloomThreshold: 0,
  grain: 0.012,
};

// ---------------------------------------------------------------------------
// URL 参数（与原站同名，方便对拍）
// ---------------------------------------------------------------------------

const URL_ALIASES: Record<string, keyof Params> = {
  time: 'hour',
  play: 'play',
  speed: 'speed',
  row: 'row',
  hublot: 'hublot',
  px: 'px',
  py: 'py',
  pd: 'pd',
  yaw: 'yaw',
  pitch: 'pitch',
  cities: 'cities',
  lowClouds: 'lowClouds',
  cirrus: 'cirrus',
  turbulence: 'turbulence',
  ev: 'ev',
  cabin: 'cabin',
  sound: 'sound',
  thirds: 'thirds',
  debug: 'debugMode',
  bloom: 'bloomStrength',
  bloomThreshold: 'bloomThreshold',
  grain: 'grain',
};

/** 从 location.search 读取覆盖值。布尔用 0/1 表示（与原站一致）。 */
export function readParamsFromUrl(base: Params = DEFAULT_PARAMS): Params {
  const out: Params = { ...base };
  if (typeof location === 'undefined') return out;
  const q = new URLSearchParams(location.search);
  for (const [urlKey, paramKey] of Object.entries(URL_ALIASES)) {
    const raw = q.get(urlKey);
    if (raw === null) continue;
    const def = base[paramKey];
    if (typeof def === 'boolean') {
      (out[paramKey] as boolean) = raw !== '0' && raw !== 'false';
    } else {
      const n = Number(raw);
      if (Number.isFinite(n)) (out[paramKey] as number) = n;
    }
  }
  return out;
}
