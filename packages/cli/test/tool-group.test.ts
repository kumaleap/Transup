import {describe, expect, it} from "vitest";
import {
  editLineDelta,
  shouldCollapse,
  summarizeGroup,
  type ToolGroupEntry,
} from "../src/tui/tool-group.js";

/** 与渲染层一致的局部 bold（闭合用 22 不用 0） */
const bold = (s: string | number) => `\x1b[1m${s}\x1b[22m`;

/** 造一个最小 entry；测试只关心 name 与 lineDelta */
function entry(name: string, lineDelta?: number): ToolGroupEntry {
  return {name, displayName: name, argSummary: "", preview: "", lineDelta};
}

describe("editLineDelta", () => {
  it("edit_file 返回 new_string 与 old_string 的行数差", () => {
    expect(editLineDelta("edit_file", {old_string: "a\nb", new_string: "a\nb\nc\nd"})).toBe(2);
    expect(editLineDelta("edit_file", {old_string: "a\nb\nc", new_string: "a"})).toBe(-2);
    expect(editLineDelta("edit_file", {old_string: "a", new_string: "b"})).toBe(0);
  });

  it("write_file 返回 content 的行数", () => {
    expect(editLineDelta("write_file", {path: "x", content: "a\nb\nc"})).toBe(3);
    expect(editLineDelta("write_file", {path: "x", content: ""})).toBe(1);
  });

  it("非编辑类工具与参数缺失返回 undefined", () => {
    expect(editLineDelta("read_file", {path: "x"})).toBeUndefined();
    expect(editLineDelta("bash", {command: "ls"})).toBeUndefined();
    expect(editLineDelta("edit_file", {old_string: "a"})).toBeUndefined();
    expect(editLineDelta("edit_file", {})).toBeUndefined();
    expect(editLineDelta("write_file", {})).toBeUndefined();
  });
});

describe("shouldCollapse", () => {
  it("少于 2 条不折叠", () => {
    expect(shouldCollapse([])).toBe(false);
    expect(shouldCollapse([entry("bash")])).toBe(false);
  });

  it("2 条起折叠", () => {
    expect(shouldCollapse([entry("bash"), entry("read_file")])).toBe(true);
    expect(shouldCollapse([entry("bash"), entry("bash"), entry("grep")])).toBe(true);
  });
});

describe("summarizeGroup · live 进行时", () => {
  it("以采样动词开头（带省略号、无耗时），分类用进行时", () => {
    const out = summarizeGroup({
      tense: "live",
      verb: "Pondering",
      elapsedMs: 46_000,
      entries: [
        entry("edit_file", 30),
        entry("edit_file", 5),
        entry("read_file"),
        entry("bash"),
        entry("bash"),
        entry("bash"),
        entry("bash"),
      ],
    });
    expect(out).toBe(
      `Pondering… · editing ${bold(2)} files +35 · reading ${bold(1)} file · running ${bold(4)} shell commands`,
    );
  });

  it("单数不带复数 s", () => {
    const out = summarizeGroup({
      tense: "live",
      verb: "Thinking",
      elapsedMs: 0,
      entries: [entry("edit_file", 1), entry("bash")],
    });
    expect(out).toBe(`Thinking… · editing ${bold(1)} file +1 · running ${bold(1)} shell command`);
  });
});

describe("summarizeGroup · done 过去式", () => {
  it("固定 Thought for 开头，分类用过去式，grep/list_dir 归为 searched", () => {
    const out = summarizeGroup({
      tense: "done",
      verb: "Moonwalking", // done 形式不使用采样动词
      elapsedMs: 176_000,
      entries: [
        entry("edit_file", 40),
        entry("edit_file", 29),
        entry("edit_file", 0),
        entry("edit_file", 0),
        entry("grep"),
        entry("read_file"),
        entry("read_file"),
        ...Array.from({length: 7}, () => entry("bash")),
      ],
    });
    expect(out).toBe(
      `Thought for 2m56s · made ${bold(4)} edits +69 · read ${bold(2)} files · searched ${bold(1)} pattern · ran ${bold(7)} shell commands`,
    );
  });

  it("不足 1 秒省略开头的耗时段", () => {
    const out = summarizeGroup({
      tense: "done",
      verb: "Thinking",
      elapsedMs: 999,
      entries: [entry("read_file"), entry("read_file")],
    });
    expect(out).toBe(`read ${bold(2)} files`);
  });

  it("write_file 计为 edit；行数差为负显示 -N，为 0 省略", () => {
    const minus = summarizeGroup({
      tense: "done",
      verb: "Thinking",
      elapsedMs: 5_000,
      entries: [entry("write_file", 3), entry("edit_file", -7)],
    });
    expect(minus).toBe(`Thought for 5s · made ${bold(2)} edits -4`);

    const zero = summarizeGroup({
      tense: "done",
      verb: "Thinking",
      elapsedMs: 5_000,
      entries: [entry("edit_file", 2), entry("edit_file", -2)],
    });
    expect(zero).toBe(`Thought for 5s · made ${bold(2)} edits`);
  });

  it("未知工具归入通用 tools 桶；list_dir 归为 searched", () => {
    const out = summarizeGroup({
      tense: "done",
      verb: "Thinking",
      elapsedMs: 3_000,
      entries: [entry("task"), entry("mcp__foo__bar"), entry("list_dir"), entry("list_dir")],
    });
    expect(out).toBe(
      `Thought for 3s · searched ${bold(2)} patterns · called ${bold(2)} tools`,
    );
  });
});
