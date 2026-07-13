/**
 * 终端带外写入器
 *
 * 为什么不走 Ink 的 useStdout().write：Ink 的 stdout 是帧通道 ——
 * 写进去的东西会被当成"一帧"参与 diff/清屏。而 OSC 标题、进度、通知
 * 是零视觉足迹的控制串，跟渲染帧无关，直接写 process.stdout 才对。
 *
 * TTY 门控：管道 / CI / 测试环境下这些序列没有意义（还会污染 stdout），
 * 一律不写。测试要断言序列时注入自己的 sink。
 */
export type TerminalWriter = (sequence: string) => void;

export const defaultTerminalWriter: TerminalWriter = (sequence) => {
  if (process.stdout.isTTY) process.stdout.write(sequence);
};
