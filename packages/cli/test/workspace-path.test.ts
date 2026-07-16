import {describe, expect, it} from "vitest";
import {abbreviateHome} from "../src/tui/workspace-path.js";

describe("abbreviateHome", () => {
  it("处理带尾分隔符的 home", () => {
    expect(abbreviateHome("/Users/kuma", "/Users/kuma/")).toBe("~");
    expect(abbreviateHome("/Users/kuma/workspace", "/Users/kuma/")).toBe("~/workspace");
  });

  it("根目录作为 home 时保留路径分隔符", () => {
    expect(abbreviateHome("/", "/")).toBe("~");
    expect(abbreviateHome("/workspace/Transup", "/")).toBe("~/workspace/Transup");
  });

  it("不缩写只有相似前缀的目录", () => {
    expect(abbreviateHome("/Users/kuma-other/project", "/Users/kuma")).toBe(
      "/Users/kuma-other/project",
    );
  });
});
