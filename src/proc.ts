import { spawn as nodeSpawn } from "node:child_process";
import { withConsoleModeRestored } from "./console-mode";
import { beginProcLog } from "./log";

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

/**
 * Drains a child stream to a string, reporting each chunk as it arrives so the
 * diagnostic log can keep a rolling tail and byte count (see `log.ts`).
 */
async function readAll(
  stream: NodeJS.ReadableStream | null,
  onChunk?: (bytes: Uint8Array) => void,
): Promise<string> {
  if (!stream) return "";
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Uint8Array);
    onChunk?.(bytes);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Ditto for a web stream, which is what `Bun.spawn` hands back. */
async function readWeb(
  stream: ReadableStream<Uint8Array> | null | undefined,
  onChunk?: (bytes: Uint8Array) => void,
): Promise<string> {
  if (!stream) return "";
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    onChunk?.(chunk);
    chunks.push(chunk);
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
      const procLog = beginProcLog(cmd, "inherit", { cwd: options.cwd });
      let proc: ReturnType<typeof Bun.spawn>;
      try {
        proc = Bun.spawn(cmd, {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
          cwd: options.cwd,
        });
      } catch (err) {
        procLog.failed(err);
        throw err;
      }
      procLog.spawned(proc.pid);
      try {
        const code = await proc.exited;
        procLog.exited(code, null);
        return { code, stdout: "", stderr: "" };
      } catch (err) {
        procLog.failed(err);
        throw err;
      }
    }

    const [program, ...args] = cmd;

    if (program !== undefined && isShim(program)) {
      // Bun runs the shim through cmd.exe for us; it shares our console, which
      // is tolerable (the package managers we call this way don't hand it on).
      const procLog = beginProcLog(cmd, "bun-shim", { cwd: options.cwd });
      let proc: ReturnType<typeof Bun.spawn>;
      try {
        proc = Bun.spawn(cmd, {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          cwd: options.cwd,
          windowsHide: true,
        });
      } catch (err) {
        procLog.failed(err);
        throw err;
      }
      procLog.spawned(proc.pid);
      try {
        const [stdout, stderr] = await Promise.all([
          readWeb(proc.stdout as ReadableStream<Uint8Array> | undefined, (bytes) =>
            procLog.push("out", bytes),
          ),
          readWeb(proc.stderr as ReadableStream<Uint8Array> | undefined, (bytes) =>
            procLog.push("err", bytes),
          ),
        ]);
        const code = await proc.exited;
        procLog.exited(code, proc.signalCode ?? null, stdout, stderr);
        return { code, stdout, stderr };
      } catch (err) {
        procLog.failed(err);
        throw err;
      }
    }

    const procLog = beginProcLog(cmd, "node-children", { cwd: options.cwd });
    let child: ReturnType<typeof nodeSpawn>;
    try {
      child = nodeSpawn(program ?? "", args, {
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      procLog.failed(err);
      throw err;
    }
    procLog.spawned(child.pid);
    try {
      const [stdout, stderr, code] = await Promise.all([
        readAll(child.stdout, (bytes) => procLog.push("out", bytes)),
        readAll(child.stderr, (bytes) => procLog.push("err", bytes)),
        new Promise<number>((resolve, reject) => {
          child.once("error", reject);
          // "close" (not "exit") is what guarantees the pipes above are drained.
          child.once("close", (exitCode) => resolve(exitCode ?? -1));
        }),
      ]);
      procLog.exited(code, child.signalCode ?? null, stdout, stderr);
      return { code, stdout, stderr };
    } catch (err) {
      procLog.failed(err);
      throw err;
    }
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
