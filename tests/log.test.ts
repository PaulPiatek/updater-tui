/**
 * Guards the diagnostic log (src/log.ts) and its `proc.run` instrumentation.
 *
 * The log is what a future "it didn't come back" report is read from, so the
 * tests pin the properties that make it usable: one valid JSON object per line
 * no matter what a child printed, bounded sizes, level filtering, retention, and
 * — the point of the whole thing — a heartbeat (and its tail) while a child
 * hangs, plus the output tail when one fails.
 *
 * Anything that spawns a real process runs in a fresh Bun process: other test
 * files replace `src/proc` with a mock, and Bun keeps one module registry for
 * the whole run (see tests/proc.test.ts).
 *
 * **Never `rmSync` a path that might be empty.** `rmSync("")` resolves to the
 * current working directory and deletes it recursively — that once wiped this
 * repository. `cleanup()` below refuses any path that is not a fresh
 * `updater-log-*` directory directly inside the temp folder.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  MAX_FIELD_CHARS,
  endLog,
  log,
  logEnabled,
  logPath,
  resetLog,
  setLogFile,
  setLogLevel,
  setLogMode,
  startLog,
} from "../src/log";

const LOG_URL = new URL("../src/log.ts", import.meta.url).href;
const PROC_URL = new URL("../src/proc.ts", import.meta.url).href;

type Entry = Record<string, unknown> & {
  event: string;
  level: string;
  seq: number;
  ts: string;
  mono: number;
  session: string;
  pid: number;
  mode: string;
};

let dir = "";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "updater-log-"));
}

/**
 * Deletes only a directory this file created. The guard is the point: an empty
 * or unexpected path must never reach `rmSync`.
 */
function cleanup(path: string): void {
  if (!path) return;
  const resolved = realpathSync(path);
  const expectedRoot = realpathSync(tmpdir());
  const isOurs =
    dirname(resolved) === expectedRoot && basename(resolved).startsWith("updater-log-");
  if (!isOurs) throw new Error(`refusing to delete ${resolved}`);
  rmSync(resolved, { recursive: true, force: true });
}

/** Parses every line of a log file — a line that is not JSON fails the test. */
function entriesOf(path: string): Entry[] {
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n").filter((line) => line.length > 0);
  return lines.map((line) => JSON.parse(line) as Entry);
}

const currentEntries = (): Entry[] => {
  const file = logPath();
  if (!file) throw new Error("expected a log path");
  return entriesOf(file);
};

const events = (entries: Entry[]): string[] => entries.map((entry) => entry.event);

/** Runs a script in a fresh Bun process with the log pointed at `dir`. */
async function probe(
  script: string,
  env: Record<string, string> = {},
): Promise<void> {
  const child = Bun.spawn([process.execPath, "-e", script, LOG_URL, PROC_URL], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      UPDATER_LOG_DIR: dir,
      UPDATER_LOG_LEVEL: "info",
      ...env,
    },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const code = await child.exited;
  if (code !== 0) throw new Error(`probe failed (${code}): ${stderr}${stdout}`);
}

/** The single log file a probe wrote. */
function probeEntries(): Entry[] {
  const files = readdirSync(dir).filter((name) => name.endsWith(".log"));
  expect(files.length).toBe(1);
  return entriesOf(join(dir, files[0]!));
}

beforeEach(() => {
  dir = tempDir();
  process.env.UPDATER_LOG_DIR = dir;
  delete process.env.UPDATER_LOG_LEVEL;
  delete process.env.UPDATER_LOG_FILE;
  delete process.env.UPDATER_LOG_HEARTBEAT_MS;
  delete process.env.UPDATER_LOG_STALL_MS;
  resetLog();
});

afterEach(() => {
  resetLog();
  delete process.env.UPDATER_LOG_DIR;
  cleanup(dir);
  dir = "";
});

