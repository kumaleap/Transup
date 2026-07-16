/**
 * 光标样式（DECSCUSR，CSI Ps SP q）
 *
 * 进入 TUI 时把终端光标设为闪烁块：多数终端默认是不闪的实心块，
 * 而输入框依赖真实终端光标指示插入点（IME 定位也靠它），不闪就
 * 很难在文本里找到光标。退出时还原终端默认样式，不残留设置。
 *
 * tmux/screen 原生理解 DECSCUSR（Ss/Se），无需 DCS 穿透包裹。
 */
import { useEffect } from "react";
import { defaultTerminalWriter, type TerminalWriter } from "./writer.js";

/** DECSCUSR 1：闪烁块光标 */
export const CURSOR_BLINK_BLOCK = "\x1b[1 q";
/** DECSCUSR 0：还原终端默认光标样式 */
export const CURSOR_STYLE_RESET = "\x1b[0 q";

export function useCursorStyle(write: TerminalWriter = defaultTerminalWriter): void {
  useEffect(() => {
    write(CURSOR_BLINK_BLOCK);
    return () => write(CURSOR_STYLE_RESET);
  }, [write]);
}
