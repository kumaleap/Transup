import {describe, expect, it} from "vitest";
import {
  SHOW_TIMER_TOKENS_AFTER_MS,
  fmtTokens,
  formatDuration,
  statusParts,
} from "../../src/tui/activity/status-line.js";

describe("formatDuration", () => {
  it("60 秒以内显示 Ns", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(5_000)).toBe("5s");
    expect(formatDuration(59_000)).toBe("59s");
    expect(formatDuration(59_999)).toBe("59s"); // 不足一秒向下取整
  });

  it("60 秒及以上显示 NmMs，秒数补零到两位", () => {
    expect(formatDuration(60_000)).toBe("1m00s");
    expect(formatDuration(65_000)).toBe("1m05s");
    expect(formatDuration(125_000)).toBe("2m05s");
    expect(formatDuration(600_000)).toBe("10m00s");
  });
});

describe("fmtTokens", () => {
  it("千位以下原样，>=1000 缩写为 x.xk，>=10000 缩写为 xxk", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(999)).toBe("999");
    expect(fmtTokens(1_000)).toBe("1k"); // 1.0k 去掉尾零
    expect(fmtTokens(1_234)).toBe("1.2k");
    expect(fmtTokens(3_400)).toBe("3.4k");
    expect(fmtTokens(12_345)).toBe("12k");
  });
});

describe("statusParts", () => {
  it("30 秒门槛（含）之前返回空数组", () => {
    expect(SHOW_TIMER_TOKENS_AFTER_MS).toBe(30_000);
    expect(statusParts({elapsedMs: 0, inputTokens: 100, outputTokens: 100})).toEqual([]);
    expect(statusParts({elapsedMs: 29_999, inputTokens: 1_234, outputTokens: 3_400})).toEqual([]);
    expect(statusParts({elapsedMs: 30_000, inputTokens: 1_234, outputTokens: 3_400})).toEqual([]);
  });

  it("过门槛后返回耗时段与 token 段", () => {
    expect(statusParts({elapsedMs: 30_001, inputTokens: 1_234, outputTokens: 3_400})).toEqual([
      "30s",
      "↑1.2k ↓3.4k tokens",
    ]);
    expect(statusParts({elapsedMs: 65_000, inputTokens: 12_345, outputTokens: 999})).toEqual([
      "1m05s",
      "↑12k ↓999 tokens",
    ]);
  });

  it("tokens 为 0 时省略 token 段", () => {
    expect(statusParts({elapsedMs: 31_000, inputTokens: 0, outputTokens: 0})).toEqual(["31s"]);
  });
});
