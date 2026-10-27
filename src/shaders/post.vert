/**
 * 全屏后期 Pass 的顶点着色器
 *
 * 和天空共用「全屏三角形」技巧：3 个顶点覆盖整个 NDC，
 * 少一次顶点处理，也没有 quad 的对角线接缝。
 *
 * 注意不要手动声明 attribute vec3 position —— three 会自动注入，
 * 重复声明会触发 'redefinition' 编译错误。
 */

varying vec2 vUv;

void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
