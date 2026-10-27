/**
 * 程序化音频引擎
 *
 * 原站的音频完全是合成的（除了 2 个彩蛋音效采样）：
 *   - 粉红噪声（Paul Kellet 六极点滤波器）→ 机身白噪
 *   - 6 路 biquad 分频
 *   - 双锯齿 78 / 78.45 Hz（拍频）→ 涡扇轰鸣
 *   - 0.08 / 0.31 Hz 的慢速调制 → 引擎起伏
 *   - DynamicsCompressor 收尾
 *
 * 特殊行为：随湍流自动 fasten / unfasten（停止低频轰鸣）。
 * 注意 iOS：AudioContext 必须在用户手势中 resume()。
 */

export class CabinAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private engineGain: GainNode | null = null;
  private noiseGain: GainNode | null = null;
  private started = false;

  /** 当前是否处于「安全带已系」（低频轰鸣开启）状态 */
  private fastened = true;
  private calmSince = 0;
  private ready = false;

  get isReady() {
    return this.ready;
  }

  get isFastened() {
    return this.fastened;
  }

  /**
   * 生成粉红噪声 buffer（Paul Kellet 近似法）。
   * 用 OfflineAudioContext 会更快，但这里直接同步生成也可以，6 秒 × 2 声道很快。
   */
  private createPinkNoise(ctx: AudioContext, seconds = 6): AudioBuffer {
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      let b0 = 0,
        b1 = 0,
        b2 = 0,
        b3 = 0,
        b4 = 0,
        b5 = 0,
        b6 = 0;
      for (let i = 0; i < len; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.969 * b2 + white * 0.153852;
        b3 = 0.8665 * b3 + white * 0.3104856;
        b4 = 0.55 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.016898;
        data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
        b6 = white * 0.115926;
      }
    }
    return buf;
  }

  /**
   * 启动。必须在用户手势里调用。
   */
  async start(volume = 0.6): Promise<boolean> {
    if (this.started) return true;
    try {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return false;
      const ctx = new Ctor();
      this.ctx = ctx;
      if (ctx.state === 'suspended') await ctx.resume();

      // --- 总线 ---
      const master = ctx.createGain();
      master.gain.value = 0;
      this.master = master;

      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -18;
      compressor.knee.value = 12;
      compressor.ratio.value = 3;
      compressor.attack.value = 0.01;
      compressor.release.value = 0.3;
      master.connect(compressor);
      compressor.connect(ctx.destination);

      const bright = ctx.createGain();
      const dark = ctx.createGain();
      bright.gain.value = 1;
      dark.gain.value = 1;
      bright.connect(master);
      dark.connect(master);

      // 高频略微衰减，模拟舱内吸音
      const shelf = ctx.createBiquadFilter();
      shelf.type = 'highshelf';
      shelf.frequency.value = 900;
      shelf.gain.value = -8;
      shelf.connect(bright);

      // --- 粉红噪声源 ---
      const noiseBuf = this.createPinkNoise(ctx);
      const noiseSrc = ctx.createBufferSource();
      noiseSrc.buffer = noiseBuf;
      noiseSrc.loop = true;
      noiseSrc.start();

      const noiseBus = ctx.createGain();
      noiseBus.gain.value = 0.22;
      this.noiseGain = noiseBus;

      const addBand = (type: BiquadFilterType, freq: number, q: number, gain: number, dest: AudioNode) => {
        const f = ctx.createBiquadFilter();
        f.type = type;
        f.frequency.value = freq;
        f.Q.value = q;
        const g = ctx.createGain();
        g.gain.value = gain;
        noiseSrc.connect(f);
        f.connect(g);
        g.connect(dest);
        return { f, g };
      };

      // 分频：低频轰鸣走 dark，中高频走 bright
      addBand('lowpass', 120, 0.7, 0.9, dark);
      addBand('bandpass', 500, 0.5, 0.55, bright);
      addBand('bandpass', 1400, 0.8, 0.12, bright);
      addBand('highpass', 2800, 0.7, 0.07, bright);
      addBand('bandpass', 170, 0.6, 0.3, dark);
      addBand('lowpass', 90, 0.7, 0.25, dark);

      // --- 引擎：双锯齿拍频 ---
      const engineBus = ctx.createGain();
      engineBus.gain.value = 0.07;
      engineBus.connect(bright);
      this.engineGain = engineBus;

      const engineLp = ctx.createBiquadFilter();
      engineLp.type = 'lowpass';
      engineLp.frequency.value = 260;
      engineLp.connect(engineBus);

      const addSaw = (baseFreq: number, detune: number) => {
        const partials: Array<[number, number]> = [
          [1, 1],
          [2, 0.5],
          [3, 0.25],
        ];
        for (const [mult, amp] of partials) {
          const osc = ctx.createOscillator();
          osc.type = 'sawtooth';
          osc.frequency.value = (baseFreq + detune) * mult;
          const g = ctx.createGain();
          g.gain.value = amp / 3;
          osc.connect(g);
          g.connect(engineLp);
          osc.start();
        }
      };
      addSaw(78, 0);
      addSaw(78, 0.45); // 拍频

      // --- 慢速调制（引擎起伏）---
      const addLfo = (freq: number, depth: number, dest: AudioParam) => {
        const osc = ctx.createOscillator();
        osc.frequency.value = freq;
        const g = ctx.createGain();
        g.gain.value = depth;
        osc.connect(g);
        g.connect(dest);
        osc.start();
      };
      addLfo(0.08, 0.08, engineBus.gain);
      addLfo(0.31, 0.04, engineBus.gain);

      // --- 音量淡入（避免爆音）---
      master.gain.setValueAtTime(0, ctx.currentTime);
      master.gain.linearRampToValueAtTime(volume, ctx.currentTime + 1.2);

      this.started = true;
      this.ready = true;

      // 切后台后 iOS 会挂起，回来要恢复
      document.addEventListener('visibilitychange', this.onVisibility);
      return true;
    } catch (err) {
      console.warn('[audio] start failed', err);
      return false;
    }
  }

  private onVisibility = () => {
    if (document.visibilityState === 'visible' && this.ctx?.state === 'suspended') {
      void this.ctx.resume();
    }
  };

  setVolume(v: number) {
    if (!this.master || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.linearRampToValueAtTime(Math.max(0, Math.min(1, v)), t + 0.3);
  }

  /**
   * 随湍流调整。原站逻辑：
   *   - 湍流 > 0.6 持续 → 系好安全带（低频轰鸣）
   *   - 湍流 < 0.4 且平静超过 25 秒 → 松开（静音低频）
   */
  update(turbulence: number, elapsed: number) {
    if (!this.ready || !this.engineGain || !this.ctx) return;
    const t = this.ctx.currentTime;
    const target = 0.05 + 0.06 * turbulence;

    this.engineGain.gain.cancelScheduledValues(t);
    this.engineGain.gain.linearRampToValueAtTime(target, t + 0.4);

    if (turbulence > 0.6) this.calmSince = elapsed;
    if (this.fastened && turbulence < 0.4 && elapsed > 30 && elapsed - this.calmSince > 25) {
      this.fasten(false);
    }
  }

  /** 低频轰鸣开/关 */
  fasten(on = true) {
    if (!this.noiseGain || !this.ctx || this.fastened === on) return;
    this.fastened = on;
    const t = this.ctx.currentTime;
    this.noiseGain.gain.cancelScheduledValues(t);
    this.noiseGain.gain.linearRampToValueAtTime(on ? 0.22 : 0.04, t + 1.5);
  }

  async dispose() {
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.master && this.ctx) {
      const t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.linearRampToValueAtTime(0, t + 0.4);
      await new Promise((r) => setTimeout(r, 500));
    }
    await this.ctx?.close();
    this.ctx = null;
    this.started = false;
    this.ready = false;
  }
}
