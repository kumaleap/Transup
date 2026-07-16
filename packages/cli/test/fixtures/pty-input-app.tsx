import React, {useCallback, useRef} from "react";

import {TextInput} from "../../src/tui/TextInput.js";
import {
  normalizeKeystroke,
  routeKeystroke,
} from "../../src/tui/input/keybinding-router.js";
import {
  useInputController,
  type InputController,
} from "../../src/tui/input/use-input-controller.js";
import {
  Box,
  render,
  useApp,
  useBoxMetrics,
  useInput,
  usePaste,
  useStdout,
  type DOMElement,
} from "../../src/tui/runtime/index.js";

function PtyInputApp() {
  const {exit} = useApp();
  const {write} = useStdout();
  const controllerRef = useRef<InputController | null>(null);
  const appRootRef = useRef<DOMElement | null>(null);
  const inputAreaRef = useRef<DOMElement | null>(null);
  const borderRef = useRef<DOMElement | null>(null);
  const appRoot = useBoxMetrics(appRootRef);
  const inputArea = useBoxMetrics(inputAreaRef);
  const border = useBoxMetrics(borderRef);

  const onSubmit = useCallback(
    (_display: string, expanded: string) => {
      write(`SUBMITTED:${expanded}\n`);
      queueMicrotask(() => controllerRef.current?.requestExit());
    },
    [write],
  );

  const controller = useInputController({
    active: true,
    historyPath: process.env.TRANSUP_PTY_HISTORY_PATH,
    onSubmit,
    onExit: exit,
    onHistoryError: (error) => {
      const detail = error instanceof Error ? error.message : String(error);
      write(`HISTORY_ERROR:${detail}\n`);
    },
  });
  controllerRef.current = controller;

  useInput((input, key) => {
    const stroke = normalizeKeystroke(input, key);
    const context = controller.isHistorySearchActive()
      ? "history-search"
      : "editor";
    routeKeystroke(stroke, context, {
      global: controller.handleGlobalKey,
      historySearch: controller.handleHistorySearchKey,
      editor: controller.handleEditorKey,
    });
  });

  usePaste((text) => controller.handlePaste(text));

  return (
    <Box ref={appRootRef} width="100%" flexDirection="column">
      <Box ref={inputAreaRef} width="100%" flexDirection="column">
        <Box
          ref={borderRef}
          width="100%"
          borderStyle="round"
          borderLeft={false}
          borderRight={false}
          paddingX={1}
        >
          <TextInput
            view={controller.view}
            ancestorMetrics={{appRoot, inputArea, border}}
            onContentWidthChange={controller.setContentWidth}
          />
        </Box>
      </Box>
    </Box>
  );
}

const instance = render(<PtyInputApp />, {exitOnCtrlC: false});
await instance.waitUntilExit();
