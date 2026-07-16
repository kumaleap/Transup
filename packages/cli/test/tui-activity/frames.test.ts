import {describe, expect, it} from "vitest";
import {
  FRAME_INTERVAL_MS,
  frameAt,
  spinnerChars,
  spinnerFrames,
} from "../../src/tui/activity/frames.js";
import {SPINNER_VERBS, sampleVerb} from "../../src/tui/activity/verbs.js";

describe("spinner frames", () => {
  it("darwin 与其他平台的帧字符只差第三个字符（✳ vs *）", () => {
    expect(spinnerChars("darwin")).toEqual(["·", "✢", "✳", "✶", "✻", "✽"]);
    expect(spinnerChars("linux")).toEqual(["·", "✢", "*", "✶", "✻", "✽"]);
    expect(spinnerChars("win32")).toEqual(["·", "✢", "*", "✶", "✻", "✽"]);
  });

  it("帧序列为正序+逆序拼接的 12 帧呼吸往返", () => {
    expect(spinnerFrames("darwin")).toEqual([
      "·", "✢", "✳", "✶", "✻", "✽",
      "✽", "✻", "✶", "✳", "✢", "·",
    ]);
    expect(spinnerFrames("darwin")).toHaveLength(12);
    // 拼接逆序时不能破坏原字符数组（reverse 不可原地修改）
    expect(spinnerChars("darwin")[0]).toBe("·");
  });

  it("frameAt 以 120ms 为帧间隔并按 12 帧取模", () => {
    expect(FRAME_INTERVAL_MS).toBe(120);
    expect(frameAt(0, "darwin")).toBe("·");
    expect(frameAt(119, "darwin")).toBe("·"); // 未跨过 120ms 边界
    expect(frameAt(120, "darwin")).toBe("✢"); // 恰好跨过边界
    expect(frameAt(120 * 5, "darwin")).toBe("✽");
    expect(frameAt(120 * 11, "darwin")).toBe("·"); // 第 12 帧回到起点字符
    expect(frameAt(120 * 12, "darwin")).toBe("·"); // 取模回卷到第 0 帧
    expect(frameAt(120 * 12 + 120, "darwin")).toBe("✢");
    expect(frameAt(120 * 2, "linux")).toBe("*"); // 平台差异贯穿 frameAt
  });
});

describe("spinner verbs", () => {
  it("动词表规模在 24~40 之间且不含省略号", () => {
    expect(SPINNER_VERBS.length).toBeGreaterThanOrEqual(24);
    expect(SPINNER_VERBS.length).toBeLessThanOrEqual(40);
    for (const verb of SPINNER_VERBS) {
      expect(verb).not.toContain("…");
      expect(verb).not.toContain(".");
      expect(verb).toMatch(/^[A-Z][A-Za-zé-]+$/);
    }
  });

  it("注入 random 时采样是确定性的", () => {
    expect(sampleVerb(() => 0)).toBe(SPINNER_VERBS[0]);
    expect(sampleVerb(() => 0.999999)).toBe(SPINNER_VERBS[SPINNER_VERBS.length - 1]);
    const mid = sampleVerb(() => 0.5);
    expect(sampleVerb(() => 0.5)).toBe(mid);
    expect(SPINNER_VERBS).toContain(mid);
  });

  it("默认 random 返回表内动词", () => {
    expect(SPINNER_VERBS).toContain(sampleVerb());
  });
});
