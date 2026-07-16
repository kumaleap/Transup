import {describe, expect, it} from "vitest";
import {createStallTracker, interpolateColor} from "../../src/tui/activity/stall.js";

// 规格来源:docs/claude-code-interactions/02-流式输出与活动行.md §1.3
// - 3000ms 内无进展不变红;超过后 target = min((since-3000)/2000, 1)
// - 每次 tick 平滑插值 current += (target-current)*0.1

describe("createStallTracker", () => {
  it("最后进展 3000ms 内 intensity 保持 0", () => {
    const tracker = createStallTracker();
    tracker.observeProgress(0);
    expect(tracker.tick(1000, false)).toBe(0);
    expect(tracker.tick(2000, false)).toBe(0);
    expect(tracker.tick(3000, false)).toBe(0);
  });

  it("3000ms 后目标强度按 (since-3000)/2000 线性上升(单次 tick 反映 target*0.1)", () => {
    // 每个时间点用全新 tracker,单次 tick 从 current=0 出发,结果 = target * 0.1
    const singleTick = (now: number): number => {
      const tracker = createStallTracker();
      tracker.observeProgress(0);
      return tracker.tick(now, false);
    };
    expect(singleTick(3500)).toBeCloseTo(0.25 * 0.1, 10);
    expect(singleTick(4000)).toBeCloseTo(0.5 * 0.1, 10);
    expect(singleTick(4500)).toBeCloseTo(0.75 * 0.1, 10);
  });

  it("5000ms 时目标达到 1(满红),且持续 tick 后收敛到接近 1", () => {
    const tracker = createStallTracker();
    tracker.observeProgress(0);
    expect(tracker.tick(5000, false)).toBeCloseTo(0.1, 10);
    let intensity = 0;
    const fresh = createStallTracker();
    fresh.observeProgress(0);
    for (let index = 0; index < 200; index += 1) {
      intensity = fresh.tick(5000 + index * 50, false);
    }
    expect(intensity).toBeGreaterThan(0.99);
    expect(intensity).toBeLessThanOrEqual(1);
  });

  it("observeProgress 重置停滞计时,intensity 向 0 衰减", () => {
    const tracker = createStallTracker();
    tracker.observeProgress(0);
    let intensity = 0;
    for (let index = 0; index < 40; index += 1) {
      intensity = tracker.tick(6000 + index * 50, false);
    }
    expect(intensity).toBeGreaterThan(0.5);
    tracker.observeProgress(8000);
    const afterReset = tracker.tick(8050, false);
    // 目标归 0:current 按 0.9 倍衰减
    expect(afterReset).toBeCloseTo(intensity * 0.9, 10);
    // 重置后 3000ms 内目标持续为 0,持续衰减
    let decayed = afterReset;
    for (let index = 1; index < 20; index += 1) {
      const next = tracker.tick(8050 + index * 50, false);
      expect(next).toBeLessThan(decayed);
      decayed = next;
    }
  });

  it("hasActiveTools 为 true 时抑制变红(目标 0 且重置计时)", () => {
    const tracker = createStallTracker();
    tracker.observeProgress(0);
    // 即使距最后进展已 10 秒,有活动工具时目标仍为 0
    expect(tracker.tick(10_000, true)).toBe(0);
    // 工具结束后重新计时:3000ms 内仍不变红
    expect(tracker.tick(12_000, false)).toBe(0);
    // 工具结束 3000ms 之后才开始上升
    expect(tracker.tick(13_500, false)).toBeGreaterThan(0);
  });

  it("平滑插值单调收敛:停滞期严格递增趋向 1,不越界", () => {
    const tracker = createStallTracker();
    tracker.observeProgress(0);
    let previous = 0;
    for (let index = 0; index < 300; index += 1) {
      const next = tracker.tick(5000 + index * 50, false);
      expect(next).toBeGreaterThan(previous);
      expect(next).toBeLessThanOrEqual(1);
      previous = next;
    }
  });
});

describe("interpolateColor", () => {
  it("端点:t=0 返回 A,t=1 返回 B", () => {
    expect(interpolateColor("#00d787", "#ff5f5f", 0)).toBe("#00d787");
    expect(interpolateColor("#00d787", "#ff5f5f", 1)).toBe("#ff5f5f");
  });

  it("中点:各通道线性取半(四舍五入)", () => {
    expect(interpolateColor("#000000", "#ffffff", 0.5)).toBe("#808080");
    // r: (0x00+0xff)/2=127.5→128=80; g: (0xd7+0x5f)/2=155=9b; b: (0x87+0x5f)/2=115=73
    expect(interpolateColor("#00d787", "#ff5f5f", 0.5)).toBe("#809b73");
  });

  it("非法 t 钳制到 [0,1]", () => {
    expect(interpolateColor("#00d787", "#ff5f5f", -1)).toBe("#00d787");
    expect(interpolateColor("#00d787", "#ff5f5f", 2)).toBe("#ff5f5f");
    expect(interpolateColor("#00d787", "#ff5f5f", Number.NaN)).toBe("#00d787");
  });
});
