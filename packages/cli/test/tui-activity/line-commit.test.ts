// 流式按行上屏纯函数测试（对应 docs/claude-code-interactions/02 §2.1）：
// visibleStreamLines 只显示到最后一个换行，未完成的当前行隐藏。
import {describe, expect, it} from "vitest";

import {hasHiddenTail, visibleStreamLines} from "../../src/tui/activity/line-commit.js";

describe("visibleStreamLines", () => {
  it("空串返回空串", () => {
    expect(visibleStreamLines("")).toBe("");
  });

  it("无换行时整行隐藏，返回空串", () => {
    expect(visibleStreamLines("partial line")).toBe("");
  });

  it("单换行结尾时全部上屏", () => {
    expect(visibleStreamLines("hello\n")).toBe("hello\n");
  });

  it("多行带半行尾巴时只显示到最后一个换行", () => {
    expect(visibleStreamLines("line1\nline2\nhalf")).toBe("line1\nline2\n");
  });

  it("连续换行原样保留", () => {
    expect(visibleStreamLines("a\n\n\nb")).toBe("a\n\n\n");
    expect(visibleStreamLines("\n\n")).toBe("\n\n");
  });

  it("CRLF 不特殊处理，按 \\n 切（\\r 留在行内）", () => {
    expect(visibleStreamLines("line1\r\nhalf")).toBe("line1\r\n");
    expect(visibleStreamLines("line1\rstill-half")).toBe("");
  });
});

describe("hasHiddenTail", () => {
  it("空串没有隐藏尾巴", () => {
    expect(hasHiddenTail("")).toBe(false);
  });

  it("无换行的非空文本整体是隐藏尾巴", () => {
    expect(hasHiddenTail("partial")).toBe(true);
  });

  it("换行结尾时没有隐藏尾巴", () => {
    expect(hasHiddenTail("done\n")).toBe(false);
  });

  it("多行带半行尾巴时存在隐藏尾巴", () => {
    expect(hasHiddenTail("line1\nhalf")).toBe(true);
  });
});
