/**
 * Runs the compiled executable on a PTY and checks the TUI renders and reacts.
 *
 * Uses a temp project config with one real (harmless) script so `--source
 * custom` has a source to find, independent of the machine's own config.
 *
 * Run: bun run scripts/pty-exe-check.ts
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXE = join(import.meta.dir, "..", "dist", "updater-tui.exe");
if (!(await Bun.file(EXE).exists())) {
  console.error(`✖ ${EXE} not found. Run \`bun run build:exe\` first.`);
  process.exit(1);
}

const dir = await mkdtemp(join(tmpdir(), "updater-tui-exe-"));
const scriptPath = join(dir, "fake.cmd");
await writeFile(scriptPath, "@echo off\r\nexit /b 0\r\n");
await writeFile(
  join(dir, "updater.config.json"),
  JSON.stringify({ ignore: [], pin: [], scripts: [{ name: "fake", path: scriptPath }] }),
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
  results.push(["exe renders the sources pane", await waitFor("Sources")]);
  results.push(["exe lists the custom source", await waitFor("Custom scripts")]);
  results.push(["exe shows key hints", await waitFor("space toggle")]);

  // Enter -> scan -> package stage proves keys reach the renderer and the
  // script row appears.
  proc.terminal?.write("\r");
  results.push(["exe reacts to Enter (scan)", await waitFor("Choose packages")]);
  results.push(["exe lists the script by name", await waitFor("fake")]);

  proc.terminal?.write("q");
  const code = await Promise.race([
    proc.exited,
    sleep(10_000).then(() => "timeout" as const),
  ]);
  results.push(["exe quits cleanly", code === 0 || code === 130]);
} finally {
  if (proc.exitCode === null) proc.kill();
  await proc.exited.catch(() => {});
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

for (const [label, ok] of results) {
  console.log(`${ok ? "✓" : "✗"} ${label}`);
}
const ok = results.every(([, value]) => value);
console.log(ok ? "\nPASS  compiled executable TUI" : "\nFAIL  compiled executable TUI");
process.exit(ok ? 0 : 1);
