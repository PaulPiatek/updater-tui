/**
 * Interactive TUI integration checks.
 *
 * A full-screen TUI can't be driven by piping stdin — it needs a real terminal.
 * This script spawns the app on Bun's built-in PTY (ConPTY on Windows) and
 * watches the raw output for markers that prove the flow works.
 *
 * It is a manual harness, not part of `bun test`: it runs the source tree and
 * takes tens of seconds. Run it with `bun run scripts/pty-check.ts`.
 *
 * The custom-script case uses a temp project config, so it never touches the
 * machine's real config.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const TIMEOUT = 90_000;

interface Harness {
  raw: string[];
  write(data: string): void;
  waitFor(marker: string, timeoutMs?: number): Promise<boolean>;
  exited(): Promise<number | "timeout">;
  dispose(): Promise<void>;
}

async function spawnApp(
  args: string[],
  cwd: string,
  env: Record<string, string | undefined> = {},
): Promise<Harness> {
  const raw: string[] = [];
  const decoder = new TextDecoder();
  const proc = Bun.spawn(["bun", ENTRY, ...args], {
    cwd,
    env: { ...process.env, NO_COLOR: "1", ...env },
    terminal: {
      cols: 120,
      rows: 30,
      data(_t: unknown, d?: Uint8Array) {
        raw.push(decoder.decode(d ?? (_t as Uint8Array)));
      },
    },
  });

  const terminal = proc.terminal;
  if (!terminal) throw new Error("PTY terminal was not created");

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  return {
    raw,
    write: (data) => terminal.write(data),
    async waitFor(marker, timeoutMs = TIMEOUT) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (raw.join("").includes(marker)) return true;
        await sleep(100);
      }
      return false;
    },
    async exited() {
      const result = await Promise.race([
        proc.exited,
        sleep(10_000).then(() => "timeout" as const),
      ]);
      return result;
    },
    async dispose() {
      if (proc.exitCode === null) proc.kill();
      await proc.exited.catch(() => {});
    },
  };
}

function report(name: string, results: Array<[string, boolean]>): boolean {
  const ok = results.every(([, value]) => value);
  console.log(`\n${ok ? "PASS" : "FAIL"}  ${name}`);
  for (const [label, value] of results) {
    console.log(`  ${value ? "✓" : "✗"} ${label}`);
  }
  return ok;
}

/** Boots the app against a temp config with one interactive script. */
async function customScriptCase(): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), "updater-tui-pty-"));
  const scriptPath = join(dir, "fake-update.cmd");
  await writeFile(
    scriptPath,
    [
      "@echo off",
      "echo SCRIPT-START-MARKER",
      "set /p answer=SCRIPT-PROMPT ",
      "echo SCRIPT-GOT:%answer%",
      "exit /b 0",
    ].join("\r\n"),
  );
  await writeFile(
    join(dir, "updater.config.json"),
    JSON.stringify({
      ignore: [],
      pin: [],
      scripts: [{ name: "pty-fake", path: scriptPath }],
    }),
  );

  const app = await spawnApp(["--source", "custom"], dir);
  const results: Array<[string, boolean]> = [];
  try {
    results.push(["app boots", await app.waitFor("Select sources")]);
    app.write("\r");
    results.push(["scan reaches the package stage", await app.waitFor("Choose packages")]);
    app.write("\r");
    results.push(["script ran under the TUI", await app.waitFor("SCRIPT-START-MARKER")]);
    results.push(["script prompt reached", await app.waitFor("SCRIPT-PROMPT")]);
    app.write("hello\r");
    results.push(["script received input", await app.waitFor("SCRIPT-GOT:hello")]);
    results.push(["app resumed and finished", await app.waitFor("Done:")]);
    app.write("q");
    results.push(["exits cleanly", (await app.exited()) === 0]);
  } finally {
    await app.dispose();
    await rm(dir, { recursive: true, force: true });
  }
  return report("custom script (suspend/resume)", results);
}

/** Boots the app normally and checks both panes and a clean quit. */
async function smokeCase(): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), "updater-tui-smoke-"));
  await writeFile(
    join(dir, "updater.config.json"),
    JSON.stringify({ ignore: [], pin: [], scripts: [] }),
  );
  const app = await spawnApp(["--source", "custom"], dir);
  const results: Array<[string, boolean]> = [];
  try {
    results.push(["sources stage renders", (await app.waitFor("Sources")) || (await app.waitFor("Select sources"))]);
    results.push(["output pane renders", await app.waitFor("Output")]);
    results.push(["key hints render", await app.waitFor("space toggle")]);
    app.write("q");
    const code = await app.exited();
    results.push(["quits cleanly", code === 0 || code === 130]);
  } finally {
    await app.dispose();
    await rm(dir, { recursive: true, force: true });
  }
  return report("app smoke", results);
}

const outcomes = [await smokeCase(), await customScriptCase()];
console.log(`\n${outcomes.every(Boolean) ? "ALL PASS" : "SOME FAILED"}`);
process.exit(outcomes.every(Boolean) ? 0 : 1);
