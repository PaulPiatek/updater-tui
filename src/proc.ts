import { spawn as nodeSpawn } from "node:child_process";
import { withConsoleModeRestored } from "./console-mode";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  /**
   * When true, the child inherits the real terminal: stdin is connected (so
   * prompts work) and stdout/stderr stream live to the user instead of being
   * captured. `stdout`/`stderr` in the result are then empty.
   */
  inherit?: boolean;
}

/** A `.cmd` / `.bat` shim, which `node:child_process` refuses to spawn. */
const isShim = (command: string): boolean =>
  process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);

/** Drains a child stream to a string. */
async function readAll(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return "";
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Runs a command. Arguments are passed verbatim (no shell quoting).
 *
 * By default output is captured for parsing. With `inherit: true` the child is
 * wired to the current terminal, which is what interactive scripts need.
 *
 * Every child gets the console modes snapshotted and restored around it (see
 * console-mode.ts): it is not only interactive children that disturb them. A
 * captured package manager hands *our* console down to its installer, which
 * writes progress straight to the screen (`Starting Stub installer....` over the
 * status bar) and can leave the input mode broken, so the app stops reading
 * keys after a UAC prompt.
 *
 * To stop those writes at the source, captured children are spawned through
 * `node:child_process` with `windowsHide`, which maps to `CREATE_NO_WINDOW`:
 * the child gets its own *invisible* console, and anything it spawns inherits
 * that one. `Bun.spawn` cannot be used for this — its `windowsHide` only hides
 * a window, and `detached` gives the child a *visible* console (measured). It
 * is still used for `.cmd`/`.bat` shims, which `node:child_process` refuses
 * (EINVAL) and only Bun can run without hand-rolled quoting.
 */
export async function run(
  cmd: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  return withConsoleModeRestored(async () => {
    if (options.inherit) {
      // A child that takes over the console (especially an elevated one via UAC)
      // can leave the shared console input mode in a broken state. Snapshot it
      // before and restore it exactly afterwards — see console-mode.ts.
      const proc = Bun.spawn(cmd, {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        cwd: options.cwd,
      });
      const code = await proc.exited;
      return { code, stdout: "", stderr: "" };
    }

    const [program, ...args] = cmd;

    if (program !== undefined && isShim(program)) {
      // Bun runs the shim through cmd.exe for us; it shares our console, which
      // is tolerable (the package managers we call this way don't hand it on).
      const proc = Bun.spawn(cmd, {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        cwd: options.cwd,
        windowsHide: true,
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const code = await proc.exited;
      return { code, stdout, stderr };
    }

    const child = nodeSpawn(program ?? "", args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const [stdout, stderr, code] = await Promise.all([
      readAll(child.stdout),
      readAll(child.stderr),
      new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        // "close" (not "exit") is what guarantees the pipes above are drained.
        child.once("close", (exitCode) => resolve(exitCode ?? -1));
      }),
    ]);
    return { code, stdout, stderr };
  });
}

/**
 * Resolves an executable to a spawnable path. On Windows the package managers
 * are `.cmd` shims, so we resolve them through `Bun.which` (which respects
 * PATHEXT) and fall back to the plain name.
 */
export function which(command: string, fallback: string): string {
  return Bun.which(command) ?? fallback;
}
