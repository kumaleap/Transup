import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { StatusBar } from "../src/tui/StatusBar.js";
import {sanitizeTerminalField} from "../src/terminal-sanitize.js";
import {Box} from "../src/tui/runtime/index.js";

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {...actual, homedir: () => "/Users/kuma"};
});

const stripSgr = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

describe("StatusBar", () => {
  it("只显示净化后的模型和启动工作区", () => {
    const model = "m\x1b]52;c;dmVy\x07\x1b[2J\x9b31m\n\tok";
    expect(sanitizeTerminalField(model)).toBe("m]52;c;dmVy[2J31mok");
    const instance = render(
      <StatusBar
        model={model}
        cwd="/Users/kuma/workspace/Transup"
      />,
    );
    const frame = stripSgr(instance.lastFrame() ?? "");
    expect(frame.replace(/\n/g, "")).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expect(frame).toBe("◆ m]52;c;dmVy[2J31mok · ~/workspace/Transup");
    expect(frame).not.toMatch(/mcp|缓存|上下文|[↑↓▰▱%]/);
    instance.unmount();
  });

  it("窄终端把整条 footer 截成一行", () => {
    const instance = render(
      <Box width={20}>
        <StatusBar
          model="claude-sonnet-4-5-20250929"
          cwd="/Users/kuma/workspace/Transup"
        />
      </Box>,
    );
    const frame = stripSgr(instance.lastFrame() ?? "");
    expect(frame.split("\n")).toHaveLength(1);
    expect(frame).toHaveLength(20);
    expect(frame).toContain("…");
    instance.unmount();
  });
});
