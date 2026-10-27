/**
 * 大气 uniform 声明与编译期上限
 *
 * atmosphere.glsl 依赖这些 uniform，但它们由主 shader 声明。
 * 把声明单独抽出来，保证 common/*.glsl 可被多个 shader 复用而不重复定义。
 *
 * 注意：这些 uniform 必须由 THREE.ShaderMaterial 的 uniforms 提供，
 * 名字要和 sky.ts 里的一致。
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
uniform float uMieBeta;
uniform vec3 uOzoneBeta;
uniform float uMieG;

/** 单次散射 ray-march 上限（必须与 sky.ts 的 uSteps 允许的最大值一致） */
#ifndef MAX_SKY_STEPS
#define MAX_SKY_STEPS 24
#endif

/** 光学厚度积分上限 */
#ifndef MAX_OD_STEPS
#define MAX_OD_STEPS 12
#endif

#endif
