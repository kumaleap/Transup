import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { PermissionDialog } from "../src/tui/PermissionDialog.js";
import type { PermissionDialogView } from "../src/tui/permission/use-permission-controller.js";

const ANSI = /\x1b\[[0-9;]*m/g;
const poisoned = (value: string) => `${value}\n9. forged row\tvalue`;

describe("PermissionDialog", () => {
  it("keeps every structural field on one row while preserving multiline preview", () => {
    const view: PermissionDialogView = {
      model: {
        title: poisoned("title"),
        subtitle: poisoned("subtitle"),
        preview: "preview line one\npreview line two",
        explanation: poisoned("explanation"),
        warning: poisoned("warning"),
        question: poisoned("question"),
        options: [{
          value: "yes-prefix",
          label: poisoned("label"),
          kind: "allow",
          input: {
            value: "raw\nsemantic\tvalue",
            displayValue: poisoned("display"),
            buildUpdates: () => [],
          },
        }],
      },
      focusIndex: 0,
      editing: { type: "input", value: poisoned("editing") },
      queueLength: 1,
    };

    const instance = render(<PermissionDialog view={view} />);
    const frame = (instance.lastFrame() ?? "").replace(ANSI, "");

    expect(frame).toContain("preview line one");
    expect(frame).toContain("preview line two");
    expect(frame).not.toContain("\t");
    expect(frame.split("\n")).toHaveLength(11);
    instance.unmount();
  });
});
