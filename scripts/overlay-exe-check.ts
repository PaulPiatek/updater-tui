#!/usr/bin/env bun
/**
 * End-to-end check for the embedded-terminal overlay **in the compiled exe**.
 *
 * `overlay-check.ts` drives the overlay from source; this drives the shipped
 * `dist/updater-tui.exe` the same way, from a temp cwd (so the exe can't pick
 * up the repo's `updater.config.json` or a stray `bunfig.toml`).
 *
 * The overlay is the one piece that mixes a custom renderable with the native
 * renderer, so it is the part most likely to break on an OpenTUI upgrade and
 * the part a plain "does the pane render" check would miss.
 *
 * Run: bun run scripts/overlay-exe-check.ts
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXE = join(import.meta.dir, "..", "dist", "updater-tui.exe");

const dir = await mkdtemp(join(tmpdir(), "updater-overlay-exe-"));
const promptScript = join(dir, "prompt.cmd");
await writeFile(
  promptScript,
  [
    "@echo off",
    "echo PROMPT-ASKED",
    "set /p answer=WHAT-NAME ",
    "echo ANSWER-GOT:%answer%",
    "exit /b 0",
  ].join("\r\n"),
);
const fastScript = join(dir, "fast.cmd");
await writeFile(fastScript, ["@echo off", "echo FAST-DONE", "exit /b 0"].join("\r\n"));
await writeFile(
  join(dir, "updater.config.json"),
  JSON.stringify({
    ignore: [],
    pin: [],
    scripts: [
      { name: "fast", path: fastScript },
      { name: "ask", path: promptScript },
    ],
  }),
);

const raw: string[] = [];
const decoder = new TextDecoder();
const proc = Bun.spawn([EXE, "--source", "custom"], {
  cwd: dir,
  env: { ...process.env, NO_COLOR: "1" },
  terminal: {
    cols: 110,
    rows: 28,
    data(_t: unknown, d?: Uint8Array) {
      raw.push(decoder.decode(d ?? (_t as Uint8Array)));
    },
  },
});
const term = proc.terminal;
if (!term) throw new Error("PTY terminal was not created");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(marker: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (raw.join("").includes(marker)) return true;
    await sleep(100);
  }
  return false;
}

const results: Array<[string, boolean]> = [];
try {
  results.push(["exe boots", await waitFor("Select sources")]);
  term.write("\r"); // scan
  results.push(["scan reaches package stage", await waitFor("Choose packages")]);

  term.write("\r"); // upgrade both scripts
  results.push(["overlay footer renders", await waitFor("Ctrl+Q")]);
  results.push(["first script output streamed in the pane", await waitFor("PROMPT-ASKED")]);
  results.push(["the child's prompt is visible", await waitFor("WHAT-NAME")]);

  await sleep(500);
  term.write("hello\r");
  results.push(["typed input reached the child", await waitFor("ANSWER-GOT:hello")]);

  results.push(["second script still ran (overlay reused)", await waitFor("FAST-DONE")]);
  results.push(["run finished with a summary", await waitFor("upgraded")]);

  term.write("q");
  const code = await Promise.race([proc.exited, sleep(10_000).then(() => "timeout" as const)]);
  results.push(["quits cleanly", code === 0 || code === 130]);
} finally {
  if (proc.exitCode === null) proc.kill();
  await proc.exited.catch(() => {});
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

for (const [label, ok] of results) console.log(`${ok ? "✓" : "✗"} ${label}`);
const ok = results.every(([, value]) => value);
console.log(ok ? "\nPASS  embedded-terminal overlay (exe)" : "\nFAIL  embedded-terminal overlay (exe)");
process.exit(ok ? 0 : 1);
