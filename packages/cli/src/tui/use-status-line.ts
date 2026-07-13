/**
 * statusline 的 React 侧：300ms debounce + in-flight 取消
 *
 * 触发时机交给调用方（依赖数组变化 = 需要刷新）：一轮结束、权限模式
 * 切换、上下文水位变化。连续触发只跑最后一次；新触发到来时上一次还在
 * 跑就 abort 掉 —— 用户脚本再慢也不会堆积进程。
 */
import { useEffect, useState } from "react";
import {
  runStatusLineCommand,
  type StatusLineCommand,
  type StatusLineInput,
} from "./statusline.js";

const DEBOUNCE_MS = 300;

export function useStatusLine(
  config: StatusLineCommand | undefined,
  buildInput: () => StatusLineInput,
  /** 值变化即触发刷新（内容本身不重要） */
  refreshKey: unknown[],
): string | null {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    if (!config?.command) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void runStatusLineCommand(config, buildInput(), controller.signal).then((result) => {
        // abort 后 setState 也无妨（结果是 null），但别把旧结果盖掉新的
        if (!controller.signal.aborted && result !== null) setText(result);
        if (!controller.signal.aborted && result === null) setText(null);
      });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, refreshKey);

  return config?.command ? text : null;
}
