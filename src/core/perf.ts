import type { QualityTier } from '../config';
import { QUALITY_TIERS } from '../config';

/**
 * 性能自适应
 *
 * 策略参考原站：
 *   - 250ms 采样窗口
 *   - 10 个窗口的滚动平均
 *   - 超过 75% 的窗口「偏高」→ 升一档；「偏低」→ 降一档
 *   - 但降档要快、升档要慢（宁可稳在低档，也不要来回抖）
 *
 * 这里做了两点改进：
 *   1. 首次进入的前 1.5 秒不判定（着色器编译/纹理上传会造成假低帧）
 *   2. 有「连续 N 次同向」才动作，避免单帧抖动触发
 */

export type PerfSnapshot = {
  fps: number;
  tier: QualityTier;
  tierIndex: number;
};

const WINDOW_MS = 250;
const WINDOWS = 10;
const HIGH_RATIO = 0.75;
/** 连续多少次同向才动作 */
const PATIENCE_UP = 6;
const PATIENCE_DOWN = 2;
/** 启动豁免时间 */
const WARMUP_MS = 1500;

export class PerformanceAdaptor {
  private frames: number[] = [];
  private windowStart = performance.now();
  private history: number[] = [];
  private startTime = performance.now();

  private upStreak = 0;
  private downStreak = 0;

  private _tierIndex: number;
  private _fps = 0;
  /** 是否已经锁定（用户手动指定画质后不再自动调） */
  private locked = false;

  onChange: ((s: PerfSnapshot) => void) | null = null;

  constructor(initialIndex = 2) {
    this._tierIndex = Math.max(0, Math.min(QUALITY_TIERS.length - 1, initialIndex));
  }

  get tier(): QualityTier {
    return QUALITY_TIERS[this._tierIndex];
  }

  get tierIndex(): number {
    return this._tierIndex;
  }

  get fps(): number {
    return this._fps;
  }

  /** 每帧调用 */
  tick(now: number) {
    this.frames.push(now);
    const span = now - this.windowStart;
    if (span < WINDOW_MS) return;

    // 关闭当前窗口
    const fps = (this.frames.length / span) * 1000;
    this.frames.length = 0;
    this.windowStart = now;
    this._fps = Math.round(fps * 10) / 10;

    // 预热期内只收集，不判定
    if (now - this.startTime < WARMUP_MS) {
      this.history.push(fps);
      if (this.history.length > WINDOWS) this.history.shift();
      return;
    }

    this.history.push(fps);
    if (this.history.length > WINDOWS) this.history.shift();
    if (this.history.length < WINDOWS) return;
    if (this.locked) return;

    this.evaluate();
  }

  private evaluate() {
    // 目标刷新率取历史最大值，避免把「本来就是 30Hz 的屏」判成低性能
    const target = Math.max(...this.history);
    const tiers = QUALITY_TIERS;
    const isTop = this._tierIndex === 0;
    const isBottom = this._tierIndex === tiers.length - 1;

    // 高于 92% 目标帧率 → 可能是性能过剩
    const high = this.history.filter((f) => f >= target * 0.92).length;
    // 低于 70% 目标帧率 → 卡
    const low = this.history.filter((f) => f < target * 0.7).length;

    const shouldDown = low / this.history.length >= HIGH_RATIO && !isBottom;
    const shouldUp = high / this.history.length >= HIGH_RATIO && !isTop;

    if (shouldDown) {
      this.downStreak++;
      this.upStreak = 0;
    } else if (shouldUp) {
      this.upStreak++;
      this.downStreak = 0;
    } else {
      this.upStreak = 0;
      this.downStreak = 0;
    }

    if (this.downStreak >= PATIENCE_DOWN) {
      this.downStreak = 0;
      this.setTier(this._tierIndex + 1, 'auto-down');
    } else if (this.upStreak >= PATIENCE_UP) {
      this.upStreak = 0;
      this.setTier(this._tierIndex - 1, 'auto-up');
    }
  }

  setTier(index: number, reason = 'manual') {
    const clamped = Math.max(0, Math.min(QUALITY_TIERS.length - 1, index));
    if (clamped === this._tierIndex) return;
    this._tierIndex = clamped;
    this.history.length = 0;
    this.upStreak = 0;
    this.downStreak = 0;
    if (reason !== 'auto-down' && reason !== 'auto-up') {
      this.locked = true;
    }
    this.onChange?.({ fps: this._fps, tier: this.tier, tierIndex: this._tierIndex });
  }

  /** 手动指定画质 */
  lockTo(index: number) {
    this.locked = true;
    this.setTier(index, 'manual');
  }

  unlock() {
    this.locked = false;
    this.history.length = 0;
  }

  get isLocked() {
    return this.locked;
  }
}
