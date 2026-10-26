import { dlopen, FFIType } from "bun:ffi";
import { log } from "./log";

/**
 * Windows console-mode helpers.
 *
 * A prompt UI leaves the console in raw input mode, and Bun's `setRawMode(false)`
 * does NOT restore the original mode — it lands on a different value (0x7),
 * losing flags the console had before. An elevated child (UAC) makes it worse,
 * and a child can also disable virtual-terminal processing on the output, which
 * turns the UI's escape sequences into garbage. So instead of guessing, we
 * snapshot the real modes (input *and* output) and put them back exactly.
 *
 * Everything here is a no-op on non-Windows or when the handle is not a console.
 */

const STD_INPUT_HANDLE = -10;
const STD_OUTPUT_HANDLE = -11;

let api:
  | {
      getStdHandle: (n: number) => number;
      getConsoleMode: (handle: number, out: Uint32Array) => number;
      setConsoleMode: (handle: number, mode: number) => number;
    }
  | null
  | undefined;

function loadApi(): typeof api {
  if (api !== undefined) return api;
  if (process.platform !== "win32") {
    api = null;
    return api;
  }
  try {
    const lib = dlopen("kernel32.dll", {
      GetStdHandle: { args: [FFIType.i32], returns: FFIType.ptr },
      GetConsoleMode: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      SetConsoleMode: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    });
    const symbols = lib.symbols;
    api = {
      getStdHandle: (n) => Number(symbols.GetStdHandle(n)),
      getConsoleMode: (handle, out) =>
        symbols.GetConsoleMode(handle as never, out as never),
      setConsoleMode: (handle, mode) =>
        symbols.SetConsoleMode(handle as never, mode),
    };
  } catch {
    api = null;
  }
  return api;
}

/** Reads a console mode for `handle`, or null if unavailable. */
function readMode(handleNumber: number): number | null {
  const ffi = loadApi();
  if (!ffi) return null;
  try {
    const handle = ffi.getStdHandle(handleNumber);
    if (!handle) return null;
    const out = new Uint32Array(1);
    const ok = ffi.getConsoleMode(handle, out);
    return ok ? out[0]! : null;
  } catch {
    return null;
  }
}

/** Writes a console mode for `handle`. Returns true on success. */
function writeMode(handleNumber: number, mode: number): boolean {
  const ffi = loadApi();
  if (!ffi) return false;
  try {
    const handle = ffi.getStdHandle(handleNumber);
    if (!handle) return false;
    return ffi.setConsoleMode(handle, mode) !== 0;
  } catch {
    return false;
  }
}

/** Reads the current console input mode, or null if unavailable. */
export function getConsoleInputMode(): number | null {
  return readMode(STD_INPUT_HANDLE);
}

/** Writes a console input mode. Returns true on success. */
export function setConsoleInputMode(mode: number): boolean {
  return writeMode(STD_INPUT_HANDLE, mode);
}

/** Reads the current console output mode, or null if unavailable. */
export function getConsoleOutputMode(): number | null {
  return readMode(STD_OUTPUT_HANDLE);
}

/** Writes a console output mode. Returns true on success. */
export function setConsoleOutputMode(mode: number): boolean {
  return writeMode(STD_OUTPUT_HANDLE, mode);
}

/** `0x1f7`-style formatting; null when the handle is not a console. */
const hex = (mode: number | null): string | null =>
  mode === null ? null : `0x${mode.toString(16)}`;

/**
 * Runs `fn` after taking a snapshot of the console modes, restoring those exact
 * modes afterwards — even if the callback spawns a child that changes them.
 *
 * It also records what the child left behind (`console.mode`), because a mode
 * that had to be repaired is the one clue that a run "froze" on a console
 * problem rather than on an update.
 */
export async function withConsoleModeRestored<T>(
  fn: () => Promise<T>,
): Promise<T> {
  const savedInput = getConsoleInputMode();
  const savedOutput = getConsoleOutputMode();
  try {
    return await fn();
  } finally {
    const disturbedInput = getConsoleInputMode();
    const disturbedOutput = getConsoleOutputMode();
    if (savedInput !== null) setConsoleInputMode(savedInput);
    if (savedOutput !== null) setConsoleOutputMode(savedOutput);

    if (savedInput !== null || savedOutput !== null) {
      const disturbed =
        disturbedInput !== savedInput || disturbedOutput !== savedOutput;
      log(
        "console.mode",
        {
          before: { input: hex(savedInput), output: hex(savedOutput) },
          disturbed: { input: hex(disturbedInput), output: hex(disturbedOutput) },
          restored: {
            input: hex(getConsoleInputMode()),
            output: hex(getConsoleOutputMode()),
          },
        },
        disturbed ? "warn" : "debug",
      );
    }
  }
}
