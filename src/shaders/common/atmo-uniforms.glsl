/**
 * 大气 uniform 声明与编译期上限
 *
 * atmosphere.glsl 依赖这些 uniform，但它们由主 shader 声明。
 * 把声明单独抽出来，保证 common/*.glsl 可被多个 shader 复用而不重复定义。
 *
 * 注意：这些 uniform 必须由 THREE.ShaderMaterial 的 uniforms 提供，
 * 名字要和 sky.ts / atmosphereLUT.ts 里的一致。
 */

#ifndef ATMO_UNIFORMS_GLSL
#define ATMO_UNIFORMS_GLSL

uniform float uEarthRadius;
uniform float uAtmosphereRadius;

uniform float uRayleighScaleHeight;
uniform float uMieScaleHeight;
uniform float uOzoneCenter;
uniform float uOzoneWidth;

uniform vec3 uRayleighBeta;
/** Mie 散射系数（km^-1） */
uniform float uMieBeta;
/** Mie 吸收系数（km^-1）。消光 = 散射 + 吸收，漏掉它会让天空过度清透。 */
uniform float uMieAbsorb;
uniform vec3 uOzoneBeta;
uniform float uMieG;

/**
 * 多次散射 LUT。
 *
 * 生成阶段：这里绑的是「上一阶」的 F_{n-1}；
 * 渲染阶段：这里绑的是最终求和后的 F_total。
 */
uniform sampler2D uMultiScatterLUT;

/** 多次散射强度（1 = 物理值，0 = 关闭，用于 A/B 对比）。 */
uniform float uMSStrength;

/** 单次散射 ray-march 上限（必须与 sky.ts 的 uSteps 允许的最大值一致） */
#ifndef MAX_SKY_STEPS
#define MAX_SKY_STEPS 24
#endif

/** 光学厚度积分上限 */
#ifndef MAX_OD_STEPS
#define MAX_OD_STEPS 12
#endif

#endif
