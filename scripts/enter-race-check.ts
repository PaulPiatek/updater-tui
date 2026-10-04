#!/usr/bin/env bun
/**
 * Manual harness for the "trigger key leaks into the child" race.
 *
 * The bug (reproduced in `tests/enter-race.test.ts`): when a keypress both
 * *starts* an embedded terminal and focuses it, the renderer delivers that same
 * key to the just-created renderable, so the child receives a stray byte at
 * startup and answers its first prompt before you type.
 *
 * Manual harness: `bun run scripts/enter-race-check.ts`
 */
import { createTestRenderer } from "@opentui/core/testing";
import { EmbeddedTerminalRenderable } from "@opentui/core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHILD = `
process.stdout.write("ASKED\\r\\n");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  if (/[\\r\\n]/.test(buf)) {
    process.stdout.write("GOT:" + buf.replace(/[\\r\\n]/g, "") + "\\r\\n");
    buf = "";
  }
});
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), "enter-race-"));
  const child = join(dir, "child.js");
  await writeFile(child, CHILD);

  const setup = await createTestRenderer({ width: 40, height: 8 });
  const results: Array<[string, boolean]> = [];
  let panel: EmbeddedTerminalRenderable | null = null;
  let term: { write(data: string | Uint8Array): void } | null = null;

  // The fix: create AND focus the panel on the next tick, so the Enter that
  // triggered it is fully dispatched before the panel can receive keys.
  const start = (): void => {
    setTimeout(() => {
      const created = new EmbeddedTerminalRenderable(setup.renderer, {
        width: 40,
        height: 8,
        cols: 40,
        rows: 8,
        onData: (data) => term?.write(data),
      });
      setup.renderer.root.add(created);
      panel = created;

      const proc = Bun.spawn([process.execPath, child], {
        terminal: {
          cols: 40,
          rows: 8,
          data(_t: unknown, d?: Uint8Array) {
            created.write(d ?? (_t as Uint8Array));
          },
        },
      }) as unknown as {
        terminal: { write(d: string | Uint8Array): void };
        exited: Promise<number>;
        kill(): void;
      };
      term = proc.terminal;

      proc.exited.then(() => {
        try {
          proc.kill();
        } catch {
          /* already gone */
        }
      });

      // Focus only *after* the triggering key has been dispatched.
      created.focus();
    }, 0);
  };

  setup.renderer.keyInput.on("keypress", (key) => {
    if (key.name === "return" && panel === null) start();
  });

  const frameHas = async (needle: string, ms = 3000): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (setup.captureCharFrame().includes(needle)) return true;
      await sleep(50);
    }
    return false;
  };

  // The trigger Enter that starts the terminal.
  setup.mockInput.pressEnter();
  results.push(["child started and asked", await frameHas("ASKED")]);

  // Give any leaked keypress time to arrive — the child must still be waiting.
  await sleep(400);
  results.push([
    "trigger Enter did NOT leak into the child",
    !setup.captureCharFrame().includes("GOT:"),
  ]);

  // Now send real input and confirm delivery works.
  setup.mockInput.typeText("hello");
  setup.mockInput.pressEnter();
  results.push(["subsequent input reaches the child", await frameHas("GOT:hello")]);

  setup.renderer.destroy();
  await rm(dir, { recursive: true, force: true });

  console.log("--- results ---");
  for (const [name, ok] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  return results.every(([, ok]) => ok) ? 0 : 1;
}

process.exit(await main());
