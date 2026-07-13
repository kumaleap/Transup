/**
 * 权限确认对话框 —— 单键选择，不用回车
 *
 * 预览内容（diff 等）由外部生成好 ANSI 字符串传入，
 * Ink 的 <Text> 原样透传 ANSI 码。
 */
import React from "react";
import {Box, Text} from "./runtime/index.js";
import { T } from "../theme.js";

export type PermissionDecision = "yes" | "no" | "session" | "always";

export interface PermissionRequest {
  toolName: string;
  /** 已渲染好的 ANSI 预览（diff / 参数 JSON） */
  preview: string;
  resolve: (d: PermissionDecision) => void;
}

/**
 * diff 预览的上下虚线外框（规格 §3.4：dashed、只有上下边、subtle 色）。
 * runtime（ink）没有内置 dashed borderStyle，但支持自定义 BoxStyle 字符集，
 * 配合 borderLeft/borderRight={false} 即得等效视觉，无需改 runtime。
 */
const dashedEdges = {
  topLeft: "╌",
  top: "╌",
  topRight: "╌",
  left: "",
  right: "",
  bottomLeft: "╌",
  bottom: "╌",
  bottomRight: "╌",
};

function Key({ k, label }: { k: string; label: string }) {
  return (
    <Text>
      <Text color={T.primary} bold>
        [{k}]
      </Text>
      <Text dimColor>{label} </Text>
    </Text>
  );
}

export function PermissionDialog({request}: {request: PermissionRequest}) {
  // 文件改动类工具的预览是 diff，包上下虚线框突出"这是一段代码变更"
  const isFileDiff =
    request.toolName === "edit_file" || request.toolName === "write_file";
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={T.warn} paddingX={1}>
      <Text color={T.warn}>
        ◈ 权限请求 —— 模型想执行 <Text bold>{request.toolName}</Text>
      </Text>
      {isFileDiff ? (
        <Box
          flexDirection="column"
          borderStyle={dashedEdges}
          borderLeft={false}
          borderRight={false}
          borderColor={T.border}
          borderDimColor
        >
          <Text>{request.preview}</Text>
        </Box>
      ) : (
        <Text>{request.preview}</Text>
      )}
      <Text>
        <Text color={T.warn}>允许吗? </Text>
        <Key k="y" label="是" />
        <Key k="n" label="否" />
        <Key k="a" label="本会话允许" />
        <Key k="A" label="永久允许" />
      </Text>
    </Box>
  );
}
