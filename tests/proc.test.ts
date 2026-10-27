/**
 * Guards `proc.run` (AGENTS rule 2).
 *
 * A captured child shares this process's console, and package managers hand it
 * down to their installers. Those write progress straight to the screen — which
 * scribbles over the TUI — and can leave the console input mode broken, after
 * which the app stops reacting to keys. Captured children are therefore spawned
 * so they get their own *invisible* console (CREATE_NO_WINDOW).
 *
 * Other test files replace `src/proc` with a mock, and Bun keeps one module
 * registry for the whole run (a mock overwrites the loaded exports for good), so
 * the real module is exercised in fresh Bun processes.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROC_URL = new URL("../src/proc.ts", import.meta.url).href;

/** Runs a small script that imports the real `proc` and prints what it saw. */
async function probe(script: string, args: string[] = []): Promise<string> {
  const child = Bun.spawn([process.execPath, "-e", script, PROC_URL, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const code = await child.exited;
  if (code !== 0) throw new Error(`probe failed (${code}): ${stderr}`);
  return stdout.trim();
}

test("returns the child's output and exit code", async () => {
  const childCode = "console.log('out'); console.error('err'); process.exit(3)";
  const result = JSON.parse(
    await probe(
      `
      const { run } = await import(process.argv[1]);
      const r = await run([process.execPath, "-e", ${JSON.stringify(childCode)}]);
      console.log(JSON.stringify(r));
      `,
    ),
  ) as { code: number; stdout: string; stderr: string };

  expect(result.code).toBe(3);
  expect(result.stdout.trim()).toBe("out");
  expect(result.stderr.trim()).toBe("err");
});

test(".cmd shims still run (they cannot go through node:child_process)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "updater-proc-"));
  created.push(dir);
  const shim = join(dir, "shim.cmd");
  await writeFile(shim, "@echo off\r\necho shim-ok\r\n");

  const result = JSON.parse(
    await probe(
      `
      const { run } = await import(process.argv[1]);
      const r = await run([process.argv[2]]);
      console.log(JSON.stringify(r));
      `,
      [shim],
    ),
  ) as { code: number; stdout: string };

  expect(result.code).toBe(0);
  expect(result.stdout.trim()).toBe("shim-ok");
});

test("captured children cannot write to our console", async () => {
  if (process.platform !== "win32") return;

  // Run the real `proc` on a ConPTY (a real console), then have a grandchild
  // write to CONOUT$ directly — the way an installer prints its progress. A
  // child that inherited our console leaks the marker into the pty stream.
  const script = `
    const { run } = await import(process.argv[1]);
    await run(["cmd", "/c", "echo CONSOLE-LEAK-MARKER> CON"]);
    console.log("after-run");
  `;
  const raw: string[] = [];
  const decoder = new TextDecoder();
  const host = Bun.spawn([process.execPath, "-e", script, PROC_URL], {
    terminal: {
      cols: 100,
      rows: 30,
      data: (_t: unknown, bytes?: Uint8Array) => {
        raw.push(decoder.decode(bytes ?? (_t as Uint8Array)));
      },
    },
  });
  const code = await host.exited;
  const screen = raw.join("");

  expect(code).toBe(0);
  expect(screen).toContain("after-run");
  expect(screen).not.toContain("CONSOLE-LEAK-MARKER");
});

const created: string[] = [];
afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

test("an aborted run kills the child instead of waiting for it", async () => {
  const result = JSON.parse(
    await probe(
      `
      const { run } = await import(process.argv[1]);
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 150);
      const started = performance.now();
      const r = await run(
        [process.execPath, "-e", "setTimeout(() => {}, 5000)"],
        { signal: controller.signal },
      );
      console.log(JSON.stringify({ code: r.code, ms: Math.round(performance.now() - started) }));
      `,
    ),
  ) as { code: number; ms: number };

  // The child would run for 5 s; the abort must end it promptly.
  expect(result.ms).toBeLessThan(3_000);
});
