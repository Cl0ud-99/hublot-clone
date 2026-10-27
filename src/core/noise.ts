/**
 * 噪声纹理生成
 *
 * 为什么不直接在 shader 里跑 fbm？
 *   全屏 4 层 fbm × 每层 4 次 hash = 每像素 16 次整数运算 + 插值。
 *   在移动端 GPU 上这是主要瓶颈，而纹理查找便宜得多。
 *
 * 做法：启动时用一次性的 Canvas2D 生成一张 RGB(A) 噪声图，
 *   - R/G/B/A 四个通道各放一个八度（value noise，多频叠加）
 *   - 上传为 RepeatWrapping，shader 里 texture2D + 线性混合即可
 *
 * 这张图是「无缝平铺」的：生成时用取模的晶格坐标，保证边界连续。
 */

/** value noise 的确定性 hash（整数坐标 → [0,1)） */
function hash2(x: number, y: number, seed: number): number {
  let h = x * 374761393 + y * 668265263 + seed * 1442695040888963407;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * 单频 value noise，周期平铺。
 * @param px 采样点 x（像素单位）
 * @param py 采样点 y
 * @param period 晶格周期（保证无缝）
 */
function valueNoiseTiled(px: number, py: number, period: number, seed: number): number {
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const fx = smoothstep(px - x0);
  const fy = smoothstep(py - y0);

  const wrap = (v: number) => ((v % period) + period) % period;
  const xa = wrap(x0);
  const ya = wrap(y0);
  const xb = wrap(x0 + 1);
  const yb = wrap(y0 + 1);

  const n00 = hash2(xa, ya, seed);
  const n10 = hash2(xb, ya, seed);
  const n01 = hash2(xa, yb, seed);
  const n11 = hash2(xb, yb, seed);

  const nx0 = n00 + (n10 - n00) * fx;
  const nx1 = n01 + (n11 - n01) * fx;
  return nx0 + (nx1 - nx0) * fy;
}

/**
 * 生成一张尺寸为 size × size 的噪声纹理。
 *
 * 输出通道：
 *   R = 平滑的大尺度噪声（4 个八度）
 *   G = 中等尺度（4 个八度，频率 ×4）
 *   B = 细节（4 个八度，频率 ×16）
 *   A = 高频（4 个八度，频率 ×64）
 *
 * shader 里可以按需要的尺度取通道，也可以用 vec4 一次取齐。
 */
export function generateNoiseTextureData(size = 512, seed = 1337): Uint8Array {
  const data = new Uint8Array(size * size * 4);

  // 四个通道的基础频率（相对纹理宽度），都取 2 的幂以便无缝
  const baseFreqs = [4, 16, 64, 256];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      for (let c = 0; c < 4; c++) {
        const baseFreq = baseFreqs[c];
        let amp = 0.5;
        let freq = baseFreq;
        let sum = 0;
        let norm = 0;
        const octaves = 4;
        for (let o = 0; o < octaves; o++) {
          const px = (x / size) * freq;
          const py = (y / size) * freq;
          sum += amp * valueNoiseTiled(px, py, freq, seed + c * 97 + o * 13);
          norm += amp;
          amp *= 0.5;
          freq *= 2;
        }
        const v = sum / norm;
        data[idx + c] = Math.round(Math.max(0, Math.min(1, v)) * 255);
      }
    }
  }

  return data;
}
