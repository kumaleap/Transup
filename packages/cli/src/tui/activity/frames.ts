// spinner 帧动画：帧字符按平台区分，帧序列为正序+逆序拼接的 12 帧"呼吸"往返。
// 纯模块——不 import React/Ink；platform 参数注入便于测试（默认 process.platform）。

/** 帧切换间隔：120ms（动画时钟 50ms tick，帧号按 120ms 取整） */
export const FRAME_INTERVAL_MS = 120;

/** 单程帧字符。darwin 用 ✳，其他平台该字符渲染不稳，降级为 * */
export function spinnerChars(platform: NodeJS.Platform = process.platform): readonly string[] {
  return platform === "darwin"
    ? ["·", "✢", "✳", "✶", "✻", "✽"]
    : ["·", "✢", "*", "✶", "✻", "✽"];
}

/** 12 帧往返序列 = 正序 + 逆序（注意不能原地 reverse 破坏源数组） */
export function spinnerFrames(platform?: NodeJS.Platform): readonly string[] {
  const chars = spinnerChars(platform);
  return [...chars, ...[...chars].reverse()];
}

/** 按已流逝毫秒数取当前帧字符：frame = floor(elapsedMs / 120) % 12 */
export function frameAt(elapsedMs: number, platform?: NodeJS.Platform): string {
  const frames = spinnerFrames(platform);
  const frame = Math.floor(elapsedMs / FRAME_INTERVAL_MS) % frames.length;
  return frames[frame]!;
}
