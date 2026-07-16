// 流式按行上屏（对应 docs/claude-code-interactions/02 §2.1）：
// 流式文本只显示到最后一个换行，未完成的当前行隐藏——文本一行一行出现，
// 不是打字机逐字。CRLF 不特殊处理，一律按 \n 切。
// 关键约束：纯模块，不 import React/Ink。

/** 返回 text 中已完整的行（含末尾 \n）；没有换行时返回 ''。 */
export function visibleStreamLines(text: string): string {
  return text.slice(0, text.lastIndexOf("\n") + 1);
}

/** 是否存在未上屏的半行尾巴（供渲染层决定 spinner 状态词等）。 */
export function hasHiddenTail(text: string): boolean {
  return text.length > text.lastIndexOf("\n") + 1;
}
