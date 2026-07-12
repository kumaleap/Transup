/**
 * 首屏横幅组件 —— 薄包装：拿到终端宽度，渲染交给 banner-render.ts
 * （纯字符串、可测试）。作为 transcript 条目进 <Static>，属于会话
 * 记录的一部分（写入真实滚动缓冲，往上翻还能看到）。
 */
import React from "react";
import {Text} from "./runtime/index.js";
import { renderBanner, type BannerInfo } from "./banner-render.js";

export type { BannerInfo };

export function Banner({ info }: { info: BannerInfo }) {
  return <Text>{renderBanner(info, process.stdout.columns ?? 92)}</Text>;
}
