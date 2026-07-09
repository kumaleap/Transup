/**
 * Ink TUI 主组件
 *
 * 布局（自上而下）：
 *   <Static>  已完成的会话记录 —— 写入终端真实滚动缓冲，可往上翻
 *   动态区    正在流式输出的文本 / 运行中的工具（含 bash 实时输出尾巴）
 *   权限对话框（有请求时替换输入框）
 *   输入框    常驻底部
 *   状态栏    模型 · tokens · 上下文水位
 *
 * 引擎桥接：runTurn 的 AsyncGenerator 事件流在 useRef 的异步任务里消费，
 * 每个事件映射为 setState；canUseTool 挂起为 Promise，由权限对话框 resolve。
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import {
  AgentEngine,
  SessionStore,
  isAllowed,
  persistAllow,
  type Message,
  type Provider,
  type Settings,
  type Tool,
} from "@transup/core";
import { color } from "../ui.js";
import { renderEditPreview, renderWritePreview } from "../diff.js";
import { expandFileRefs } from "../input.js";
import { renderMarkdown } from "../highlight.js";
import {
  TranscriptItemView,
  formatArgs,
  previewResult,
  type TranscriptItem,
} from "./Transcript.js";
import { TextInput } from "./TextInput.js";
import { PermissionDialog, type PermissionRequest } from "./PermissionDialog.js";
import { StatusBar, type StatusInfo } from "./StatusBar.js";

export interface AppProps {
  provider: Provider;
  projectContext: string;
  tools: Tool[];
  settings: Settings;
  initialSessionId: string;
  initialHistory: Message[];
  mcpToolCount: number;
  /** 会话持久化目录覆盖（测试用）；不传用默认目录 */
  sessionDir?: string;
}

const HELP = `命令：
  /help          显示本帮助
  /clear         开始新会话（当前会话已持久化，可用 /sessions 找回）
  /compact       手动压缩上下文
  /cost          本次运行累计 token 用量
  /context       当前上下文水位
  /sessions      列出历史会话（用 --resume <id> 恢复）
  exit / quit    退出
输入技巧：
  @路径          引用文件，内容自动附加到消息（如 "解释 @src/index.ts"）
  Ctrl+C         任务运行中按一次中断任务，再按一次退出`;

function newSessionId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

interface ActiveTool {
  name: string;
  argSummary: string;
  /** bash 等长命令的实时输出（只留尾部几行） */
  tail: string[];
  streamed: boolean;
}

const TAIL_LINES = 6;

