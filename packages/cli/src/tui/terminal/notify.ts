/**
 * 桌面通知 —— 频道探测 + 序列生成（纯函数，IO 在 writer.ts）
 *
 * 没有跨终端统一的通知协议，只能按终端分发（规格 05 §3.5）：
 *   iTerm2 → OSC 9    kitty → OSC 99    Ghostty → OSC 777    其余 → 裸 BEL
 *
 * 频道选择：TRANSUP_NOTIF_CHANNEL 覆盖（auto|iterm2|kitty|ghostty|bell|off），
 * 缺省 auto 按终端标识猜。猜不中就响铃 —— 比静默失败强，用户也能关掉。
 */
import {
  bellSequence,
  detectMultiplexer,
  ghosttyNotifySequence,
  iterm2NotifySequence,
  kittyNotifySequence,
  wrapForMultiplexer,
} from "./osc.js";

export type NotifyChannel = "iterm2" | "kitty" | "ghostty" | "bell" | "off";

export interface Notification {
  title: string;
  body: string;
}

const EXPLICIT: Record<string, NotifyChannel> = {
  iterm2: "iterm2",
  kitty: "kitty",
  ghostty: "ghostty",
  bell: "bell",
  off: "off",
  none: "off",
};

export function detectNotifyChannel(env: NodeJS.ProcessEnv = process.env): NotifyChannel {
  const explicit = env.TRANSUP_NOTIF_CHANNEL?.toLowerCase();
  if (explicit && explicit !== "auto") return EXPLICIT[explicit] ?? "off";

  const program = env.TERM_PROGRAM?.toLowerCase() ?? "";
  if (program === "iterm.app") return "iterm2";
  if (program === "ghostty") return "ghostty";
  if (program === "kitty" || env.TERM === "xterm-kitty" || env.KITTY_WINDOW_ID) return "kitty";
  return "bell";
}

/**
 * 通知 → 待写入的序列（off 或空内容返回 null）。
 * BEL 不过复用器包裹：tmux 只认裸 BEL（包了就丢了 bell-action）。
 */
export function notifySequence(
  channel: NotifyChannel,
  notification: Notification,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (channel === "off") return null;
  if (channel === "bell") return bellSequence();

  const { title, body } = notification;
  const sequence =
    channel === "iterm2"
      ? iterm2NotifySequence(body)
      : channel === "kitty"
        ? kittyNotifySequence(title, body)
        : ghosttyNotifySequence(title, body);

  return wrapForMultiplexer(sequence, detectMultiplexer(env));
}
