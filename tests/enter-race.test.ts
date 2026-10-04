/**
 * Regression: the keypress that *starts* an embedded terminal must not also be
 * delivered into it.
 *
 * When a key both triggers an action and focuses a newly-created
 * `EmbeddedTerminalRenderable`, the renderer delivers that same key to the new
 * renderable — so a child that reads a line receives a stray byte and answers
 * its first prompt before the user types. This was the suspected cause of the
 * reverted "stream into the pane" feature.
 *
 * Deferring creation+focus to the next tick fixes it. The first test proves the
 * race exists on a synchronous create+focus; the second proves the deferred
 * pattern avoids it.
 */
import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { EmbeddedTerminalRenderable, type KeyEvent } from "@opentui/core";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("embedded terminal trigger-key race", () => {
  test("a synchronous create + focus DOES leak the trigger key (the bug)", async () => {
    const setup = await createTestRenderer({ width: 30, height: 5 });
    const sent: string[] = [];
    try {
      setup.renderer.keyInput.on("keypress", (key: KeyEvent) => {
        if (key.name !== "return") return;
        const panel = new EmbeddedTerminalRenderable(setup.renderer, {
          width: 30,
          height: 5,
          cols: 30,
          rows: 5,
          onData: (data) => sent.push(new TextDecoder().decode(data)),
        });
        setup.renderer.root.add(panel);
        panel.focus();
      });

      setup.mockInput.pressEnter();
      await sleep(150);

      expect(sent.join("")).toContain("\r");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("deferring create + focus to the next tick avoids the leak", async () => {
    const setup = await createTestRenderer({ width: 30, height: 5 });
    const sent: string[] = [];
    try {
      setup.renderer.keyInput.on("keypress", (key: KeyEvent) => {
        if (key.name !== "return") return;
        setTimeout(() => {
          const panel = new EmbeddedTerminalRenderable(setup.renderer, {
            width: 30,
            height: 5,
            cols: 30,
            rows: 5,
            onData: (data) => sent.push(new TextDecoder().decode(data)),
          });
          setup.renderer.root.add(panel);
          panel.focus();
        }, 0);
      });

      setup.mockInput.pressEnter();
      await sleep(150);

      // Only the focus-in sequence may have been sent — never the "\r".
      expect(sent.join("")).not.toContain("\r");
    } finally {
      setup.renderer.destroy();
    }
  });
});
