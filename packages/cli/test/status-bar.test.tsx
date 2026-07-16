import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { StatusBar, type StatusInfo } from "../src/tui/StatusBar.js";

const stripSgr = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

describe("StatusBar", () => {
  it("净化 model 和 provider 结构元数据", () => {
    const status: StatusInfo = {
      model: "m\x1b]52;c;dmVy\x07\x1b[2J\x9b31m\n\tok",
      providerId: "p\x1b]52;c;cHJvdmlkZXI=\x07\x1b[2J\x9b31m\n\tok",
      sessionId: "session",
      totalInput: 0,
      totalOutput: 0,
      cacheRead: 0,
      contextPercent: 0,
      mcpToolCount: 0,
    };

    const instance = render(<StatusBar status={status} />);
    const frame = stripSgr(instance.lastFrame() ?? "");
    expect(frame.replace(/\n/g, "")).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expect(frame).toContain("m]52;c;dmVy[2J31mok");
    expect(frame).toContain("p]52;c;cHJvdmlkZXI=[2J31mok");
    instance.unmount();
  });
});
