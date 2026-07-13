/**
 * 插槽化布局（规格 05 §1.3）
 *
 * Claude Code 的 FullscreenLayout 分 fullscreen / 非 fullscreen 两支，
 * 我们只做后者：顺序渲染 + 依赖终端原生 scrollback。alt-screen + 虚拟滚动
 * + 鼠标那一整套的前提是自研渲染器（双缓冲 cell diff + 原子换帧），
 * 用官方 Ink 硬做只会得到一个会闪的半成品 —— 取舍记在 05 落地文档里。
 *
 * 插槽语义：
 *   scrollable  已完成记录（Static）+ 动态区 —— 会被滚出视口
 *   overlay     浮在输入之上的临时 UI（权限对话框）
 *   bottom      常驻底部、永不被滚走（flexShrink=0）：输入框 / 模式指示 / 状态栏
 *
 * rootRef / bottomRef 透传给 useBoxMetrics —— 输入框的光标声明要靠它们
 * 量出祖先几何，布局重构不能把这两个测量锚点弄丢。
 */
import React, { type ReactNode, type Ref } from "react";
import { Box, type DOMElement } from "./runtime/index.js";

export interface LayoutProps {
  rootRef: Ref<DOMElement | null>;
  bottomRef: Ref<DOMElement | null>;
  scrollable: ReactNode;
  overlay?: ReactNode;
  bottom?: ReactNode;
}

export function Layout({ rootRef, bottomRef, scrollable, overlay, bottom }: LayoutProps) {
  return (
    <Box ref={rootRef} flexDirection="column">
      {scrollable}
      <Box ref={bottomRef} flexDirection="column" flexShrink={0} marginTop={1}>
        {overlay}
        {bottom}
      </Box>
    </Box>
  );
}
