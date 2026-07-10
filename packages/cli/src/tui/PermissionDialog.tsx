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
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={T.warn} paddingX={1}>
      <Text color={T.warn}>
        ◈ 权限请求 —— 模型想执行 <Text bold>{request.toolName}</Text>
      </Text>
      <Text>{request.preview}</Text>
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
