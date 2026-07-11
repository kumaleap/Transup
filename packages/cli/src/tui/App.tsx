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
import {Box, Static, Text, useApp, useInput, usePaste} from "./runtime/index.js";
import {
  AgentEngine,
  SessionStore,
  isAllowed,
  persistAllow,
  type AgentEvent,
  type Message,
  type Provider,
  type Settings,
  type Tool,
} from "@transup/core";
import { color } from "../ui.js";
import { T } from "../theme.js";
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
import {
  PermissionDialog,
  type PermissionDecision,
  type PermissionRequest,
} from "./PermissionDialog.js";
import { StatusBar, type StatusInfo } from "./StatusBar.js";
import {
  normalizeKeystroke,
  routeKeystroke,
  type Keystroke,
} from "./input/keybinding-router.js";
import {useInputController} from "./input/use-input-controller.js";

export interface AppProps {
  provider: Provider;
  projectContext: string;
  tools: Tool[];
  settings: Settings;
  initialSessionId: string;
  initialHistory: Message[];
  mcpToolCount: number;
  /** 显示在首屏横幅上的版本号（入口从 package.json 读出传入） */
  version?: string;
  trace?: {
    record: (event: AgentEvent) => Promise<void>;
  };
  /** 会话持久化目录覆盖（测试用）；不传用默认目录 */
  sessionDir?: string;
  /** 项目提示历史文件覆盖（测试用）；不传写入 cwd/.transup/history.jsonl */
  historyPath?: string;
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

/** 紧凑 token 数：1234 → 1.2k，12345 → 12k */
function fmtTokens(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "") + "k" : String(n);
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
  const runningRef = useRef(false);
  const submitPendingRef = useRef(false);
  const abortExitArmedRef = useRef(false);
  const sessionAllowed = useRef(new Set<string>());
  const totals = useRef({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const permissionRef = useRef<PermissionRequest | null>(null);
  // 本轮起始时间戳与实时累计用量 —— 渲染时读取，展示执行时长 / tokens
  const turnStartRef = useRef(0);
  const liveUsage = useRef({ input: 0, output: 0 });

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

  // ── 首屏横幅（logo + 版本 + 模型/目录/会话/MCP 状态） ─────
  useEffect(() => {
    push({
      kind: "banner",
      info: {
        version: props.version ?? "dev",
        providerId: props.provider.id,
        model: props.provider.model,
        sessionId: props.initialSessionId,
        resumedMessages: props.initialHistory.length,
        cwd: process.cwd(),
        mcpToolCount: props.mcpToolCount,
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 运行期心跳 ────────────────────────────────────────────
  // 整轮运行期间跑一个 120ms 心跳：驱动 spinner 动画，同时让执行时长与
  // 实时 tokens 每帧重渲染（覆盖 思考 / 工具执行 / 流式 三个子状态）。
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setSpinnerTick((n) => n + 1), 120);
    return () => clearInterval(t);
  }, [running]);

  const inputController = useInputController({
    active: !running,
    historyPath: props.historyPath,
    onSubmit,
    onExit: exit,
    onHistoryError: (error) => {
      const detail = error instanceof Error ? error.message : String(error);
      info(`Prompt history unavailable: ${detail}`, "yellow");
    },
  });

  const resolveCurrentPermission = (decision: PermissionDecision): boolean => {
    const request = permissionRef.current;
    if (!request) return false;
    permissionRef.current = null;
    request.resolve(decision);
    return true;
  };

  // ── 全局输入与交互上下文路由 ──────────────────────────────
  const handleGlobalKey = (stroke: Keystroke): boolean => {
    if (!(stroke.ctrl && stroke.input === "c")) return false;
    if (abortExitArmedRef.current) {
      inputController.requestExit();
      return true;
    }
    if (!runningRef.current) return inputController.handleGlobalKey(stroke);

    if (controllerRef.current?.signal.aborted) {
      abortExitArmedRef.current = true;
      inputController.requestExit();
      return true;
    }
    // 权限对话框挂起时引擎在等 canUseTool —— 先替用户答"否"
    resolveCurrentPermission("no");
    info("⚠ 正在中断当前任务…（再按一次 Ctrl+C 退出）", "yellow");
    abortExitArmedRef.current = true;
    controllerRef.current?.abort();
    return true;
  };

  const handlePermissionKey = (stroke: Keystroke): boolean => {
    if (stroke.input === "y" || stroke.name === "return") {
      return resolveCurrentPermission("yes");
    }
    if (stroke.input === "n" || stroke.name === "escape") {
      return resolveCurrentPermission("no");
    }
    if (stroke.input === "a") return resolveCurrentPermission("session");
    if (stroke.input === "A") return resolveCurrentPermission("always");
    return false;
  };

  useInput((input, key) => {
    const stroke = normalizeKeystroke(input, key);
    if (!(stroke.ctrl && stroke.input === "c")) {
      abortExitArmedRef.current = false;
    }
    routeKeystroke(stroke, permission ? "permission" : "editor", {
      global: handleGlobalKey,
      permission: handlePermissionKey,
      editor: (editorStroke) =>
        submitPendingRef.current || inputController.handleEditorKey(editorStroke),
    });
  });

  usePaste((text) => {
    abortExitArmedRef.current = false;
    if (!submitPendingRef.current) inputController.handlePaste(text);
  }, {
    isActive: !running && !permission,
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
        runningRef.current = true;
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
          runningRef.current = false;
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
    abortExitArmedRef.current = false;
    runningRef.current = true;
    turnStartRef.current = Date.now();
    liveUsage.current = { input: 0, output: 0 };
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
        await props.trace?.record(ev);
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
            // 供运行期活动行实时展示（每个模型往返更新一次）
            liveUsage.current = { input: turnUsage.input, output: turnUsage.output };
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
      runningRef.current = false;
      submitPendingRef.current = false;
      setRunning(false);
    }
  }

  // display：可见串（大段粘贴已折叠成占位符），进记录区与斜杠命令解析；
  // expanded：占位符还原后的全文，真正喂给引擎
  async function onSubmit(display: string, expanded: string) {
    if (submitPendingRef.current) return;
    submitPendingRef.current = true;
    abortExitArmedRef.current = false;

    if (display === "exit" || display === "quit") {
      inputController.requestExit();
      return;
    }
    push({ kind: "user", text: display });
    const startTurn = () => {
      void runTurn(expanded).catch((error) => {
        submitPendingRef.current = false;
        const detail = error instanceof Error ? error.message : String(error);
        info(`API 错误: ${detail}`, "red");
      });
    };
    if (!display.startsWith("/")) {
      startTurn();
      return;
    }

    try {
      if (await handleSlashCommand(display)) {
        submitPendingRef.current = false;
        return;
      }
      startTurn();
    } catch (error) {
      submitPendingRef.current = false;
      const detail = error instanceof Error ? error.message : String(error);
      info(`命令错误: ${detail}`, "red");
    }
  }

  // ── 渲染 ──────────────────────────────────────────────────
  // 扫描式 spinner：一个光点在轨道上来回，比转圈更"仪器感"
  const SPINNER = ["▰▱▱▱▱", "▱▰▱▱▱", "▱▱▰▱▱", "▱▱▱▰▱", "▱▱▱▱▰", "▱▱▱▰▱", "▱▱▰▱▱", "▱▰▱▱▱"];

  // 运行期活动状态：英文状态词 + 执行时长 + 实时累计 tokens
  const elapsedSec = running ? Math.max(0, Math.floor((Date.now() - turnStartRef.current) / 1000)) : 0;
  const statusWord = activeTool
    ? `Running ${activeTool.name}`
    : streamText
      ? "Responding"
      : "Thinking";
  const meter = `${elapsedSec}s · ↑${fmtTokens(liveUsage.current.input)} ↓${fmtTokens(liveUsage.current.output)}`;

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
            <Text color={T.secondary}>◆ {activeTool.name}</Text>
            <Text dimColor>({activeTool.argSummary})</Text>
          </Text>
          {activeTool.tail.length > 0 && (
            <Text dimColor>
              {activeTool.tail.map((l) => `  │ ${l}`).join("\n")}
            </Text>
          )}
        </Box>
      )}

      {running && (
        <Box marginTop={1}>
          <Text color={T.primary}>{SPINNER[spinnerTick % SPINNER.length]} </Text>
          <Text dimColor>
            {statusWord}… · {meter}
          </Text>
        </Box>
      )}

      <Box flexDirection="column" marginTop={1}>
        {permission ? (
          <PermissionDialog request={permission} />
        ) : (
          // 圆角边框把输入框上下框起来，跟上方记录区在视觉上分隔开
          <Box borderStyle="round" borderColor={T.border} paddingX={1}>
            <TextInput
              view={inputController.view}
              onContentWidthChange={inputController.setContentWidth}
            />
          </Box>
        )}
        <StatusBar status={status} />
      </Box>
    </Box>
  );
}
