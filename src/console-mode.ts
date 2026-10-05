import { dlopen, FFIType } from "bun:ffi";

/**
 * Windows console-mode helpers.
 *
 * A prompt UI leaves the console in raw input mode, and Bun's `setRawMode(false)`
 * does NOT restore the original mode — it lands on a different value (0x7),
 * losing flags the console had before. An elevated child (UAC) makes it worse.
 * So instead of guessing, we snapshot the real mode and put it back exactly.
 *
 * Everything here is a no-op on non-Windows or when stdin is not a console.
 */

const STD_INPUT_HANDLE = -10;

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

/** Reads the current console input mode, or null if unavailable. */
export function getConsoleInputMode(): number | null {
  const ffi = loadApi();
  if (!ffi) return null;
  try {
    const handle = ffi.getStdHandle(STD_INPUT_HANDLE);
    if (!handle) return null;
    const out = new Uint32Array(1);
    const ok = ffi.getConsoleMode(handle, out);
    return ok ? out[0]! : null;
  } catch {
    return null;
  }
}

/** Writes a console input mode. Returns true on success. */
export function setConsoleInputMode(mode: number): boolean {
  const ffi = loadApi();
  if (!ffi) return false;
  try {
    const handle = ffi.getStdHandle(STD_INPUT_HANDLE);
    if (!handle) return false;
    return ffi.setConsoleMode(handle, mode) !== 0;
  } catch {
    return false;
  }
}

/**
 * Runs `fn` after taking a snapshot of the console input mode, restoring that
 * exact mode afterwards — even if the callback spawns a child that changes it.
 */
export async function withConsoleModeRestored<T>(
  fn: () => Promise<T>,
): Promise<T> {
  const saved = getConsoleInputMode();
  try {
    return await fn();
  } finally {
    if (saved !== null) setConsoleInputMode(saved);
  }
}
