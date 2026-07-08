/**
 * 权限确认对话框 —— 单键选择，不用回车
 *
 * 预览内容（diff 等）由外部生成好 ANSI 字符串传入，
 * Ink 的 <Text> 原样透传 ANSI 码。
 */
import React from "react";
import { Box, Text, useInput } from "ink";

export type PermissionDecision = "yes" | "no" | "session" | "always";

export interface PermissionRequest {
  toolName: string;
  /** 已渲染好的 ANSI 预览（diff / 参数 JSON） */
  preview: string;
  resolve: (d: PermissionDecision) => void;
}

export function PermissionDialog({ request }: { request: PermissionRequest }) {
  useInput((input, key) => {
    if (input === "y" || key.return) request.resolve("yes");
    else if (input === "n" || key.escape) request.resolve("no");
    else if (input === "a") request.resolve("session");
    else if (input === "A") request.resolve("always");
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow">
        ⚠ 模型请求执行 <Text bold>{request.toolName}</Text>
      </Text>
      <Text>{request.preview}</Text>
      <Text color="yellow">
        允许吗? <Text bold>[y]</Text>是 <Text bold>[n]</Text>否{" "}
        <Text bold>[a]</Text>本会话允许 <Text bold>[A]</Text>永久允许
      </Text>
    </Box>
  );
}
