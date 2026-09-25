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

/**
 * Runs a command. `Bun.spawn` is used directly (rather than `Bun.$`) so
 * arguments are passed verbatim without shell quoting issues.
 *
 * By default output is captured for parsing. With `inherit: true` the child is
 * wired to the current terminal, which is what interactive scripts need.
 */
export async function run(
  cmd: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  if (options.inherit) {
    // A child that takes over the console (especially an elevated one via UAC)
    // can leave the shared console input mode in a broken state. Snapshot it
    // before and restore it exactly afterwards — see console-mode.ts.
    return withConsoleModeRestored(async () => {
      const proc = Bun.spawn(cmd, {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        cwd: options.cwd,
      });
      const code = await proc.exited;
      return { code, stdout: "", stderr: "" };
    });
  }

  const proc = Bun.spawn(cmd, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    cwd: options.cwd,
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;

  return { code, stdout, stderr };
}

/**
 * Resolves an executable to a spawnable path. On Windows the package managers
 * are `.cmd` shims, so we resolve them through `Bun.which` (which respects
 * PATHEXT) and fall back to the plain name.
 */
export function which(command: string, fallback: string): string {
  return Bun.which(command) ?? fallback;
}
