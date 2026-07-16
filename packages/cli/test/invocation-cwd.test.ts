import {afterEach, describe, expect, it, vi} from "vitest";
import {restoreInvocationCwd} from "../src/invocation-cwd.js";

describe("restoreInvocationCwd", () => {
  afterEach(() => vi.restoreAllMocks());

  it("恢复 npm 启动前的 INIT_CWD", () => {
    let cwd = "/repo/packages/cli";
    vi.spyOn(process, "cwd").mockImplementation(() => cwd);
    const chdir = vi.spyOn(process, "chdir").mockImplementation((path) => {
      cwd = String(path);
    });

    expect(restoreInvocationCwd({INIT_CWD: "/repo"})).toBe("/repo");
    expect(chdir).toHaveBeenCalledWith("/repo");
  });

  it("没有 INIT_CWD 时保留当前目录", () => {
    vi.spyOn(process, "cwd").mockReturnValue("/repo");
    const chdir = vi.spyOn(process, "chdir");

    expect(restoreInvocationCwd({})).toBe("/repo");
    expect(chdir).not.toHaveBeenCalled();
  });

  it("INIT_CWD 无法进入时回退当前目录", () => {
    vi.spyOn(process, "cwd").mockReturnValue("/repo/packages/cli");
    vi.spyOn(process, "chdir").mockImplementation(() => {
      throw new Error("missing directory");
    });

    expect(restoreInvocationCwd({INIT_CWD: "/missing"})).toBe("/repo/packages/cli");
  });

  it("保留 INIT_CWD 路径中的合法首尾空格", () => {
    let cwd = "/repo/packages/cli";
    vi.spyOn(process, "cwd").mockImplementation(() => cwd);
    const chdir = vi.spyOn(process, "chdir").mockImplementation((path) => {
      cwd = String(path);
    });

    expect(restoreInvocationCwd({INIT_CWD: "/repo "})).toBe("/repo ");
    expect(chdir).toHaveBeenCalledWith("/repo ");
  });
});
