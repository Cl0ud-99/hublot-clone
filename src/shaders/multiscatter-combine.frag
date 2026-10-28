/**
 * 多重散射 LUT 求和
 *
 * 把各阶 F_1 … F_N 加起来得到 F_total。
 * 用显式求和而不是「按比值外推等比级数」：等比假设在暮光下不成立
 * （低阶和高阶的相对权重会随太阳高度剧烈变化），
 * 而多算几阶的成本对一张 32×32 的纹理来说完全可以忽略。
 */

uniform sampler2D uMS1;
uniform sampler2D uMS2;
uniform sampler2D uMS3;
uniform sampler2D uMS4;
uniform sampler2D uMS5;

varying vec2 vUv;

void main() {
  vec3 sum = texture2D(uMS1, vUv).rgb
           + texture2D(uMS2, vUv).rgb
           + texture2D(uMS3, vUv).rgb
           + texture2D(uMS4, vUv).rgb
           + texture2D(uMS5, vUv).rgb;
  gl_FragColor = vec4(sum, 1.0);
}
