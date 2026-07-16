import {describe, expect, it} from "vitest";
import {
  FRAME_INTERVAL_MS,
  frameAt,
  SPINNER_FRAMES,
} from "../../src/tui/activity/frames.js";
import {SPINNER_VERBS, sampleVerb} from "../../src/tui/activity/verbs.js";

describe("spinner frames", () => {
  it("圆点呼吸：小→中→大→大→中→小，首尾各停一帧", () => {
    expect(SPINNER_FRAMES).toEqual(["∙", "•", "●", "●", "•", "∙"]);
  });

  it("每帧宽度恒为 1，动词行不会水平抖动", () => {
    for (const frame of SPINNER_FRAMES) {
      expect([...frame]).toHaveLength(1);
    }
  });

  it("不再使用 Claude Code 的星号呼吸帧", () => {
    expect(SPINNER_FRAMES.join("")).not.toMatch(/[✢✳✶✻✽*]/);
  });

  it("frameAt 以 120ms 为帧间隔并按 6 帧取模", () => {
    expect(FRAME_INTERVAL_MS).toBe(120);
    expect(frameAt(0)).toBe("∙");
    expect(frameAt(119)).toBe("∙"); // 未跨过 120ms 边界
    expect(frameAt(120)).toBe("•"); // 恰好跨过边界
    expect(frameAt(120 * 2)).toBe("●");
    expect(frameAt(120 * 3)).toBe("●"); // 峰值停顿帧
    expect(frameAt(120 * 5)).toBe("∙"); // 回落
    expect(frameAt(120 * 6)).toBe("∙"); // 取模回卷：与上一帧连成"屏息"
    expect(frameAt(120 * 7)).toBe("•");
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
