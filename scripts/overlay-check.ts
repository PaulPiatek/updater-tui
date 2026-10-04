#!/usr/bin/env bun
/**
 * End-to-end check for the embedded-terminal overlay.
 *
 * Boots the real app under Bun's PTY with two fake custom scripts and drives it
 * with keys. Because a PTY output is diffed, we assert on markers that imply a
 * *change* (overlay header, prompt echoing typed input, the script's final
 * line), not on "the screen contains X".
 *
 * Run: bun run scripts/overlay-check.ts
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");

const dir = await mkdtemp(join(tmpdir(), "updater-overlay-"));
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
const proc = Bun.spawn(["bun", ENTRY, "--source", "custom"], {
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
  results.push(["app boots", await waitFor("Select sources")]);
  term.write("\r"); // scan
  results.push(["scan reaches package stage", await waitFor("Choose packages")]);

  // Both scripts are selected by default. Upgrade them.
  term.write("\r");
  // Header/footer text arrives through the PTY diff, which splits it across
  // cursor moves — so match a fragment, not the whole phrase.
  results.push(["overlay footer renders", await waitFor("Ctrl+Q")]);
  results.push(["first script output streamed in the pane", await waitFor("PROMPT-ASKED")]);
  results.push(["the child's prompt is visible", await waitFor("WHAT-NAME")]);

  // The prompt script asked; answer it through the pane.
  await sleep(500);
  term.write("hello\r");
  results.push(["typed input reached the child", await waitFor("ANSWER-GOT:hello")]);
  results.push(["first run finished", await waitFor("ANSWER-GOT:")]);

  results.push(["second script still ran (overlay reused)", await waitFor("FAST-DONE")]);
  results.push(["run finished with a summary", await waitFor("upgraded")]);

  term.write("q");
  const code = await Promise.race([
    proc.exited,
    sleep(10_000).then(() => "timeout" as const),
  ]);
  results.push(["quits cleanly", code === 0 || code === 130]);
} finally {
  if (proc.exitCode === null) proc.kill();
  await proc.exited.catch(() => {});
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

for (const [label, ok] of results) console.log(`${ok ? "✓" : "✗"} ${label}`);
const ok = results.every(([, value]) => value);
console.log(ok ? "\nPASS  embedded-terminal overlay" : "\nFAIL  embedded-terminal overlay");
process.exit(ok ? 0 : 1);
