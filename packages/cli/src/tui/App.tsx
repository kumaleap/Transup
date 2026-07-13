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
import { basename } from "node:path";
import {
  Box,
  Static,
  Text,
  useApp,
  useBoxMetrics,
  useInput,
  usePaste,
  useWindowSize,
  type DOMElement,
} from "./runtime/index.js";
import {
  AgentEngine,
  SessionStore,
  evaluatePermission,
  nextPermissionMode,
  persistPermissionRule,
  settingsRules,
  type AgentEvent,
  type Message,
  type PermissionDecision,
  type PermissionMode,
  type PermissionRules,
  type PermissionUpdate,
  type Provider,
  type Settings,
  type Tool,
} from "@transup/core";
import { T } from "../theme.js";
import { expandFileRefs } from "../input.js";
import { renderMarkdown } from "../highlight.js";
import {
  TranscriptItemView,
  formatArgs,
  previewResult,
  type TranscriptItem,
} from "./Transcript.js";
import { TextInput } from "./TextInput.js";
import { PermissionDialog } from "./PermissionDialog.js";
import { usePermissionController } from "./permission/use-permission-controller.js";
import type { PermissionOutcome, ToolUseConfirm } from "./permission/types.js";
import { Layout } from "./Layout.js";
import { TranscriptScreen } from "./TranscriptScreen.js";
import { useTerminalStatus } from "./terminal/use-terminal-status.js";
import { useTerminalNotifications } from "./terminal/use-terminal-notifications.js";
import type { TerminalWriter } from "./terminal/writer.js";
import { useStatusLine } from "./use-status-line.js";
import { renderContextUsage } from "./context-grid.js";
import { formatCostSummary, type UsageTotals } from "./cost-summary.js";
import { Panel } from "./panel/Panel.js";
import { usePanelController, type PanelRequest } from "./panel/use-panel-controller.js";
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
  /** 终端带外序列（标题/进度/通知）的写入口（测试用）；不传只在真实 TTY 下写 */
  terminalWrite?: TerminalWriter;
  /** 环境变量覆盖（测试用）：通知频道与阈值从这里读 */
  env?: NodeJS.ProcessEnv;
  /** 退出时回调用量汇总（index.ts 用它在 TUI 卸载后打印 /cost 同款统计） */
  onExitStats?: (summary: string) => void;
}

const HELP = `命令：
  /help          显示本帮助
  /clear         开始新会话（当前会话已持久化，可用 /sessions 找回）
  /compact       手动压缩上下文
  /cost          本次运行累计 token 用量
  /context       当前上下文水位
  /sessions      选择并切换历史会话
  exit / quit    退出
输入技巧：
  @路径          引用文件，内容自动附加到消息（如 "解释 @src/index.ts"）
  Ctrl+C         任务运行中按一次中断任务，再按一次退出
  Ctrl+O         查看会话全文（工具输出不截断），Ctrl+E 展开全部
  Shift+Tab      循环权限模式（default → accept edits → plan）`;

/** 非 default 模式在输入框下方的指示（对齐交互规格 04 §6.5） */
const MODE_META: Record<
  Exclude<PermissionMode, "default">,
  { symbol: string; title: string; color: string }
