/**
 * 参数面板（tweakpane）
 *
 * 为什么不自己写：原站用的是内部库 dialkit，公开等价物就是 tweakpane。
 * 需要的能力——分组、滑块、预设、URL 持久化——它全都开箱即用。
 */

import { Pane } from 'tweakpane';
import type { Params } from '../config';
import { HOUR_MIN, HOUR_MAX, ROW_MIN, ROW_MAX, QUALITY_TIERS } from '../config';

export type PaneCallbacks = {
  onChange: (patch: Partial<Params>) => void;
  onQuality: (index: number) => void;
  onReset: () => void;
};

export function createPane(params: Params, qualityIndex: number, cb: PaneCallbacks) {
  const pane = new Pane({ title: 'hublot' });
  pane.element.style.zIndex = '100';

  // ---------------- 时间 ----------------
  const fTime = pane.addFolder({ title: 'time', expanded: true });
  fTime.addBinding(params, 'hour', {
    label: 'paris',
    min: HOUR_MIN,
    max: HOUR_MAX,
    step: 0.01,
  }).on('change', (ev) => cb.onChange({ hour: ev.value }));
  fTime.addBinding(params, 'play', { label: 'play' }).on('change', (ev) => cb.onChange({ play: ev.value }));
  fTime.addBinding(params, 'speed', { label: 'speed', min: 0.1, max: 20, step: 0.1 })
    .on('change', (ev) => cb.onChange({ speed: ev.value }));

  // ---------------- 座位 / 视角 ----------------
  const fSeat = pane.addFolder({ title: 'seat', expanded: true });
  fSeat.addBinding(params, 'row', {
    label: 'row',
    min: ROW_MIN,
    max: ROW_MAX,
    step: 1,
  }).on('change', (ev) => cb.onChange({ row: ev.value }));
  fSeat.addBinding(params, 'hublot', { label: 'hublot' }).on('change', (ev) => cb.onChange({ hublot: ev.value }));

  const fPov = fSeat.addFolder({ title: 'pov', expanded: false });
  fPov.addBinding(params, 'px', { label: 'px', min: -60, max: 60, step: 0.5 }).on('change', (ev) => cb.onChange({ px: ev.value }));
  fPov.addBinding(params, 'py', { label: 'py', min: -30, max: 30, step: 0.5 }).on('change', (ev) => cb.onChange({ py: ev.value }));
  fPov.addBinding(params, 'pd', { label: 'pd', min: -10, max: 60, step: 0.5 }).on('change', (ev) => cb.onChange({ pd: ev.value }));
  // ── yaw / pitch 范围 ──
  // 舱内只建了「转头 ±40° 以内」的那一小块（座椅、地板、行李架、隔板）。
  // 再往外没有建模，所以必须在交互层就挡住 —— 这是最省性能的做法：
  // 用范围换面数，而不是建完整个机舱再靠裁剪。
  fPov.addBinding(params, 'yaw', { label: 'yaw', min: -55, max: 55, step: 0.5 }).on('change', (ev) => cb.onChange({ yaw: ev.value }));
  fPov.addBinding(params, 'pitch', { label: 'pitch', min: -32, max: 32, step: 0.5 }).on('change', (ev) => cb.onChange({ pitch: ev.value }));

  // ---------------- 天气 ----------------
  const fWeather = pane.addFolder({ title: 'weather', expanded: false });
  fWeather.addBinding(params, 'lowClouds', { label: 'lowClouds', min: 0, max: 1, step: 0.01 })
    .on('change', (ev) => cb.onChange({ lowClouds: ev.value }));
  fWeather.addBinding(params, 'cirrus', { label: 'cirrus', min: 0, max: 1, step: 0.01 })
    .on('change', (ev) => cb.onChange({ cirrus: ev.value }));
  fWeather.addBinding(params, 'turbulence', { label: 'turbulence', min: 0, max: 1, step: 0.01 })
    .on('change', (ev) => cb.onChange({ turbulence: ev.value }));

  // ---------------- 光照 ----------------
  const fLight = pane.addFolder({ title: 'light', expanded: false });
  fLight.addBinding(params, 'cities', { label: 'cities', min: 0, max: 8, step: 0.1 })
    .on('change', (ev) => cb.onChange({ cities: ev.value }));
  fLight.addBinding(params, 'cabin', { label: 'cabin', min: 0, max: 1, step: 0.01 })
    .on('change', (ev) => cb.onChange({ cabin: ev.value }));
  fLight.addBinding(params, 'ev', { label: 'ev', min: -3, max: 3, step: 0.1 })
    .on('change', (ev) => cb.onChange({ ev: ev.value }));

  // ---------------- 声音 ----------------
  const fSound = pane.addFolder({ title: 'sound', expanded: false });
  fSound.addBinding(params, 'sound', { label: 'on' }).on('change', (ev) => cb.onChange({ sound: ev.value }));
  fSound.addBinding(params, 'volume', { label: 'volume', min: 0, max: 1, step: 0.01 })
    .on('change', (ev) => cb.onChange({ volume: ev.value }));

  // ---------------- 画质 ----------------
  const fQuality = pane.addFolder({ title: 'quality', expanded: false });
  const qualityOptions: Record<string, string> = {};
  QUALITY_TIERS.forEach((t, i) => {
    qualityOptions[t.name] = String(i);
  });
  const qualityState = { tier: String(qualityIndex) };
  fQuality
    .addBinding(qualityState, 'tier', {
      label: 'tier',
      options: qualityOptions,
    })
    .on('change', (ev) => cb.onQuality(Number(ev.value)));

  // ---------------- 后期 ----------------
  const fPost = pane.addFolder({ title: 'post', expanded: false });
  fPost.addBinding(params, 'bloomStrength', { label: 'bloom', min: 0, max: 2, step: 0.01 })
    .on('change', (ev) => cb.onChange({ bloomStrength: ev.value }));
  fPost.addBinding(params, 'bloomThreshold', { label: 'threshold', min: 0, max: 3, step: 0.01 })
    .on('change', (ev) => cb.onChange({ bloomThreshold: ev.value }));
  fPost.addBinding(params, 'grain', { label: 'grain', min: 0, max: 0.08, step: 0.001 })
    .on('change', (ev) => cb.onChange({ grain: ev.value }));

  // ---------------- 调试 ----------------
  const fDebug = pane.addFolder({ title: 'debug', expanded: false });
  fDebug.addBinding(params, 'thirds', { label: 'thirds' }).on('change', (ev) => cb.onChange({ thirds: ev.value }));
  fDebug
    .addBinding(params, 'debugMode', {
      label: 'channel',
      options: {
        正常: '0',
        人口密度: '1',
        像素足迹: '2',
        城市灯光: '3',
        大气透射: '4',
        地面反照: '5',
        天空散射: '6',
      },
    })
    .on('change', (ev) => cb.onChange({ debugMode: Number(ev.value) }));
  fDebug.addButton({ title: 'reset' }).on('click', () => cb.onReset());

  return pane;
}
