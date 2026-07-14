/**
 * 桌面通知触发（规格 05 §3.5 的触发点 1、2）
 *
 *   ① 空闲提醒：一轮回复结束后，用户迟迟没有任何交互 → "已完成，等你的下一步"
 *   ② 权限挂起：弹窗出来了没人理 → "需要你的授权：{tool}"
 *
 * 两者都只在"用户确实不在"时才发：到点时看最近一次按键的时间戳，
 * 人还在敲键盘就不打扰。阈值可用环境变量调（写死的默认值对多数人够用）。
 */
import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import { detectNotifyChannel, notifySequence, type Notification } from "./notify.js";
import { defaultTerminalWriter, type TerminalWriter } from "./writer.js";

const DEFAULT_IDLE_MS = 30_000;
const DEFAULT_PERMISSION_MS = 5_000;

function msFromEnv(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const n = Number(env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface NotificationInputs {
  /** 引擎是否在跑 */
  running: boolean;
  /** 挂起中的权限确认（无则 null）；id 变化视为新的一次询问 */
  pendingPermission: { id: number; toolName: string } | null;
  /** 最近一次用户按键的时间戳（ref：更新它不该引起重渲） */
  lastInputAt: RefObject<number>;
}

export function useTerminalNotifications(
  inputs: NotificationInputs,
  write: TerminalWriter = defaultTerminalWriter,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const { running, pendingPermission, lastInputAt } = inputs;
  const channel = useMemo(() => detectNotifyChannel(env), [env]);
  const idleMs = msFromEnv("TRANSUP_NOTIF_IDLE_MS", DEFAULT_IDLE_MS, env);
  const permissionMs = msFromEnv("TRANSUP_NOTIF_PERMISSION_MS", DEFAULT_PERMISSION_MS, env);

  const notify = useCallback(
    (notification: Notification) => {
      const sequence = notifySequence(channel, notification, env);
      if (sequence) write(sequence);
    },
    [channel, env, write],
  );

  // 跑过至少一轮才有"完成"可言 —— 刚启动的静止状态不该提醒
  const hasRunRef = useRef(false);
  useEffect(() => {
    if (running) hasRunRef.current = true;
  }, [running]);

  useEffect(() => {
    if (running || !hasRunRef.current) return;
    const timer = setTimeout(() => {
      // 这段时间里用户敲过键 = 人在跟前，别打扰
      if (Date.now() - lastInputAt.current < idleMs) return;
      notify({ title: "Transup", body: "已完成，等待你的下一步" });
    }, idleMs);
    return () => clearTimeout(timer);
  }, [running, idleMs, lastInputAt, notify]);

  const permissionKey = pendingPermission ? pendingPermission.id : null;
  const permissionTool = pendingPermission?.toolName;
  useEffect(() => {
    if (permissionKey === null) return;
    const timer = setTimeout(() => {
      if (Date.now() - lastInputAt.current < permissionMs) return;
      notify({ title: "Transup", body: `需要你的授权：${permissionTool}` });
    }, permissionMs);
    return () => clearTimeout(timer);
  }, [permissionKey, permissionTool, permissionMs, lastInputAt, notify]);
}