> = {
  acceptEdits: { symbol: "⏵⏵", title: "accept edits", color: T.warn },
  plan: { symbol: "⏸", title: "plan mode", color: T.primary },
  bypassPermissions: { symbol: "⏵⏵", title: "bypass permissions", color: T.danger },
};

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
  const appRootRef = useRef<DOMElement | null>(null);
  const inputAreaRef = useRef<DOMElement | null>(null);
  const inputBorderRef = useRef<DOMElement | null>(null);
  const appRootMetrics = useBoxMetrics(appRootRef);
  const inputAreaMetrics = useBoxMetrics(inputAreaRef);
  const inputBorderMetrics = useBoxMetrics(inputBorderRef);

  const { columns } = useWindowSize();

  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [streamText, setStreamText] = useState("");
  const [activeTool, setActiveTool] = useState<ActiveTool | null>(null);
  const [confirmQueue, setConfirmQueue] = useState<ToolUseConfirm[]>([]);
  // 主屏 / 会话全文屏（Ctrl+O）—— 规格 05 §1.2 的"屏幕"就是这么个 state
  const [screen, setScreen] = useState<"prompt" | "transcript">("prompt");
  const [transcriptExpanded, setTranscriptExpanded] = useState(false);
  // 命令面板（/sessions 等）：同一时刻至多一个
  const [panel, setPanel] = useState<PanelRequest | null>(null);
  const panelIdRef = useRef(0);
  const [permissionMode, setPermissionModeState] = useState<PermissionMode>(
    props.settings.permissions?.defaultMode ?? "default",
  );
  const [running, setRunning] = useState(false);
  const [spinnerTick, setSpinnerTick] = useState(0);

  const nextId = useRef(0);
  const engineRef = useRef<AgentEngine | null>(null);
  const sessionIdRef = useRef(props.initialSessionId);
  const controllerRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);
  const submitPendingRef = useRef(false);
  const abortExitArmedRef = useRef(false);
  const totals = useRef<UsageTotals>({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  // 会话墙钟起点：/cost 与退出汇总的时长基准
  const sessionStartAt = useRef(Date.now());
  // 最近一次按键时间戳 —— 通知只在"人确实不在"时才发（ref：更新它不该重渲）
  const lastInputAt = useRef(Date.now());
  // 权限判定的三份动态输入：待确认队列 / 当前模式 / 会话内攒下的规则
  const confirmQueueRef = useRef<ToolUseConfirm[]>([]);
  const confirmIdRef = useRef(0);
  const permissionModeRef = useRef(permissionMode);
  const sessionRulesRef = useRef<PermissionRules>({ allow: [], deny: [], ask: [] });
  const baseRulesRef = useRef(settingsRules(props.settings));
  // bypass 不进循环，除非 settings 显式声明（对齐"启动时声明才可用"约定）
  const bypassAvailable = props.settings.permissions?.defaultMode === "bypassPermissions";
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

  // ── 权限链路 ──────────────────────────────────────────────
  // settings 两层规则 + 会话内攒下的规则 + 当前模式 → 判定上下文快照
  const permissionContext = () => ({
    mode: permissionModeRef.current,
    rules: {
      allow: [...baseRulesRef.current.allow, ...sessionRulesRef.current.allow],
      deny: [...baseRulesRef.current.deny, ...sessionRulesRef.current.deny],
      ask: [...baseRulesRef.current.ask, ...sessionRulesRef.current.ask],
    },
  });

  // 模式/规则变化后重查队列：变 allow 的挂起弹窗自动放行（规格 §1.2 recheck）
  const recheckConfirmQueue = () => {
    for (const c of [...confirmQueueRef.current]) {
      const v = evaluatePermission(permissionContext(), {
        toolName: c.toolName,
        args: c.args,
        readOnly: c.readOnly,
      });
      if (v.behavior === "allow") c.resolve({ kind: "allow", updates: [] });
    }
  };

  const setPermissionMode = (mode: PermissionMode) => {
    permissionModeRef.current = mode;
    setPermissionModeState(mode);
    recheckConfirmQueue();
  };

  // 对话框决策产生的持久化动作：session 进内存，其余落对应 settings 文件；
  // 落盘的规则同时写进内存镜像，本会话立即生效
  const applyPermissionUpdates = async (updates: PermissionUpdate[]) => {
    for (const u of updates) {
      if (u.type === "setMode") {
        setPermissionMode(u.mode);
        continue;
      }
      sessionRulesRef.current[u.list].push(u.rule);
      if (u.destination !== "session") {
        await persistPermissionRule(u.rule, u.list, u.destination);
      }
    }
    if (updates.some((u) => u.type === "addRule")) recheckConfirmQueue();
  };

  // ── 引擎组装 ──────────────────────────────────────────────
  const canUseTool = useCallback(
    async (
      name: string,
      args: Record<string, unknown>,
      meta: { readOnly: boolean },
    ): Promise<PermissionDecision> => {
      const verdict = evaluatePermission(permissionContext(), {
        toolName: name,
        args,
        readOnly: meta.readOnly,
      });
      if (verdict.behavior === "allow") return { behavior: "allow" };
      if (verdict.behavior === "deny") return { behavior: "deny", message: verdict.message };

      // ask → 入队挂起；只读工具并发执行时可能同时到达，对话框按队列一次显示一个
      const outcome = await new Promise<PermissionOutcome>((resolve) => {
        const confirm: ToolUseConfirm = {
          id: confirmIdRef.current++,
          toolName: name,
          args,
          readOnly: meta.readOnly,
          verdict,
          resolve: (o) => {
            if (!confirmQueueRef.current.includes(confirm)) return; // 防双 resolve（用户按键与 recheck 竞争）
            confirmQueueRef.current = confirmQueueRef.current.filter((x) => x !== confirm);
            setConfirmQueue(confirmQueueRef.current);
            resolve(o);
          },
        };
        confirmQueueRef.current = [...confirmQueueRef.current, confirm];
        setConfirmQueue(confirmQueueRef.current);
      });

      if (outcome.kind === "deny") {
        return {
          behavior: "deny",
          message: outcome.feedback
            ? `用户拒绝了本次操作，并要求：${outcome.feedback}`
            : undefined,
        };
      }
      await applyPermissionUpdates(outcome.updates);
      return { behavior: "allow", feedback: outcome.feedback };
    },
    // 只经 refs 与 setState 取状态，保持引用稳定（引擎不重建）
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
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

  // ── 退出统计：卸载时把 /cost 同款汇总交给宿主打印 ────────
  const onExitStatsRef = useRef(props.onExitStats);
  onExitStatsRef.current = props.onExitStats;
  useEffect(
    () => () => {
      onExitStatsRef.current?.(
        formatCostSummary(totals.current, Date.now() - sessionStartAt.current),
      );
    },
    [],
  );

  // ── 自定义状态行（settings.statusLine 存在时才跑用户命令） ──
  const statusLineText = useStatusLine(
    props.settings.statusLine,
    () => ({
      model: { id: props.provider.model, display_name: props.provider.model },
      workspace: { current_dir: process.cwd() },
      version: props.version ?? "dev",
      permission_mode: permissionModeRef.current,
      cost: {
        total_input_tokens: totals.current.input,
        total_output_tokens: totals.current.output,
        total_duration_ms: Date.now() - sessionStartAt.current,
      },
      context_window: { used_percentage: status.contextPercent },
    }),
    // 一轮落定（running 翻转）/ 权限模式 / 上下文水位变化时刷新
    [running, permissionMode, status.contextPercent],
  );

  // ── 终端带外通道：窗口标题 + 进度 + 桌面通知 ──────────────
  const activeConfirm = confirmQueue[0] ?? null;
  useTerminalStatus(
    { busy: running, text: `transup — ${basename(process.cwd())}` },
    props.terminalWrite,
  );
  useTerminalNotifications(
    {
      running,
      pendingPermission: activeConfirm
        ? { id: activeConfirm.id, toolName: activeConfirm.toolName }
        : null,
      lastInputAt,
    },
    props.terminalWrite,
    props.env,
  );

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

  // 对话框内容宽度：终端列数减去边框(2)+内缩(2)+预览自带的两格缩进
  const permissionController = usePermissionController(
    activeConfirm,
    confirmQueue.length,
    Math.max(20, columns - 6),
  );

  // 全文屏里冒出权限询问 → 必须回主屏，否则用户看不到弹窗也答不了
  useEffect(() => {
    if (confirmQueue.length > 0) setScreen("prompt");
  }, [confirmQueue.length]);

  const panelRef = useRef<PanelRequest | null>(null);
  panelRef.current = panel;
  const panelController = usePanelController(panel);

  /** 打开一个命令面板；onSelect/onCancel 都先关面板再执行动作 */
  const openPanel = (
    title: string,
    options: PanelRequest["options"],
    onSelect: (value: string) => void,
  ) => {
    setPanel({
      id: panelIdRef.current++,
      title,
      options,
      onSelect: (value) => {
        setPanel(null);
        onSelect(value);
      },
      onCancel: () => setPanel(null),
    });
  };

  const rejectAllConfirms = (): boolean => {
    const pending = confirmQueueRef.current;
    if (pending.length === 0) return false;
    for (const c of [...pending]) c.resolve({ kind: "deny" });
    return true;
  };

  // ── 全局输入与交互上下文路由 ──────────────────────────────
  const screenRef = useRef(screen);
  screenRef.current = screen;

  const handleGlobalKey = (stroke: Keystroke): boolean => {
    // Ctrl+O 双向切换会话全文屏；有权限弹窗挂起时不让走开（那弹窗必须先答）
    if (stroke.ctrl && stroke.input === "o") {
      if (confirmQueueRef.current.length > 0) return true;
      setScreen(screenRef.current === "transcript" ? "prompt" : "transcript");
      setTranscriptExpanded(false);
      return true;
    }
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
    rejectAllConfirms();
    info("⚠ 正在中断当前任务…（再按一次 Ctrl+C 退出）", "yellow");
    abortExitArmedRef.current = true;
    controllerRef.current?.abort();
    return true;
  };

  const cyclePermissionMode = () => {
    setPermissionMode(nextPermissionMode(permissionModeRef.current, bypassAvailable));
  };

  // 全文屏：只认展开/返回，其余按键一律吞掉（不能漏进底下的编辑器）
  const handleTranscriptKey = (stroke: Keystroke): boolean => {
    if (stroke.ctrl && stroke.input === "e") {
      setTranscriptExpanded((v) => !v);
      return true;
    }
    if (stroke.name === "escape") {
      setScreen("prompt");
      setTranscriptExpanded(false);
      return true;
    }
    return true;
  };

  useInput((input, key) => {
    const stroke = normalizeKeystroke(input, key);
    lastInputAt.current = Date.now();
    if (!(stroke.ctrl && stroke.input === "c")) {
      abortExitArmedRef.current = false;
    }
    const inputContext = confirmQueueRef.current.length > 0
      ? "permission"
      : panelRef.current
        ? "panel"
        : screenRef.current === "transcript"
          ? "transcript"
          : inputController.isHistorySearchActive()
            ? "history-search"
            : "editor";
    routeKeystroke(stroke, inputContext, {
      global: handleGlobalKey,
      permission: (permStroke) => permissionController.handleKey(permStroke),
      panel: (panelStroke) => panelController.handleKey(panelStroke),
      transcript: handleTranscriptKey,
      historySearch: (searchStroke) =>
        submitPendingRef.current || inputController.handleHistorySearchKey(searchStroke),
      editor: (editorStroke) => {
        // Shift+Tab 循环权限模式（运行中也生效 —— acceptEdits 可给后续弹窗放行）
        if (editorStroke.name === "tab" && editorStroke.shift) {
          cyclePermissionMode();
          return true;
        }
        return submitPendingRef.current || inputController.handleEditorKey(editorStroke);
      },
    });
  });

  usePaste((text) => {
    abortExitArmedRef.current = false;
    lastInputAt.current = Date.now();
    if (!submitPendingRef.current) inputController.handlePaste(text);
  }, {
    isActive: !running && confirmQueue.length === 0 && screen === "prompt" && !panel,
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
        info(formatCostSummary(totals.current, Date.now() - sessionStartAt.current));
        return true;
      }
      case "/context": {
        const usage = engineRef.current!.contextUsage();
        info(renderContextUsage(usage, props.provider.model, columns));
        return true;
      }
      case "/sessions": {
        const ids = await SessionStore.list(props.sessionDir);
        if (ids.length === 0) {
          info("暂无历史会话");
          return true;
        }
        openPanel(
          "切换会话",
          ids.map((sessionId) => ({
            value: sessionId,
            label: sessionId,
            description: sessionId === sessionIdRef.current ? "当前" : undefined,
          })),
          (sessionId) => {
            if (sessionId === sessionIdRef.current) return;
            void (async () => {
              try {
                const history = await new SessionStore(sessionId, props.sessionDir).load();
                sessionIdRef.current = sessionId;
                engineRef.current = createEngine(sessionId, history);
                const { percent } = engineRef.current.contextUsage();
                setStatus((s) => ({ ...s, sessionId, contextPercent: percent }));
                info(`已切换到会话 ${sessionId}（${history.length} 条消息）`, "green");
              } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                info(`切换会话失败：${detail}`, "red");
              }
            })();
          },
        );
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
              full: ev.content, // 主屏截断，Ctrl+O 全文屏要看未截断的原文
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

  const transcriptMode = screen === "transcript";

  // Static 在两个屏之间保持挂载：Ink 的 Static 一旦卸载重挂，
  // 会把所有条目重新吐进 scrollback（历史凭空翻倍）
  const scrollable = (
    <>
      <Static items={items}>
        {(item) => <TranscriptItemView key={item.id} item={item} />}
      </Static>

      {transcriptMode ? (
        <TranscriptScreen items={items} expanded={transcriptExpanded} />
      ) : (
        <>
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
        </>
      )}
    </>
  );

  const bottom = (
    <>
      {!transcriptMode &&
        !panelController.view &&
        (permissionController.view ? null : (
          // 圆角边框把输入框上下框起来，跟上方记录区在视觉上分隔开
          <Box
            ref={inputBorderRef}
            borderStyle="round"
            borderColor={T.border}
            paddingX={1}
          >
            <TextInput
              view={inputController.view}
              ancestorMetrics={{
                appRoot: appRootMetrics,
                inputArea: inputAreaMetrics,
                border: inputBorderMetrics,
              }}
              onContentWidthChange={inputController.setContentWidth}
            />
          </Box>
        ))}
      {!transcriptMode && permissionMode !== "default" && (
        <Text color={MODE_META[permissionMode].color}>
          {MODE_META[permissionMode].symbol} {MODE_META[permissionMode].title} on{" "}
          <Text dimColor>(shift+tab 循环)</Text>
        </Text>
      )}
      {statusLineText && (
        <Text dimColor wrap="truncate">
          {statusLineText}
        </Text>
      )}
      <StatusBar status={status} />
    </>
  );

  return (
    <Layout
      rootRef={appRootRef}
      bottomRef={inputAreaRef}
      scrollable={scrollable}
      overlay={
        !transcriptMode && permissionController.view ? (
          <PermissionDialog view={permissionController.view} />
        ) : !transcriptMode && panelController.view ? (
          <Panel view={panelController.view} />
        ) : null
      }
      bottom={bottom}
    />
  );
}
