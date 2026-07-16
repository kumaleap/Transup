// 停滞检测与颜色渐变(纯模块,不依赖 React/Ink)。
// 规格来源:docs/claude-code-interactions/02-流式输出与活动行.md §1.3(useStalledAnimation 逆向)
// - 距最后进展 3000ms 内、或有运行中工具时,目标强度为 0;
// - 超过 3000ms 后目标 = min((since-3000)/2000, 1),即 2 秒内渐变到全红;
// - 每帧(约 50ms tick)按 current += (target-current)*0.1 平滑插值;
// - 视觉适配 Transup 主题:调用方用 interpolateColor(T.primary, T.danger, intensity)。

const STALL_THRESHOLD_MS = 3000;
const RAMP_DURATION_MS = 2000;
const SMOOTHING_FACTOR = 0.1;

export interface StallTracker {
  /** 有新流式输出(长度增长)或工具活动变化时调用,重置停滞计时。 */
  observeProgress(now: number): void;
  /** 每帧调用,返回平滑后的停滞强度(0~1)。 */
  tick(now: number, hasActiveTools: boolean): number;
}

export function createStallTracker(): StallTracker {
  // lastProgressAt 惰性初始化:首次 observeProgress/tick 的时间视为起点,
  // 避免依赖挂载时刻的真实时钟,便于测试注入。
  let lastProgressAt: number | undefined;
  let current = 0;

  return {
    observeProgress(now) {
      lastProgressAt = now;
    },
    tick(now, hasActiveTools) {
      if (lastProgressAt === undefined) {
        lastProgressAt = now;
      }
      // 有活动工具时视为仍在进展:目标归 0 并重置计时(工具结束后重新等 3 秒)。
      if (hasActiveTools) {
        lastProgressAt = now;
      }
      const since = now - lastProgressAt;
      const target =
        since <= STALL_THRESHOLD_MS
          ? 0
          : Math.min((since - STALL_THRESHOLD_MS) / RAMP_DURATION_MS, 1);
      current += (target - current) * SMOOTHING_FACTOR;
      return current;
    },
  };
}

/** '#rrggbb' 线性插值;t 越界(含 NaN)钳到 [0,1]。 */
export function interpolateColor(hexA: string, hexB: string, t: number): string {
  const clamped = Number.isFinite(t) ? Math.min(Math.max(t, 0), 1) : 0;
  const a = parseHex(hexA);
  const b = parseHex(hexB);
  const channel = (index: number): string =>
    Math.round(a[index]! + (b[index]! - a[index]!) * clamped)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

function parseHex(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}
