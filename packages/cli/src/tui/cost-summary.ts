/**
 * 用量汇总（规格 06 §1.3 的无价格表版本）
 *
 * 我们不内置模型单价（任何模型都是一等公民，价格表维护不过来），
 * 所以只报 tokens 与时长。/cost 与退出时打印同一份 —— 单一来源。
 */
export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function fmtDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

const fmtInt = new Intl.NumberFormat("en-US");

export function formatCostSummary(totals: UsageTotals, wallMs: number): string {
  const rows: [string, string][] = [
    ["会话时长（wall）", fmtDuration(wallMs)],
    ["输入 tokens", fmtInt.format(totals.input)],
    ["输出 tokens", fmtInt.format(totals.output)],
  ];
  if (totals.cacheRead > 0 || totals.cacheWrite > 0) {
    rows.push(["缓存命中 / 写入", `${fmtInt.format(totals.cacheRead)} / ${fmtInt.format(totals.cacheWrite)}`]);
  }
  const labelWidth = Math.max(...rows.map(([l]) => l.length));
  return rows.map(([l, v]) => `${l.padEnd(labelWidth + 2)}${v}`).join("\n");
}
