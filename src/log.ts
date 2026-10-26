/**
 * The diagnostic log: one JSONL file per run, in the temp folder.
 *
 * Why it exists: a run can fail in ways the UI never shows — a child that never
 * exits, a result that is computed but never reaches the pane, an overlay whose
 * promise never settles, a console mode an elevated child left broken. So the
 * log records **entry/exit pairs for every awaitable gap**, which makes each of
 * those falsifiable from the file alone:
 *
 *   proc.spawn ─ proc.heartbeat… ─ proc.exit            did the child come back?
 *   proc.exit  ─ store.verdict                          did the source decide?
 *   store.verdict ─ engine.result ─ ui.result           did it reach the screen?
 *   overlay.open ─ overlay.child.exit ─ overlay.close   did the promise settle?
 *   console.mode {before, disturbed, restored}          was the console broken?
 *
 * Rules this module keeps:
 *
 * - **Never throws.** Logging an error must not become the error.
 * - **Never writes to stdout/stderr.** The TUI owns the screen, and `--json`
 *   must stay parseable (callers print `logPath()` themselves when useful).
 * - **One line per event.** JSON escapes `\r`/`\n`, so even CRLF-heavy progress
 *   output can't split an entry. `appendFileSync` (not a buffered stream) so a
 *   frozen process still leaves its tail behind.
 * - **Bounded.** Fields are clipped, lines capped, and the newest 10 files /
 *   2 MB are kept, so a hung run is never evicted by its own noise.
 *
 * Default is on at `info`. `NODE_ENV=test` defaults to `off` so `bun test` can
 * neither write nor evict real logs; tests set `UPDATER_LOG_DIR` and a level.
 */
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";
/** `off` is accepted from the CLI/env, but `log()` itself takes a real level. */
export type LogLevelName = LogLevel | "off";
/** Which way this process is presenting itself (goes on every line). */
export type LogMode = "tui" | "headless" | "json" | "dry-run" | "unknown";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Per-field cap. Long output is kept as a tail, not dumped whole. */
export const MAX_FIELD_CHARS = 8 * 1024;
/** Hard cap per line; a bigger event keeps its envelope plus a head snippet. */
const MAX_LINE_CHARS = 32 * 1024;
const KEEP_FILES = 10;
const MAX_DIR_BYTES = 2 * 1024 * 1024;
const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_STALL_MS = 180_000;
/** Rolling buffer kept per child stream, for heartbeat/stall tails. */
const TAIL_BUFFER = 2 * 1024;

interface LogState {
  file: string;
  floor: number;
  mode: LogMode;
  session: string;
  seq: number;
}

let state: LogState | null = null;
/** Set when the log is off by level, or after a write failure. */
let off = false;
let levelOverride: LogLevelName | null = null;
let fileOverride: string | null = null;
let mode: LogMode = "unknown";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const pad = (value: number, width = 2): string => String(value).padStart(width, "0");