export function App(props: AppProps) {
  const { exit } = useApp();

  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [streamText, setStreamText] = useState("");
  const [activeTool, setActiveTool] = useState<ActiveTool | null>(null);
  const [permission, setPermission] = useState<PermissionRequest | null>(null);
  const [running, setRunning] = useState(false);
  const [spinnerTick, setSpinnerTick] = useState(0);

  const nextId = useRef(0);
  const engineRef = useRef<AgentEngine | null>(null);
  const sessionIdRef = useRef(props.initialSessionId);
  const controllerRef = useRef<AbortController | null>(null);
  const sessionAllowed = useRef(new Set<string>());
  const totals = useRef({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const permissionRef = useRef<PermissionRequest | null>(null);

  const [status, setStatus] = useState<StatusInfo>({
    providerId: props.provider.id,
    model: props.provider.model,
    sessionId: props.initialSessionId,
    totalInput: 0,
    totalOutput: 0,
    cacheRead: 0,
    contextPercent: 0,
    mcpToolCount: props.mcpToolCount,
  });

  // Omit 不分配到联合类型的每个成员上，手写分配式版本
  type NewItem = TranscriptItem extends infer T
    ? T extends TranscriptItem
      ? Omit<T, "id">
      : never
    : never;
  const push = useCallback((item: NewItem) => {
    setItems((prev) => [...prev, { ...item, id: nextId.current++ } as TranscriptItem]);
  }, []);

  const info = useCallback(
    (text: string, tone: "dim" | "green" | "yellow" | "red" = "dim") =>
      push({ kind: "info", text, tone }),
    [push],
  );

  // ── 引擎组装 ──────────────────────────────────────────────
  const canUseTool = useCallback(
    async (name: string, args: Record<string, unknown>): Promise<boolean> => {
      if (sessionAllowed.current.has(name)) return true;
      if (isAllowed(props.settings, name)) return true;

      const preview =
        name === "edit_file"
          ? renderEditPreview(args)
          : name === "write_file"
            ? renderWritePreview(args)
            : color.dim(JSON.stringify(args, null, 2));

      const decision = await new Promise<
        "yes" | "no" | "session" | "always"
      >((resolve) => {
        const req: PermissionRequest = { toolName: name, preview, resolve };
        permissionRef.current = req;
        setPermission(req);
      });
      permissionRef.current = null;
      setPermission(null);

      if (decision === "always") {
        await persistAllow(props.settings, name);
        return true;
      }
      if (decision === "session") {
        sessionAllowed.current.add(name);
        return true;
      }
      return decision === "yes";
    },
    [props.settings],
  );

  const createEngine = useCallback(
    (sessionId: string, history: Message[]) =>
      new AgentEngine({
        provider: props.provider,
        canUseTool,
        session: new SessionStore(sessionId, props.sessionDir),
        history,
        projectContext: props.projectContext,
        tools: props.tools,
      }),
    [props.provider, props.projectContext, props.tools, canUseTool],
  );

  if (engineRef.current === null) {
    engineRef.current = createEngine(props.initialSessionId, props.initialHistory);
  }

  // ── 首屏横幅 ──────────────────────────────────────────────
  useEffect(() => {
    info(
      color.bold(color.cyan("✻ Transup")) +
        color.dim(
          ` — ${props.provider.id}:${props.provider.model} · 会话 ${props.initialSessionId}`,
        ),
    );
    if (props.initialHistory.length > 0) {
      info(`已恢复 ${props.initialHistory.length} 条历史消息`);
    }
    if (props.mcpToolCount > 0) info(`已接入 ${props.mcpToolCount} 个 MCP 工具`);
    info("输入你的任务，/help 查看命令");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 思考中 spinner ────────────────────────────────────────
  const thinking = running && !streamText && !activeTool && !permission;
  useEffect(() => {
    if (!thinking) return;
    const t = setInterval(() => setSpinnerTick((n) => n + 1), 120);
    return () => clearInterval(t);
  }, [thinking]);

  // ── Ctrl+C：运行中先中断任务，空闲时退出 ──────────────────
  useInput((input, key) => {
    if (!(key.ctrl && input === "c")) return;
    if (running) {
      if (controllerRef.current?.signal.aborted) exit();
      // 权限对话框挂起时引擎在等 canUseTool —— 先替用户答"否"
      permissionRef.current?.resolve("no");
      info("⚠ 正在中断当前任务…（再按一次 Ctrl+C 退出）", "yellow");
      controllerRef.current?.abort();
    } else {
      exit();
    }
  });

  // ── 斜杠命令 ──────────────────────────────────────────────
  async function handleSlashCommand(input: string): Promise<boolean> {
    const cmd = input.split(/\s+/)[0];
    switch (cmd) {
      case "/help":
        info(HELP);
        return true;
      case "/clear": {
        const id = newSessionId();
        sessionIdRef.current = id;
        engineRef.current = createEngine(id, []);
        setStatus((s) => ({ ...s, sessionId: id, contextPercent: 0 }));
        info(`已开始新会话 ${id}`, "green");
        return true;
      }
      case "/compact": {
        setRunning(true);
        try {
          for await (const ev of engineRef.current!.compactNow()) {
            if (ev.type === "compact_end") {
              if (ev.ok) info(`压缩完成（${Math.round(ev.afterChars / 1000)}k 字符）`, "green");
              else info("压缩失败", "red");
            }
          }
          const { percent } = engineRef.current!.contextUsage();
          setStatus((s) => ({ ...s, contextPercent: percent }));
        } finally {
          setRunning(false);
        }
        return true;
      }
      case "/cost": {
        const t = totals.current;
        const cache =
          t.cacheRead > 0 || t.cacheWrite > 0
            ? `\n  缓存命中 ${t.cacheRead} / 写入 ${t.cacheWrite}`
            : "";
        info(`累计 tokens：输入 ${t.input} / 输出 ${t.output}${cache}`);
        return true;
      }
      case "/context": {
        const { chars, percent } = engineRef.current!.contextUsage();
        info(`上下文：${Math.round(chars / 1000)}k 字符（预算的 ${percent}%）`);
        return true;
      }
      case "/sessions": {
        const ids = await SessionStore.list();
        if (ids.length === 0) {
          info("暂无历史会话");
        } else {
          const lines = ids
            .slice(0, 10)
            .map((id) => `  ${id === sessionIdRef.current ? "▸" : " "} ${id}`);
          info(lines.join("\n") + "\n恢复方式：npm start -- --resume <id>");
        }
        return true;
      }
      default:
        if (cmd.startsWith("/")) {
          info(`未知命令 ${cmd}，输入 /help 查看可用命令`, "red");
          return true;
        }
        return false;
    }
  }

  // ── 一轮任务 ──────────────────────────────────────────────
  async function runTurn(raw: string) {
    const input = expandFileRefs(raw);
    const controller = new AbortController();
    controllerRef.current = controller;
    setRunning(true);

    // 流式文本用 ref 累积（setState 是异步的，flush 时要拿到最新值）
    let stream = "";
    let tool: ActiveTool | null = null;
    const flushStream = () => {
      if (stream.trim()) push({ kind: "assistant", text: stream.trimEnd() });
      stream = "";
      setStreamText("");
    };
    const turnUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

    try {
      for await (const ev of engineRef.current!.runTurn(input, controller.signal)) {
        switch (ev.type) {
          case "text_delta":
            stream += ev.text;
            setStreamText(stream);
            break;
          case "tool_start":
            flushStream();
            tool = {
              name: ev.call.name,
              argSummary: formatArgs(ev.parsedArgs),
              tail: [],
              streamed: false,
            };
            setActiveTool(tool);
            break;
          case "tool_progress":
            if (tool) {
              tool.streamed = true;
              const lines = (tool.tail.join("\n") + ev.chunk).split("\n");
              tool.tail = lines.slice(-TAIL_LINES);
              setActiveTool({ ...tool });
            }
            break;
          case "tool_end": {
            const streamed = tool?.streamed ?? false;
            push({
              kind: "tool",
              name: ev.call.name,
              argSummary: tool?.argSummary ?? "",
              preview: previewResult(ev.content, streamed && !ev.isError),
              isError: ev.isError,
            });
            tool = null;
            setActiveTool(null);
            break;
          }
          case "usage":
            turnUsage.input += ev.usage.inputTokens;
            turnUsage.output += ev.usage.outputTokens;
            turnUsage.cacheRead += ev.usage.cacheReadTokens ?? 0;
            turnUsage.cacheWrite += ev.usage.cacheWriteTokens ?? 0;
            break;
          case "stream_retry":
            // 半截流式文本作废（引擎会整条重发），清掉避免和重试后的输出重复
            stream = "";
            setStreamText("");
            info(
              `⚠ 模型调用失败（${ev.error}），${Math.round(ev.delayMs / 1000)}s 后重试 ${ev.attempt}/${ev.maxAttempts}…`,
              "yellow",
            );
            break;
          case "auto_continue":
            flushStream();
            info(
              ev.reason === "truncated"
                ? "⟳ 输出被长度限制截断，自动续跑…"
                : "⟳ 模型返回了空回复，自动催跑…",
              "yellow",
            );
            break;
          case "compact_start":
            info("⟳ 上下文接近上限，正在压缩…", "yellow");
            break;
          case "compact_end":
            if (ev.ok) info(`⟳ 压缩完成（${Math.round(ev.afterChars / 1000)}k 字符）`, "green");
            else info("⟳ 压缩失败，已退回截断策略", "red");
            break;
          case "turn_end":
            if (ev.reason === "max_iterations") info("已达到单轮最大迭代次数，强制停止。", "red");
            else if (ev.reason === "aborted") info("任务已中断。", "yellow");
            else if (ev.reason === "loop_detected")
              info("检测到模型在重复相同的调用（循环空转），已强制停止本轮。", "red");
            break;
        }
      }
    } catch (err: any) {
      info(`API 错误: ${err.message}`, "red");
    } finally {
      flushStream();
      setActiveTool(null);

      const t = totals.current;
      t.input += turnUsage.input;
      t.output += turnUsage.output;
      t.cacheRead += turnUsage.cacheRead;
      t.cacheWrite += turnUsage.cacheWrite;
      const { percent } = engineRef.current!.contextUsage();
      setStatus((s) => ({
        ...s,
        totalInput: t.input,
        totalOutput: t.output,
        cacheRead: t.cacheRead,
        contextPercent: percent,
      }));

      controllerRef.current = null;
      setRunning(false);
    }
  }

  async function onSubmit(raw: string) {
    if (raw === "exit" || raw === "quit") {
      exit();
      return;
    }
    push({ kind: "user", text: raw });
    if (await handleSlashCommand(raw)) return;
    void runTurn(raw);
  }

  // ── 渲染 ──────────────────────────────────────────────────
  const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  return (
    <Box flexDirection="column">
      <Static items={items}>
        {(item) => <TranscriptItemView key={item.id} item={item} />}
      </Static>

      {streamText && (
        <Box marginTop={1}>
          <Text>{renderMarkdown(streamText)}</Text>
        </Box>
      )}

      {activeTool && (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text color="magenta">⏺ {activeTool.name}</Text>
            <Text dimColor>({activeTool.argSummary})</Text>
            <Text color="yellow"> 运行中…</Text>
          </Text>
          {activeTool.tail.length > 0 && (
            <Text dimColor>
              {activeTool.tail.map((l) => `  │ ${l}`).join("\n")}
            </Text>
          )}
        </Box>
      )}

      {thinking && (
        <Box marginTop={1}>
          <Text color="cyan">{SPINNER[spinnerTick % SPINNER.length]} </Text>
          <Text dimColor>思考中…（Ctrl+C 中断）</Text>
        </Box>
      )}

      <Box flexDirection="column" marginTop={1}>
        {permission ? (
          <PermissionDialog request={permission} />
        ) : (
          <TextInput onSubmit={onSubmit} active={!running} />
        )}
        <StatusBar status={status} />
      </Box>
    </Box>
  );
}
