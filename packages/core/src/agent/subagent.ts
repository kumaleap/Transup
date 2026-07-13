/**
 * 子 agent —— task 工具
 *
 * 主 agent 可以把"探索型子任务"（在大代码库里找某个东西、理解某个
 * 模块的结构）派发给子 agent。价值在于【上下文隔离】：子 agent 翻几十个
 * 文件产生的海量中间内容留在它自己的上下文里，主 agent 只收到最终结论
 * —— 主上下文不被探索过程污染。
 *
 * 三个刻意的设计约束（借鉴 Claude Code 的 subagent 拓扑控制）：
 * 1. 只读工具集：子 agent 只能 read/grep/list，不能改文件、跑命令。
 *    因此 task 工具本身也是 readOnly —— 多个探索任务可以并行派发。
 * 2. 不含 task 工具自身：子 agent 不能再派生子 agent，防止无限递归。
 * 3. 不落盘：探索过程不写 transcript，只有结论回流主对话（会被持久化）。
 *
 * 实现上完全复用 AgentEngine —— 这正是"引擎与宿主解耦"架构的回报：
 * 子 agent 就是引擎的另一个宿主。
 */
import { z } from "zod";
import { AgentEngine } from "./engine.js";
import type { Provider } from "../provider/types.js";
import type { Tool } from "../tools/types.js";
import { readFileTool } from "../tools/read-file.js";
import { listDirTool } from "../tools/list-dir.js";
import { grepTool } from "../tools/grep.js";

const schema = z.object({
  description: z.string().describe("子任务的完整描述，包含要找什么、在哪找、需要返回什么"),
});

/** 进度行里的参数摘要：取各字段值拼一行，截断防刷屏 */
function briefArgs(args: Record<string, unknown>): string {
  const text = Object.values(args)
    .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
    .join(" ");
  return text.length > 60 ? text.slice(0, 60) + "…" : text;
}

export function createTaskTool(provider: Provider): Tool<typeof schema> {
  return {
    name: "task",
    description:
      "派发一个只读的探索型子任务给子 agent（它能用 read_file/grep/list_dir，" +
      "不能修改任何东西）。适合“在代码库里找 X”“理解模块 Y 的结构”这类需要翻很多文件、" +
      "但只需要结论的任务 —— 中间过程不占用你的上下文。可以同时派发多个并行执行。" +
      "description 必须自包含：子 agent 看不到当前对话。",
    schema,
    readOnly: true, // 只读工具集 → 整体只读 → 可并行、免确认
    async execute({ description }, onProgress) {
      const sub = new AgentEngine({
        provider,
        // 子 agent 的工具全是只读的，只读直接放行；
        // fail-closed：写操作（未来有人误加写工具）一律拒绝
        canUseTool: async (_name, _args, meta) =>
          meta.readOnly
            ? { behavior: "allow" }
            : { behavior: "deny", message: "子任务禁止写操作" },
        tools: [readFileTool, listDirTool, grepTool],
        maxIterations: 15,
      });

      // 子 agent 的工具活动以进度行透出（→ read_file src/index.ts），
      // 长探索不再像卡死；正文仍只回流最终结论，不污染主上下文
      let result = "";
      for await (const ev of sub.runTurn(description)) {
        if (ev.type === "tool_start") {
          onProgress?.(`→ ${ev.call.name} ${briefArgs(ev.parsedArgs)}\n`);
        }
        if (ev.type === "turn_end" && ev.reason !== "done") {
          return `[子任务未完成: ${ev.reason}] 已收集到的部分结论：\n${result}`;
        }
        if (ev.type === "text_delta") result += ev.text;
      }
      return result || "(子任务没有返回内容)";
    },
  };
}
