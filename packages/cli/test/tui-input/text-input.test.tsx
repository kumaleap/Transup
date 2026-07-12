import React from "react";
import {render} from "ink-testing-library";
import {beforeEach, describe, expect, it, vi} from "vitest";

interface BoxMetrics {
  width: number;
  height: number;
  left: number;
  top: number;
  hasMeasured: boolean;
}

const runtimeMocks = vi.hoisted(() => {
  const setCursorPosition = vi.fn();
  return {
    currentMetrics: {
      width: 40,
      height: 1,
      left: 0,
      top: 0,
      hasMeasured: true,
    },
    stdout: {columns: 80},
    setCursorPosition,
    useBoxMetrics: vi.fn(),
    useCursor: vi.fn(),
    useStdout: vi.fn(),
  };
});

vi.mock("../../src/tui/runtime/index.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/tui/runtime/index.js")
  >("../../src/tui/runtime/index.js");

  return {
    ...actual,
    useBoxMetrics: runtimeMocks.useBoxMetrics,
    useCursor: runtimeMocks.useCursor,
    useStdout: runtimeMocks.useStdout,
  };
});

import {Box} from "../../src/tui/runtime/index.js";
import {TextInput} from "../../src/tui/TextInput.js";
import type {InputViewState} from "../../src/tui/input/use-input-controller.js";

interface TextInputAncestorMetrics {
  appRoot: BoxMetrics;
  inputArea: BoxMetrics;
  border: BoxMetrics;
}

type NestedTextInputProps = React.ComponentProps<typeof TextInput> & {
  ancestorMetrics: TextInputAncestorMetrics;
};

const activeView: InputViewState = {
  value: "abcdefghij",
  cursor: 0,
  active: true,
};

function metrics(patch: Partial<BoxMetrics> = {}): BoxMetrics {
  return {
    width: 40,
    height: 1,
    left: 0,
    top: 0,
    hasMeasured: true,
    ...patch,
  };
}

function measuredAncestors(): TextInputAncestorMetrics {
  return {
    appRoot: metrics({left: 2, top: 3}),
    inputArea: metrics({left: 5, top: 7}),
    border: metrics({left: 11, top: 13}),
  };
}

function NestedTextInput(props: NestedTextInputProps) {
  return (
    <Box flexDirection="column">
      <Box flexDirection="column">
        <Box flexDirection="column">
          <TextInput {...props} />
        </Box>
      </Box>
    </Box>
  );
}

