/** statusline 命令执行：JSON stdin、超时、非 0 静默、ANSI 透传 */
import { describe, it, expect } from "vitest";
import { runStatusLineCommand, type StatusLineInput } from "../src/tui/statusline.js";
import { renderContextGrid, renderContextUsage } from "../src/tui/context-grid.js";
import { formatCostSummary } from "../src/tui/cost-summary.js";

const input: StatusLineInput = {
  model: { id: "m1", display_name: "m1" },
  workspace: { current_dir: "/tmp/proj" },
  version: "0.1.0",
  permission_mode: "acceptEdits",
  cost: { total_input_tokens: 1200, total_output_tokens: 340, total_duration_ms: 61_000 },
  context_window: { used_percentage: 25 },
};

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("runStatusLineCommand", () => {
  it("JSON 经 stdin 传入，脚本可以取任意字段", async () => {
    // node 一行脚本：读 stdin JSON，输出 "模型 · 模式 · 水位%"
    const script = `node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.model.id+' · '+j.permission_mode+' · '+j.context_window.used_percentage+'%')})"`;
    const out = await runStatusLineCommand({ command: script }, input);
    expect(out).toBe("m1 · acceptEdits · 25%");
  });

  it("非 0 退出 → 静默丢弃（null）", async () => {
    expect(await runStatusLineCommand({ command: "exit 3" }, input)).toBeNull();
  });

  it("空输出 → null；多行输出保留（尾部空行去掉）", async () => {
    expect(await runStatusLineCommand({ command: "true" }, input)).toBeNull();
    const out = await runStatusLineCommand({ command: 'printf "a\\nb\\n\\n"' }, input);
    expect(out).toBe("a\nb");
  });

  it("超时 → kill 并返回 null", async () => {
    const started = Date.now();
    const out = await runStatusLineCommand({ command: "sleep 10", timeoutMs: 120 }, input);
    expect(out).toBeNull();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("ANSI 颜色原样透传", async () => {
    const out = await runStatusLineCommand({ command: `printf '\\033[32mok\\033[0m'` }, input);
    expect(out).toContain("\x1b[32m");
  });
});

describe("renderContextGrid / renderContextUsage", () => {
  it("水位映射到格子数：0% 全空闲，100% 全占用", () => {
    const empty = renderContextGrid(0, 10).map(strip).join("");
    expect(empty).toBe("⛶".repeat(50));
    const full = renderContextGrid(100, 10).map(strip).join("");
    expect(full).toBe("⛁".repeat(50));
  });

  it("50% 占一半格子；宽度下限 10", () => {
    const half = renderContextGrid(50, 10).map(strip).join("");
    expect(half.split("⛁").length - 1).toBe(25);
    expect(strip(renderContextGrid(50, 3)[0]).length).toBe(10);
  });

  it("完整输出含标题、网格与汇总（总量从 percent 反推）", () => {
    const out = strip(renderContextUsage({ chars: 25_000, percent: 25 }, "m1", 44));
    expect(out).toContain("上下文用量");
    expect(out).toContain("m1 · 25k/100k 字符（25%）");
  });
});

describe("formatCostSummary", () => {
  it("时长 + tokens 对齐列；缓存为零时省略", () => {
    const out = formatCostSummary({ input: 1234, output: 567, cacheRead: 0, cacheWrite: 0 }, 61_000);
    expect(out).toContain("会话时长（wall）");
    expect(out).toContain("1m 1s");
    expect(out).toContain("1,234");
    expect(out).not.toContain("缓存");
    const withCache = formatCostSummary(
      { input: 1, output: 2, cacheRead: 300, cacheWrite: 40 },
      5_000,
    );
    expect(withCache).toContain("300 / 40");
  });
});
