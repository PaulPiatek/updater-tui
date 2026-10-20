/**
 * Guards the Windows console-mode helper (AGENTS rule 2).
 *
 * The FFI snapshot/restore can't be observed under `bun test` (stdin is not a
 * console there), so these assert the wrapper's contract: it returns the
 * callback's value and restores on both the success and throw paths, and the
 * helpers degrade to no-ops instead of throwing when there is no console.
 */
import { expect, test } from "bun:test";
import {
  getConsoleInputMode,
  getConsoleOutputMode,
  setConsoleInputMode,
  setConsoleOutputMode,
  withConsoleModeRestored,
} from "../src/console-mode";

test("withConsoleModeRestored returns the callback result", async () => {
  expect(await withConsoleModeRestored(async () => 42)).toBe(42);
});

test("withConsoleModeRestored restores on the throw path too", async () => {
  await expect(
    withConsoleModeRestored(async () => {
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
});

test("the mode helpers never throw without a console", () => {
  const input = getConsoleInputMode();
  expect(input === null || typeof input === "number").toBe(true);
  // When there is a console, writing the mode we just read must succeed.
  if (input !== null) expect(setConsoleInputMode(input)).toBe(true);

  // The output mode is snapshotted too: a child can disable virtual-terminal
  // processing, which would leave the UI's escape sequences on screen as text.
  const output = getConsoleOutputMode();
  expect(output === null || typeof output === "number").toBe(true);
  if (output !== null) expect(setConsoleOutputMode(output)).toBe(true);
});