function plain(frame: string | undefined): string {
  return (frame ?? "").replace(/\u001b\[[0-9;]*m/g, "");
}

beforeEach(() => {
  runtimeMocks.currentMetrics = metrics();
  runtimeMocks.stdout.columns = 80;
  runtimeMocks.setCursorPosition.mockReset();
  runtimeMocks.useBoxMetrics.mockReset();
  runtimeMocks.useBoxMetrics.mockImplementation(
    () => runtimeMocks.currentMetrics,
  );
  runtimeMocks.useCursor.mockReset();
  runtimeMocks.useCursor.mockReturnValue({
    setCursorPosition: runtimeMocks.setCursorPosition,
  });
  runtimeMocks.useStdout.mockReset();
  runtimeMocks.useStdout.mockReturnValue({stdout: runtimeMocks.stdout});
});

describe("TextInput terminal cursor placement", () => {
  it("keeps an explicitly injected width after measurement", async () => {
    runtimeMocks.currentMetrics = metrics({
      width: 0,
      height: 0,
      hasMeasured: false,
    });
    const onContentWidthChange = vi.fn();
    const ancestors = measuredAncestors();
    const instance = render(
      <NestedTextInput
        ancestorMetrics={ancestors}
        rootWidth={16}
        view={activeView}
        onContentWidthChange={onContentWidthChange}
      />,
    );

    await vi.waitFor(() =>
      expect(onContentWidthChange).toHaveBeenLastCalledWith(13),
    );
    expect(plain(instance.lastFrame())).toBe("❯ abcdefghij");

    runtimeMocks.currentMetrics = metrics({width: 8});
    instance.rerender(
      <NestedTextInput
        ancestorMetrics={ancestors}
        rootWidth={16}
        view={{...activeView}}
        onContentWidthChange={onContentWidthChange}
      />,
    );

    await vi.waitFor(() =>
      expect(onContentWidthChange).toHaveBeenLastCalledWith(13),
    );
    expect(plain(instance.lastFrame())).toBe("❯ abcdefghij");
    instance.unmount();
  });

  it("falls back to terminal width, then reflows after measurement and resize", async () => {
    runtimeMocks.currentMetrics = metrics({
      width: 0,
      height: 0,
      hasMeasured: false,
    });
    runtimeMocks.stdout.columns = 21;
    const onContentWidthChange = vi.fn();
    const instance = render(
      <NestedTextInput
        ancestorMetrics={measuredAncestors()}
        view={activeView}
        onContentWidthChange={onContentWidthChange}
      />,
    );

    await vi.waitFor(() =>
      expect(onContentWidthChange).toHaveBeenLastCalledWith(14),
    );

    runtimeMocks.currentMetrics = metrics({width: 8});
    instance.rerender(
      <NestedTextInput
        ancestorMetrics={measuredAncestors()}
        view={{...activeView}}
        onContentWidthChange={onContentWidthChange}
      />,
    );

    await vi.waitFor(() =>
      expect(onContentWidthChange).toHaveBeenLastCalledWith(5),
    );
    expect(plain(instance.lastFrame()).split("\n")).toEqual([
      "❯ abcde",
      "  fghij",
    ]);
    instance.unmount();
  });

  it("adds every ancestor offset and the measured visual cursor point", () => {
    runtimeMocks.currentMetrics = metrics({width: 8, left: 19, top: 23});
    const instance = render(
      <NestedTextInput
        ancestorMetrics={measuredAncestors()}
        view={{...activeView, cursor: 7}}
      />,
    );

    expect(runtimeMocks.setCursorPosition).toHaveBeenLastCalledWith({
      x: 41,
      y: 47,
    });
    instance.unmount();
  });

  it("uses a known zero App-root origin while the other levels are measured", () => {
    runtimeMocks.currentMetrics = metrics({width: 8, left: 19, top: 23});
    const ancestors = measuredAncestors();
    ancestors.appRoot = metrics({
      width: 0,
      height: 0,
      left: 0,
      top: 0,
      hasMeasured: false,
    });
    const instance = render(
      <NestedTextInput
        ancestorMetrics={ancestors}
        view={{...activeView, cursor: 7}}
      />,
    );

    expect(runtimeMocks.setCursorPosition).toHaveBeenLastCalledWith({
      x: 39,
      y: 44,
    });
    instance.unmount();
  });

  it.each([
    {
      state: "history search",
      view: {
        ...activeView,
        historySearch: {query: "abc", match: {start: 0, end: 3}, hasMatch: true},
      } satisfies InputViewState,
      ownMetrics: metrics(),
      ancestors: measuredAncestors(),
    },
    {
      state: "inactive input",
      view: {...activeView, active: false} satisfies InputViewState,
      ownMetrics: metrics(),
      ancestors: measuredAncestors(),
    },
    {
      state: "narrow input",
      view: activeView,
      ownMetrics: metrics({width: 4}),
      ancestors: measuredAncestors(),
    },
    {
      state: "unmeasured ancestor",
      view: activeView,
      ownMetrics: metrics(),
      ancestors: {
        ...measuredAncestors(),
        border: metrics({left: 11, top: 13, hasMeasured: false}),
      },
    },
    {
      state: "unmeasured nonzero App root",
      view: activeView,
      ownMetrics: metrics(),
      ancestors: {
        ...measuredAncestors(),
        appRoot: metrics({left: 2, top: 3, hasMeasured: false}),
      },
    },
    {
      state: "missing ancestor metrics",
      view: activeView,
      ownMetrics: metrics(),
      ancestors: undefined,
    },
  ])("hides the terminal cursor for $state", ({view, ownMetrics, ancestors}) => {
    runtimeMocks.currentMetrics = ownMetrics;
    const instance = ancestors
      ? render(<NestedTextInput ancestorMetrics={ancestors} view={view} />)
      : render(<TextInput view={view} />);

    expect(runtimeMocks.setCursorPosition).toHaveBeenLastCalledWith(undefined);
    instance.unmount();
  });

  it("clears a visible cursor on search and restores it after search", () => {
    runtimeMocks.currentMetrics = metrics({width: 8, left: 19, top: 23});
    const ancestors = measuredAncestors();
    const instance = render(
      <NestedTextInput
        ancestorMetrics={ancestors}
        view={{...activeView, cursor: 7}}
      />,
    );
    const point = {x: 41, y: 47};
    expect(runtimeMocks.setCursorPosition).toHaveBeenLastCalledWith(point);

    instance.rerender(
      <NestedTextInput
        ancestorMetrics={ancestors}
        view={{
          ...activeView,
          cursor: 7,
          historySearch: {query: "abc", match: {start: 0, end: 3}, hasMatch: true},
        }}
      />,
    );
    expect(runtimeMocks.setCursorPosition).toHaveBeenLastCalledWith(undefined);

    instance.rerender(
      <NestedTextInput
        ancestorMetrics={ancestors}
        view={{...activeView, cursor: 7}}
      />,
    );
    expect(runtimeMocks.setCursorPosition).toHaveBeenLastCalledWith(point);
    instance.unmount();
  });
});
