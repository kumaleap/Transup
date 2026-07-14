/**
 * 终端标题与任务进度（规格 05 §3.4）
 *
 * 忙碌时标题前缀在 ⠂/⠐ 两帧间 960ms 轮换，空闲时静态 ✳；
 * 同时用 OSC 9;4 让支持的终端（Ghostty / iTerm2 / Windows Terminal）
 * 在标签页上显示任务进行中的指示。
 *
 * 关键决定：动画不进 React —— 960ms 的 tick 只是往 stdout 写一个控制串，
 * 不 setState。我们用的是官方 Ink（没有 Claude Code 那套叶子隔离 +
 * OffscreenFreeze 的自研渲染器），一次 setState 就是整棵树重渲；
 * 让标题动画去驱动渲染纯属浪费。
 */
import { useEffect, useRef } from "react";
import { progressSequence, setTitleSequence } from "./osc.js";
import { defaultTerminalWriter, type TerminalWriter } from "./writer.js";

const BUSY_FRAMES = ["⠂", "⠐"];
const IDLE_MARK = "✳";
const FRAME_MS = 960;

export interface TerminalStatus {
  busy: boolean;
  /** 标题正文，如 "transup — my-project" */
  text: string;
}

/** 标题字符串（纯函数，可单测） */
export function titleFor(status: TerminalStatus, frame: number): string {
  const mark = status.busy ? BUSY_FRAMES[frame % BUSY_FRAMES.length] : IDLE_MARK;
  return `${mark} ${status.text}`;
}

function applyTitle(title: string, write: TerminalWriter): void {
  // Windows 终端历来不认 OSC 0，但认进程标题
  if (process.platform === "win32") {
    process.title = title;
    return;
  }
  write(setTitleSequence(title));
}

export function useTerminalStatus(
  status: TerminalStatus,
  write: TerminalWriter = defaultTerminalWriter,
): void {
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    let frame = 0;
    applyTitle(titleFor(statusRef.current, frame), write);
    write(progressSequence(status.busy ? "indeterminate" : "clear"));

    if (!status.busy) return;
    const timer = setInterval(() => {
      frame += 1;
      applyTitle(titleFor(statusRef.current, frame), write);
    }, FRAME_MS);
    return () => clearInterval(timer);
  }, [status.busy, status.text, write]);

  // 退出时收拾干净：清进度指示，标题让回终端默认（否则残留在标签页上）
  useEffect(
    () => () => {
      write(progressSequence("clear"));
      applyTitle("", write);
    },
    [write],
  );
}
