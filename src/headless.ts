/**
 * Non-interactive paths: `--json`, `--yes`, `--dry-run`, and any run without a
 * real terminal. These never touch OpenTUI, so they can't hang on a dead stdin
 * and stay usable from scripts and CI.
 */
import type { UpgradeItem, UpgradeResult } from "./types";
import { applyGroup, discover, groupBySource, scan } from "./engine";
import { isLocked, lockedHint } from "./state";

export interface HeadlessOptions {
  cwd?: string;
  sourceFilter?: string[];
  dryRun: boolean;
  /** Upgrade everything without a picker. */
  yes: boolean;
  /** Print items as JSON and exit. */
  json: boolean;
}

const out = (text: string) => process.stdout.write(`${text}\n`);
const err = (text: string) => process.stderr.write(`${text}\n`);

/** Runs the non-interactive flow and returns the exit code. */
export async function runHeadless(opts: HeadlessOptions): Promise<number> {
  let engine;
  try {
    engine = await discover({ cwd: opts.cwd, sourceFilter: opts.sourceFilter });
  } catch (cause) {
    err(cause instanceof Error ? cause.message : String(cause));
    return 1;
  }

  const wanted = engine.sources
    .filter((entry) => entry.available)
    .map((entry) => entry.source.id);

  const { items, ignored, pinned, errors } = await scan(engine, wanted);

  if (opts.json) {
    out(JSON.stringify(items, null, 2));
    for (const failure of errors) err(failure);
    return errors.length > 0 ? 1 : 0;
  }

  for (const failure of errors) err(`error: ${failure}`);

  const upgradable = items.filter((item) => !isLocked(item));
  if (ignored + pinned > 0) {
    out(`(${ignored} ignored · ${pinned} pinned by config)`);
  }

  if (upgradable.length === 0) {
    out(items.length > 0 ? "Nothing to do." : "Nothing to do 🎉");
    return errors.length > 0 ? 1 : 0;
  }

  if (opts.dryRun) {
    const planned: UpgradeResult[] = [];
    for (const group of groupBySource(engine, upgradable)) {
      planned.push(...(await applyGroup(group.source, group.items, true)));
    }
    for (const result of planned) {
      out(`${result.item.name}  (${lockedHint(result.item)})`);
      out(`  $ ${result.command}`);
    }
    out(`Would upgrade ${planned.length} package(s).`);
    return 0;
  }

  if (!opts.yes) {
    // Only reachable when there is no TTY (interactive runs use the TUI).
    out("Interactive selection needs a terminal. Re-run with --yes to upgrade all.");
    return 2;
  }

  let ok = 0;
  let failed = 0;
  let reboot = false;
  const failures: UpgradeItem[] = [];

  for (const group of groupBySource(engine, upgradable)) {
    const results = await applyGroup(group.source, group.items, false);
    for (const result of results) {
      if (result.ok) {
        ok++;
        out(`✔ ${result.item.name}  ${lockedHint(result.item)}`);
      } else {
        failed++;
        failures.push(result.item);
        err(`✖ ${result.item.name}: ${result.error ?? "failed"}`);
      }
      if (result.rebootRequired) reboot = true;
    }
  }

  if (reboot) out("⚠ A restart is required to finish some updates.");
  out(`Done: ${ok} upgraded, ${failed} failed.`);
  return failed > 0 ? 1 : 0;
}
