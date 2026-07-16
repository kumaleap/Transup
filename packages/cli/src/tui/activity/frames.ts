// spinner 帧动画：圆点呼吸 ∙ • ● • ∙（告别 Claude Code 的星号呼吸帧）。
// 纯模块——不 import React/Ink。三个字符各平台字形都稳定，无需平台分支。

/** 帧切换间隔：120ms（动画时钟 50ms tick，帧号按 120ms 取整） */
export const FRAME_INTERVAL_MS = 120;

/**
 * 帧序列：小→中→大→大→中→小，首尾各停一帧（回卷后与下一轮首帧连成
 * 240ms 的"屏息"），呼吸节奏更自然。每帧宽度恒为 1，动词行不会抖。
 */
export const SPINNER_FRAMES: readonly string[] = ["∙", "•", "●", "●", "•", "∙"];

/** 按已流逝毫秒数取当前帧：frame = floor(elapsedMs / 120) % 6 */
export function frameAt(elapsedMs: number): string {
  const frame = Math.floor(elapsedMs / FRAME_INTERVAL_MS) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES[frame]!;
}
