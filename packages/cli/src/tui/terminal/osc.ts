/**
 * 终端控制序列（OSC）—— 纯字符串构造，不碰 IO
 *
 * 这些序列走的是"带外通道"：它们不属于渲染帧，直接写给终端模拟器，
 * 用来设置窗口标题、报告进度、发桌面通知。跟 Ink 的帧缓冲互不干扰。
 *
 * 复用器穿透（wrapForMultiplexer）：tmux/screen 默认吞掉不认识的 OSC，
 * 必须用 DCS 包一层才能透传给外层真实终端。tmux 还要求把内部的 ESC
 * 加倍转义（否则 ESC 会提前终止 DCS）。
 *
 * 例外：BEL 不能包 —— tmux 只有收到裸 BEL 才会触发 bell-action 标记窗口。
 */

/** ESC */
const ESC = "\x1b";
/** 字符串终止符：BEL 形式（兼容性最好） */
const BEL = "\x07";
/** 字符串终止符：ST 形式（kitty 通知协议要求） */
const ST = `${ESC}\\`;

export type Multiplexer = "tmux" | "screen" | "none";

export function detectMultiplexer(env: NodeJS.ProcessEnv = process.env): Multiplexer {
  if (env.TMUX) return "tmux";
  if (env.TERM?.startsWith("screen") || env.STY) return "screen";
  return "none";
}

/**
 * 用 DCS 把 OSC 包进复用器穿透序列。
 * tmux：ESC 必须加倍；screen：原样透传即可。
 */
export function wrapForMultiplexer(sequence: string, mux: Multiplexer): string {
  if (mux === "tmux") {
    return `${ESC}Ptmux;${sequence.replaceAll(ESC, ESC + ESC)}${ST}`;
  }
  if (mux === "screen") {
    return `${ESC}P${sequence}${ST}`;
  }
  return sequence;
}

/** 标题/通知文本里的控制字符会截断序列本身 —— 一律剥掉 */
export function sanitize(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f]/g, " ").trim();
}

/** OSC 0：同时设置窗口标题与图标名 */
export function setTitleSequence(title: string): string {
  return `${ESC}]0;${sanitize(title)}${BEL}`;
}

/**
 * OSC 9;4：任务进度（ConEmu 提出，Ghostty / iTerm2 / Windows Terminal 支持）
 *   clear 清除 · indeterminate 转圈 · progress 百分比 · error 红色
 */
export type ProgressState = "clear" | "indeterminate" | "progress" | "error";

const PROGRESS_CODE: Record<ProgressState, number> = {
  clear: 0,
  progress: 1,
  error: 2,
  indeterminate: 3,
};

export function progressSequence(state: ProgressState, percent = 0): string {
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  return `${ESC}]9;4;${PROGRESS_CODE[state]};${pct}${BEL}`;
}

// ── 桌面通知：各家终端各一套协议 ──────────────────────────

/** iTerm2：OSC 9，只有正文 */
export function iterm2NotifySequence(body: string): string {
  return `${ESC}]9;${sanitize(body)}${BEL}`;
}

/**
 * kitty：OSC 99 分段协议 —— 先送标题（d=0 表示"还没完"），再送正文并收尾。
 * i=1 是通知 id：同 id 的后续段落会合并进同一条通知。
 */
export function kittyNotifySequence(title: string, body: string): string {
  const head = `${ESC}]99;i=1:d=0:p=title;${sanitize(title)}${ST}`;
  const tail = `${ESC}]99;i=1:p=body;${sanitize(body)}${ST}`;
  return head + tail;
}

/** Ghostty：OSC 777（rxvt 传统），title;body */
export function ghosttyNotifySequence(title: string, body: string): string {
  return `${ESC}]777;notify;${sanitize(title)};${sanitize(body)}${BEL}`;
}

/** 裸 BEL —— 兜底方案，也是唯一不该被 DCS 包裹的序列 */
export function bellSequence(): string {
  return BEL;
}
