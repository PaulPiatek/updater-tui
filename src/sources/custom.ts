import type {
  Source,
  UpgradeItem,
  UpgradeOptions,
  UpgradeResult,
} from "../types";
import type { ResolvedScript } from "../config";
import { run } from "../proc";

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
  return {
    id: "custom",
    title: "Custom scripts",
    runMode: "stream",

    async isAvailable(): Promise<boolean> {
      return scripts.length > 0;
    },

    async list(): Promise<UpgradeItem[]> {
      const items: UpgradeItem[] = [];
      for (const script of scripts) {
        // Both the script and, if configured, its interpreter must exist.
        const exists =
          (await Bun.file(script.path).exists()) &&
          (script.interpreter === undefined ||
            (await Bun.file(script.interpreter).exists()));
        items.push({
          id: `custom:${script.name}`,
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

      try {
        // In the TUI the app hosts the process in an overlay and owns the pty;
        // elsewhere (headless, tests) we run it ourselves with the real terminal.
        const code = runOpts.hostProcess
          ? await runOpts.hostProcess(argv, { cwd: script.cwd, title: script.name })
          : (
              await run(argv, {
                cwd: script.cwd,
                // Scripts get the real terminal so they can print live and prompt.
                inherit: true,
              })
            ).code;
        return {
          item,
          ok: code === 0,
          command,
          error: code === 0 ? undefined : `exit code ${code}`,
        };
      } catch (err) {
        return { item, ok: false, command, error: errorMessage(err) };
      }
    },
  };
}
