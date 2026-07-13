/** 终端集成：OSC 序列构造、复用器穿透、通知频道探测、标题动画帧 */
import { describe, it, expect } from "vitest";
import {
  bellSequence,
  detectMultiplexer,
  ghosttyNotifySequence,
  iterm2NotifySequence,
  kittyNotifySequence,
  progressSequence,
  sanitize,
  setTitleSequence,
  wrapForMultiplexer,
} from "../src/tui/terminal/osc.js";
import { detectNotifyChannel, notifySequence } from "../src/tui/terminal/notify.js";
import { titleFor } from "../src/tui/terminal/use-terminal-status.js";

const ESC = "\x1b";
const BEL = "\x07";

describe("OSC 序列", () => {
  it("OSC 0 设置标题；控制字符与 ANSI 被剥掉（否则会截断序列本身）", () => {
    expect(setTitleSequence("transup — demo")).toBe(`${ESC}]0;transup — demo${BEL}`);
    expect(sanitize(`\x1b[31m红\x1b[0m${BEL}字`)).toBe("红 字");
    expect(setTitleSequence(`a${BEL}b`)).not.toContain(`a${BEL}b`);
  });

  it("OSC 9;4 进度：clear/indeterminate/progress/error 各自的状态码", () => {
    expect(progressSequence("clear")).toBe(`${ESC}]9;4;0;0${BEL}`);
    expect(progressSequence("indeterminate")).toBe(`${ESC}]9;4;3;0${BEL}`);
    expect(progressSequence("progress", 42.4)).toBe(`${ESC}]9;4;1;42${BEL}`);
    expect(progressSequence("error")).toBe(`${ESC}]9;4;2;0${BEL}`);
    expect(progressSequence("progress", 999)).toContain(";100"); // 百分比夹紧
  });

  it("各终端的通知协议各不相同", () => {
    expect(iterm2NotifySequence("完成")).toBe(`${ESC}]9;完成${BEL}`);
    expect(kittyNotifySequence("Transup", "完成")).toContain("]99;i=1:d=0:p=title;Transup");
    expect(kittyNotifySequence("Transup", "完成")).toContain("]99;i=1:p=body;完成");
    expect(ghosttyNotifySequence("Transup", "完成")).toBe(`${ESC}]777;notify;Transup;完成${BEL}`);
    expect(bellSequence()).toBe(BEL);
  });
});

describe("复用器穿透", () => {
  it("探测：TMUX → tmux，TERM=screen* → screen，否则 none", () => {
    expect(detectMultiplexer({ TMUX: "/tmp/tmux-501/default,1,0" })).toBe("tmux");
    expect(detectMultiplexer({ TERM: "screen.xterm-256color" })).toBe("screen");
    expect(detectMultiplexer({ TERM: "xterm-256color" })).toBe("none");
  });

  it("tmux：DCS 包裹且内部 ESC 加倍（否则 ESC 会提前终止 DCS）", () => {
    const wrapped = wrapForMultiplexer(`${ESC}]9;hi${BEL}`, "tmux");
    expect(wrapped).toBe(`${ESC}Ptmux;${ESC}${ESC}]9;hi${BEL}${ESC}\\`);
  });

  it("screen：DCS 原样透传；none：不动", () => {
    expect(wrapForMultiplexer(`${ESC}]9;hi${BEL}`, "screen")).toBe(
      `${ESC}P${ESC}]9;hi${BEL}${ESC}\\`,
    );
    expect(wrapForMultiplexer(`${ESC}]9;hi${BEL}`, "none")).toBe(`${ESC}]9;hi${BEL}`);
  });
});

describe("通知频道", () => {
  it("auto：按终端标识猜，猜不中响铃", () => {
    expect(detectNotifyChannel({ TERM_PROGRAM: "iTerm.app" })).toBe("iterm2");
    expect(detectNotifyChannel({ TERM_PROGRAM: "ghostty" })).toBe("ghostty");
    expect(detectNotifyChannel({ TERM: "xterm-kitty" })).toBe("kitty");
    expect(detectNotifyChannel({ KITTY_WINDOW_ID: "1" })).toBe("kitty");
    expect(detectNotifyChannel({ TERM_PROGRAM: "Apple_Terminal" })).toBe("bell");
    expect(detectNotifyChannel({})).toBe("bell");
  });

  it("TRANSUP_NOTIF_CHANNEL 覆盖自动探测，off 可完全关掉", () => {
    expect(detectNotifyChannel({ TERM_PROGRAM: "iTerm.app", TRANSUP_NOTIF_CHANNEL: "bell" })).toBe(
      "bell",
    );
    expect(detectNotifyChannel({ TRANSUP_NOTIF_CHANNEL: "off" })).toBe("off");
    expect(detectNotifyChannel({ TRANSUP_NOTIF_CHANNEL: "胡说" })).toBe("off"); // 无法识别 → 静默
  });

  it("off 不产生序列；BEL 不被 DCS 包裹（tmux 只认裸 BEL）", () => {
    const n = { title: "Transup", body: "完成" };
    expect(notifySequence("off", n)).toBeNull();
    expect(notifySequence("bell", n, { TMUX: "1" })).toBe(BEL);
    expect(notifySequence("iterm2", n, { TMUX: "1" })).toContain("Ptmux;");
  });
});

describe("标题动画", () => {
  it("忙碌时两帧轮换，空闲时静态 ✳", () => {
    const busy = { busy: true, text: "transup — demo" };
    expect(titleFor(busy, 0)).toBe("⠂ transup — demo");
    expect(titleFor(busy, 1)).toBe("⠐ transup — demo");
    expect(titleFor(busy, 2)).toBe("⠂ transup — demo"); // 回环
    expect(titleFor({ busy: false, text: "transup — demo" }, 7)).toBe("✳ transup — demo");
  });
});