describe("envelope and JSONL integrity", () => {
  test("one JSON object per line, with the fields a reader needs", () => {
    setLogLevel("info");
    setLogMode("headless");
    startLog({ version: "1.2.3" });
    log("test.event", { text: "a\r\nb\nc", src: "store", item: "store:x" });

    const entries = currentEntries();
    const first = entries[0]!;
    expect(first.event).toBe("session.start");
    expect(first.mode).toBe("headless");
    expect(first.pid).toBe(process.pid);
    expect(typeof first.session).toBe("string");
    expect(first.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(typeof first.mono).toBe("number");
    expect(first.file).toBe(logPath()!);
    expect(first.version).toBe("1.2.3");

    const second = entries[1]!;
    // CRLF and bare LF survive a round trip without splitting the line.
    expect(second.text).toBe("a\r\nb\nc");
    expect(second.src).toBe("store");
    expect(second.item).toBe("store:x");
    expect(second.seq).toBe(first.seq + 1);
  });

  test("clips long fields and caps an oversized line", () => {
    setLogLevel("info");
    log("test.long", { big: "x".repeat(MAX_FIELD_CHARS * 2) });

    const [entry] = currentEntries();
    const big = entry!.big as string;
    expect(big.length).toBeLessThan(MAX_FIELD_CHARS + 100);
    expect(big).toContain("more chars");

    // Twenty clipped fields are still more than a line may hold.
    log("test.huge", {
      fields: Array.from({ length: 20 }, () => "y".repeat(MAX_FIELD_CHARS)),
    });
    const entries = currentEntries();
    const huge = entries[entries.length - 1]!;
    expect(huge.event).toBe("test.huge");
    const dropped = huge.data as Record<string, unknown>;
    expect(dropped.dropped).toBe("event too large");
    expect(readFileSync(logPath()!, "utf8").length).toBeLessThan(64 * 1024);
  });

  test("serialises errors and never throws on odd values", () => {
    setLogLevel("info");
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;

    expect(() =>
      log("test.odd", {
        error: new Error("boom"),
        circular,
        missing: undefined,
        nan: Number.NaN,
      }),
    ).not.toThrow();

    const [entry] = currentEntries();
    const error = entry!.error as Record<string, unknown>;
    expect(error.name).toBe("Error");
    expect(error.message).toBe("boom");
    expect(typeof error.stack).toBe("string");
    expect("missing" in entry!).toBe(false);
    expect(entry!.nan).toBe("NaN");
  });

  test("keeps arrays readable even when nested (config script args)", () => {
    setLogLevel("info");
    log("config.load", {
      scripts: [
        { name: "a", path: "a.ps1", interpreter: null, args: ["--flag", "value"] },
      ],
      ids: ["1", "2"],
    });

    const [entry] = currentEntries();
    const scripts = entry!.scripts as Array<Record<string, unknown>>;
    // A depth cap must not turn the interesting part into "[…]": script args are
    // exactly what someone reads the file to see.
    expect(scripts[0]!.args).toEqual(["--flag", "value"]);
    expect(entry!.ids).toEqual(["1", "2"]);
  });
});

describe("levels and file selection", () => {
  test("filters by level", () => {
    setLogLevel("warn");
    log("test.info", {}, "info");
    log("test.warn", {}, "warn");
    expect(events(currentEntries())).toEqual(["test.warn"]);
  });

  test("off writes nothing at all", () => {
    setLogLevel("off");
    log("test.info");
    expect(logEnabled()).toBe(false);
    expect(logPath()).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  test("--log <path> wins over the temp folder and creates its directory", () => {
    const file = join(dir, "nested", "custom.log");
    setLogFile(file);
    setLogLevel("info");
    log("test.custom");
    expect(logPath()).toBe(file);
    expect(events(entriesOf(file))).toEqual(["test.custom"]);
  });

  test("keeps the newest ten files", () => {
    const now = Date.now();
    for (let index = 0; index < 14; index++) {
      const file = join(dir, `updater-2020010${index % 10}-000000-${index}.log`);
      writeFileSync(file, "x");
      const when = new Date(now - (20 - index) * 60_000);
      utimesSync(file, when, when);
    }
    setLogLevel("info");
    log("test.prune");

    const files = readdirSync(dir).filter((name) => name.endsWith(".log"));
    expect(files.length).toBeLessThanOrEqual(10);
    // The oldest synthetic file (index 0) is the one dropped.
    expect(files).not.toContain("updater-20200100-000000-0.log");
  });

  test("session.end records the exit code", () => {
    setLogLevel("info");
    startLog();
    endLog(1, { interactive: false });
    const entries = currentEntries();
    const end = entries[entries.length - 1]!;
    expect(end.event).toBe("session.end");
    expect(end.exitCode).toBe(1);
    expect(end.level).toBe("warn");
  });
});

describe("proc instrumentation (fresh process)", () => {
  /** Writes a child script so the probe needs no nested escaping. */
  function childScript(name: string, source: string): string {
    const file = join(dir, name);
    writeFileSync(file, source);
    return file;
  }

  test("a hang produces heartbeats and a stall, with a tail saying what it was doing", async () => {
    const child = childScript(
      "hang.js",
      "process.stdout.write('Installing: 95%'); setTimeout(() => {}, 400);\n",
    );
    await probe(
      `
      const log = await import(process.argv[1]);
      const { run } = await import(process.argv[2]);
      log.setLogMode("headless");
      log.startLog();
      await run([process.execPath, ${JSON.stringify(child)}]);
      log.endLog(0);
      `,
      { UPDATER_LOG_HEARTBEAT_MS: "40", UPDATER_LOG_STALL_MS: "90" },
    );

    const entries = probeEntries();
    const names = events(entries);
    const spawn = names.indexOf("proc.spawn");
    const firstBeat = names.indexOf("proc.heartbeat");
    const stall = names.indexOf("proc.stall");
    const exit = names.indexOf("proc.exit");

    expect(spawn).toBeGreaterThanOrEqual(0);
    expect(firstBeat).toBeGreaterThan(spawn);
    expect(stall).toBeGreaterThan(spawn);
    expect(exit).toBeGreaterThan(stall);

    // The heartbeat carries what the child was mid-way through printing, which
    // is the whole difference between "stuck" and "stuck at Installing: 95%".
    const watched = entries
      .filter((entry) => entry.event === "proc.heartbeat" || entry.event === "proc.stall")
      .map((entry) => String(entry.tail ?? ""));
    expect(watched.some((tail) => tail.includes("Installing: 95%"))).toBe(true);
    expect(Number(entries[stall]!.elapsedMs)).toBeGreaterThan(0);
    expect(entries[stall]!.level).toBe("warn");
  });

  test("a failing child keeps its output tail, CRLF and all", async () => {
    const child = childScript(
      "fail.js",
      "process.stdout.write('Downloading: 5%\\r\\nInstalling: 95%\\r\\n'); process.exit(1);\n",
    );
    await probe(`
      const log = await import(process.argv[1]);
      const { run } = await import(process.argv[2]);
      log.setLogMode("headless");
      log.startLog();
      const result = await run([process.execPath, ${JSON.stringify(child)}, "marker-arg"]);
      log.endLog(result.code);
    `);

    const entries = probeEntries();
    const byEvent = (name: string) => entries.filter((entry) => entry.event === name);
    const spawn = byEvent("proc.spawn")[0]!;
    const exit = byEvent("proc.exit")[0]!;
    const tail = byEvent("proc.tail")[0]!;

    expect(spawn.style).toBe("node-children");
    expect(spawn.argv).toContain("marker-arg");
    // The child's pid needs its own field: `pid` is the envelope's (the app's),
    // and envelope keys win, so a `pid` in the event would be dropped.
    expect(typeof spawn.childPid).toBe("number");
    expect(Number(spawn.childPid)).toBeGreaterThan(0);
    expect(spawn.childPid).not.toBe(spawn.pid);
    expect(exit.code).toBe(1);
    expect(exit.level).toBe("warn");
    expect(String(tail.stdoutTail)).toContain("Installing: 95%");
    expect(tail.level).toBe("warn");
    // Every line still parses as JSON despite CRLF in the child's output.
    expect(events(entries)).toContain("session.end");
  });

  test("a spawn failure is logged instead of being silent", async () => {
    await probe(`
      const log = await import(process.argv[1]);
      const { run } = await import(process.argv[2]);
      log.setLogMode("headless");
      log.startLog();
      try {
        await run(["definitely-not-a-real-program-xyz"]);
      } catch {}
      log.endLog(1);
    `);

    const entries = probeEntries();
    const failure = entries.find((entry) => entry.event === "proc.spawn.error");
    expect(failure).toBeDefined();
    expect(failure!.level).toBe("error");
    expect(events(entries)).not.toContain("proc.exit");
  });
});
