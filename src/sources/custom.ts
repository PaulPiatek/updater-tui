import type {
  Source,
  UpgradeItem,
  UpgradeOptions,
  UpgradeResult,
} from "../types";
import type { ResolvedScript } from "../config";
import { run } from "../proc";
import { log } from "../log";

/** Items produced by this source carry their script in `meta.script`. */
interface ScriptMeta {
  script?: ResolvedScript;
}

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

const quote = (value: string): string => (/\s/.test(value) ? `"${value}"` : value);

/** Builds the argument vector for a script, honouring an interpreter. */
function argvFor(script: ResolvedScript): string[] {
  return script.interpreter
    ? [script.target, script.path, ...script.args]
    : [script.target, ...script.args];
}

/**
 * A source backed by user-defined executables from the config (`scripts`).
 *
 * Each script is a single "run me" entry: unlike npm/winget there is no version
 * to compare, so every configured script is listed. Scripts whose executable is
 * missing are shown greyed out (via `disabled`) so typos are obvious instead of
 * failing at run time.
 */
export function createCustomSource(scripts: ResolvedScript[]): Source {
  // Two scripts can share a display name (the same file name in different
  // directories); disambiguate only those, so the common `custom:<name>` id is
  // left unchanged.
  const nameCounts = new Map<string, number>();
  for (const script of scripts) {
    nameCounts.set(script.name, (nameCounts.get(script.name) ?? 0) + 1);
  }

  return {
    id: "custom",
    title: "Custom scripts",
    runMode: "stream",

    async isAvailable(): Promise<boolean> {
      return scripts.length > 0;
    },

    async list(): Promise<UpgradeItem[]> {
      const items: UpgradeItem[] = [];
      const seen = new Map<string, number>();
      for (const script of scripts) {
        // Both the script and, if configured, its interpreter must exist.
        const exists =
          (await Bun.file(script.path).exists()) &&
          (script.interpreter === undefined ||
            (await Bun.file(script.interpreter).exists()));

        let id = `custom:${script.name}`;
        if ((nameCounts.get(script.name) ?? 1) > 1) {
          const ordinal = (seen.get(script.name) ?? 0) + 1;
          seen.set(script.name, ordinal);
          id = `custom:${script.name}#${ordinal}`;
        }

        items.push({
          id,
          source: "custom",
          name: script.name,
          current: "script",
          latest: "run",
          hint: script.path,
          disabled: !exists,
          meta: { script },
        });
      }
      return items;
    },

    async upgrade(item, runOpts: UpgradeOptions): Promise<UpgradeResult> {
      const script = (item.meta as ScriptMeta | undefined)?.script;
      if (!script) {
        return { item, ok: false, command: item.name, error: "script definition missing" };
      }

      const argv = argvFor(script);
      const command = argv.map(quote).join(" ");

      if (runOpts.dryRun) {
        return { item, ok: true, command: `(in ${script.cwd}) ${command}` };
      }

      // Which of the three ways this script ran (overlay pty, inherited console,
      // captured) decides whether its output can even be seen — and argv is
      // logged verbatim, which is the only record of what a script was given.
      const host = runOpts.hostProcess
        ? "overlay"
        : process.stdin.isTTY === true
          ? "inherit"
          : "capture";
      log("custom.run", {
        src: "custom",
        item: item.id,
        host,
        cwd: script.cwd,
        argv,
        command,
      });

      try {
        // In the TUI the app hosts the process in an overlay and owns the pty;
        // elsewhere (headless, tests) we run it ourselves with the real terminal.
        const code = runOpts.hostProcess
          ? await runOpts.hostProcess(argv, { cwd: script.cwd, title: script.name })
          : (
              await run(argv, {
                cwd: script.cwd,
                // Give the script the real terminal so it can print live and
                // prompt — but only when there is one. Under a pipe (a `--yes`
                // run in CI) capture instead, so a prompt can't block the run.
                inherit: process.stdin.isTTY === true,
              })
            ).code;
        return {
          item,
          ok: code === 0,
          command,
          error: code === 0 ? undefined : `exit code ${code}`,
        };
      } catch (err) {
        log("custom.error", { src: "custom", item: item.id, error: err }, "error");
        return { item, ok: false, command, error: errorMessage(err) };
      }
    },
  };
}