/** `yyyyMMdd-HHmmss`, local time — one file per run, sortable by name. */
function stamp(date: Date = new Date()): string {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function envLevel(): LogLevelName {
  const raw = (process.env.UPDATER_LOG_LEVEL ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "none" || raw === "silent") return "off";
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  // `bun test` sets NODE_ENV=test: tests must not write to (or prune) the real
  // log folder. They opt in by setting a level after `resetLog()`.
  return process.env.NODE_ENV === "test" ? "off" : "info";
}

function envMs(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

/**
 * Deletes the oldest log files so runs can never fill the temp folder. One slot
 * is reserved for the file the caller is about to create (pruning runs *before*
 * that file exists, so keeping `KEEP_FILES` of the old ones would end at 11).
 */
function prune(dir: string): void {
  try {
    const entries = readdirSync(dir)
      .filter((name) => /^updater-.*\.log$/.test(name))
      .map((name) => {
        const path = join(dir, name);
        try {
          const stats = statSync(path);
          return { path, mtime: stats.mtimeMs, size: stats.size };
        } catch {
          return null;
        }
      })
      .filter((entry): entry is { path: string; mtime: number; size: number } => entry !== null)
      .sort((a, b) => b.mtime - a.mtime);

    let bytes = 0;
    for (const [index, entry] of entries.entries()) {
      bytes += entry.size;
      if (index >= KEEP_FILES - 1 || bytes > MAX_DIR_BYTES) rmSync(entry.path, { force: true });
    }
  } catch {
    // Best effort: a read-only temp folder just means no pruning.
  }
}

/** Creates the log file on first use. Returns null when logging is off. */
function ensure(): LogState | null {
  if (off) return null;
  if (state) return state;
  try {
    const level = levelOverride ?? envLevel();
    if (level === "off") {
      off = true;
      return null;
    }
    const file =
      fileOverride ??
      join(
        process.env.UPDATER_LOG_DIR?.trim() || join(tmpdir(), "updater-tui"),
        `updater-${stamp()}-${process.pid}.log`,
      );
    const dir = dirname(file);
    mkdirSync(dir, { recursive: true });
    if (fileOverride === null) prune(dir);
    state = {
      file,
      floor: LEVELS[level],
      mode,
      session: crypto.randomUUID().slice(0, 8),
      seq: 0,
    };
    return state;
  } catch {
    off = true;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public setup API
// ---------------------------------------------------------------------------

/** Where this run logs to, or null when logging is off. */
export function logPath(): string | null {
  return ensure()?.file ?? null;
}

/** Whether events would actually be written (cheap: no file is created). */
export function logEnabled(): boolean {
  return ensure() !== null;
}

export function setLogMode(next: LogMode): void {
  mode = next;
  if (state) state.mode = next;
}

export function setLogLevel(level: LogLevelName): void {
  levelOverride = level;
  off = false;
  state = null;
}

/** Overrides the file (the `--log <path>` flag), skipping the prune step. */
export function setLogFile(file: string): void {
  fileOverride = file;
  off = false;
  state = null;
}

/** Forgets all overrides so the next event re-reads the environment. */
export function resetLog(): void {
  state = null;
  off = false;
  levelOverride = null;
  fileOverride = null;
  mode = "unknown";
}

/**
 * Writes `session.start` — the first line of every run, and the one that says
 * where the file is. Extra fields (version, argv, …) are merged in.
 */
export function startLog(extra: Record<string, unknown> = {}): string | null {
  const current = ensure();
  if (!current) return null;
  log(
    "session.start",
    {
      file: current.file,
      mode: current.mode,
      platform: `${process.platform} ${process.arch}`,
      bun: Bun.version,
      argv: Bun.argv,
      tty: { stdin: process.stdin.isTTY === true, stdout: process.stdout.isTTY === true },
      terminal: {
        columns: process.stdout.columns ?? null,
        rows: process.stdout.rows ?? null,
      },
      ...extra,
    },
    "info",
  );
  return current.file;
}

/** Writes `session.end`, so a log whose tail is missing is identifiable. */
export function endLog(exitCode: number, extra: Record<string, unknown> = {}): void {
  log("session.end", { exitCode, file: logPath(), ...extra }, exitCode === 0 ? "info" : "warn");
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Clips a string to `max` characters, keeping the head. */
export function clip(text: string, max: number = MAX_FIELD_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…<${text.length - max} more chars>`;
}

/** Clips a string to its last `max` characters — what a tail wants. */
export function tailOf(text: string, max: number): string {
  if (text.length <= max) return text;
  return `…<${text.length - max} earlier chars>${text.slice(-max)}`;
}

const keepTail = (text: string, max: number): string =>
  text.length > max ? text.slice(-max) : text;

/**
 * Turns arbitrary values into JSON-safe data: strings clipped, errors flattened
 * to name/message/stack, arrays capped, `undefined` dropped.
 */
function sanitize(value: unknown, depth = 0): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string") return clip(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: clip(value.message),
      stack: value.stack ? clip(value.stack) : undefined,
    };
  }
  if (Array.isArray(value)) {
    // Arrays stay readable at any depth (config `args`, update id lists): only
    // their *items* get depth-limited, so `[… 3 items]` never hides the very
    // thing the log exists to show.
    const head = value.slice(0, 20).map((entry) => sanitize(entry, depth + 1));
    return value.length > head.length ? [...head, `…<${value.length - head.length} more items>`] : head;
  }
  if (typeof value === "object") {
    if (depth >= 4) return "[…]"
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const clean = sanitize(entry, depth + 1);
      if (clean !== undefined) out[key] = clean;
    }
    return out;
  }
  return clip(String(value));
}

/**
 * Appends one event. `data` may carry the conventional `src` / `item` / `phase`
 * / `elapsedMs` keys; envelope fields (`ts`, `mono`, `seq`, `level`, `event`,
 * `session`, `pid`, `mode`) always win, so a caller can't corrupt them.
 */
export function log(
  event: string,
  data: Record<string, unknown> = {},
  level: LogLevel = "info",
): void {
  const current = ensure();
  if (!current) return;
  if (LEVELS[level] < current.floor) return;
  try {
    const seq = ++current.seq;
    const mono = Math.round(performance.now());
    const ts = new Date().toISOString();
    const entry: Record<string, unknown> = {
      ...((sanitize(data) as Record<string, unknown> | undefined) ?? {}),
      ts,
      mono,
      seq,
      level,
      event,
      session: current.session,
      pid: process.pid,
      mode: current.mode,
    };
    let line = JSON.stringify(entry);
    if (line.length > MAX_LINE_CHARS) {
      // Keep the envelope so the event is still countable, plus a snippet.
      line = JSON.stringify({
        ts,
        mono,
        seq,
        level,
        event,
        session: current.session,
        pid: process.pid,
        mode: current.mode,
        data: { dropped: "event too large", chars: line.length, head: clip(line, 2_048) },
      });
    }
    appendFileSync(current.file, `${line}\n`);
  } catch {
    // A failed write must not break the run — or throw again.
    off = true;
  }
}

// ---------------------------------------------------------------------------
// Child processes
// ---------------------------------------------------------------------------

/** How a child was spawned, which is what rule 2 of AGENTS.md is about. */
export type ProcStyle = "inherit" | "node-children" | "bun-shim" | "pty";

export interface ProcLogOptions {
  cwd?: string;
  /** Source/item context, when the caller knows it. */
  src?: string;
  item?: string;
}

/**
 * Instrumentation for one child. Pair `spawned` with `exited` (or `failed`), and
 * feed every chunk to `push` so a hang records what the child was printing.
 */
export interface ProcLog {
  readonly id: number;
  spawned(pid?: number): void;
  failed(err: unknown): void;
  push(which: "out" | "err", bytes: Uint8Array): void;
  exited(
    code: number,
    /** `Bun.spawn` reports a number, `node:child_process` a string. */
    signal?: string | number | null,
    stdout?: string,
    stderr?: string,
  ): void;
  dispose(): void;
}

const NOOP_PROC_LOG: ProcLog = {
  id: 0,
  spawned: () => {},
  failed: () => {},
  push: () => {},
  exited: () => {},
  dispose: () => {},
};

let spawnIds = 0;

const unrefTimer = (timer: ReturnType<typeof setInterval>): void => {
  (timer as unknown as { unref?: () => void }).unref?.();
};

/**
 * Starts logging one child process.
 *
 * The heartbeat is the anti-hang signal: every few seconds while the child is
 * alive it records elapsed time, bytes received and the last output characters
 * (`tail`), so a stalled run shows *where* it stalled. The stall warning repeats
 * on a much longer interval and **never kills the child** — a Store self-update
 * sits at `Installing: 95%` for ~30 s and Windows Update can run for minutes.
 */
export function beginProcLog(
  cmd: string[],
  style: ProcStyle,
  options: ProcLogOptions = {},
): ProcLog {
  if (!logEnabled()) return NOOP_PROC_LOG;

  const id = ++spawnIds;
  const startedAt = performance.now();
  const outDecoder = new TextDecoder("utf-8");
  const errDecoder = new TextDecoder("utf-8");
  const tails = { out: "", err: "" };
  let outBytes = 0;
  let errBytes = 0;
  let childPid: number | null = null;
  const timers: ReturnType<typeof setInterval>[] = [];

  const stopTimers = (): void => {
    for (const timer of timers.splice(0)) clearInterval(timer);
  };

  const base = (): Record<string, unknown> => ({
    spawn: id,
    // Deliberately **not** `pid`: the envelope already carries the app's pid,
    // and envelope fields win, so a `pid` here would be silently overwritten —
    // which is exactly what happened before this field was named explicitly.
    childPid,
    src: options.src,
    item: options.item,
    elapsedMs: Math.round(performance.now() - startedAt),
    bytesOut: outBytes,
    bytesErr: errBytes,
  });

  const spawnFields = (): Record<string, unknown> => ({
    ...base(),
    style,
    cwd: options.cwd ?? null,
    argv: cmd,
    command: clip(cmd.join(" "), 2_048),
  });

  return {
    id,

    spawned(pid?: number): void {
      childPid = typeof pid === "number" ? pid : null;
      log("proc.spawn", spawnFields(), "info");
      if (off || !state) return;

      timers.push(
        setInterval(() => {
          log(
            "proc.heartbeat",
            { ...base(), tail: tailOf(tails.out || tails.err, 160) },
            "info",
          );
        }, envMs("UPDATER_LOG_HEARTBEAT_MS", DEFAULT_HEARTBEAT_MS)),
      );
      timers.push(
        setInterval(() => {
          log(
            "proc.stall",
            {
              ...base(),
              tail: tailOf(tails.out || tails.err, 400),
              note: "child has not exited; it is not being killed",
            },
            "warn",
          );
        }, envMs("UPDATER_LOG_STALL_MS", DEFAULT_STALL_MS)),
      );
      for (const timer of timers) unrefTimer(timer);
    },

    failed(err: unknown): void {
      stopTimers();
      log("proc.spawn.error", { ...spawnFields(), error: err }, "error");
    },

    push(which: "out" | "err", bytes: Uint8Array): void {
      if (which === "out") outBytes += bytes.length;
      else errBytes += bytes.length;
      const text = (which === "out" ? outDecoder : errDecoder).decode(bytes, { stream: true });
      if (!text) return;
      if (which === "out") tails.out = keepTail(tails.out + text, TAIL_BUFFER);
      else tails.err = keepTail(tails.err + text, TAIL_BUFFER);
    },

    exited(
      code: number,
      signal?: string | number | null,
      stdout: string = "",
      stderr: string = "",
    ): void {
      stopTimers();
      const ok = code === 0 && !signal;
      log("proc.exit", { ...base(), code, signal: signal ?? null }, ok ? "info" : "warn");
      // A short tail on success, the real one on failure: that is how "exited 1
      // with no error marker" turns into "exited 1 after `Installing: 95%`".
      const max = ok ? 400 : 4_096;
      log(
        "proc.tail",
        {
          spawn: id,
          src: options.src,
          item: options.item,
          stdoutTail: tailOf(stdout || tails.out, max),
          stderrTail: tailOf(stderr || tails.err, max),
          stdoutChars: stdout.length,
          stderrChars: stderr.length,
        },
        ok ? "info" : "warn",
      );
    },

    dispose(): void {
      stopTimers();
    },
  };
}
