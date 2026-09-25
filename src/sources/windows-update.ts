import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Source, UpgradeItem, UpgradeOptions, UpgradeResult } from "../types";
import { run } from "../proc";

const POWERSHELL = Bun.which("pwsh") ?? Bun.which("powershell") ?? "powershell.exe";

/** Wraps a value in a PowerShell single-quoted string literal. */
const psLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`;

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * Lists pending software updates via the Windows Update Agent COM API. Runs
 * unelevated; installing the updates later requires elevation.
 */
const LIST_SCRIPT = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$session = New-Object -ComObject Microsoft.Update.Session
$searcher = $session.CreateUpdateSearcher()
$result = $searcher.Search("IsInstalled=0 and IsHidden=0 and Type='Software'")
foreach ($u in $result.Updates) {
  [pscustomobject]@{
    UpdateID = $u.Identity.UpdateID
    Title = $u.Title
    KB = ($u.KBArticleIDs -join ',')
    Severity = $u.MsrcSeverity
    SizeMB = [math]::Round($u.MaxDownloadSize / 1MB, 1)
    Downloaded = $u.IsDownloaded
    RebootBehavior = $u.InstallationBehavior.RebootBehavior
  } | ConvertTo-Json -Compress -Depth 4
}`;

interface WuRecord {
  UpdateID?: unknown;
  Title?: unknown;
  KB?: unknown;
  Severity?: unknown;
  SizeMB?: unknown;
}

interface WuInstallRecord {
  UpdateID?: string;
  Title?: string | null;
  ResultCode?: number;
  RebootRequired?: boolean;
  HResult?: number;
  Message?: string | null;
}

/** Human-readable size; empty string when unknown. */
export function formatSize(sizeMB: number): string {
  if (!Number.isFinite(sizeMB) || sizeMB <= 0) return "";
  return sizeMB >= 1024 ? `${(sizeMB / 1024).toFixed(1)} GB` : `${Math.round(sizeMB)} MB`;
}

const stripBom = (text: string): string => text.replace(/^\uFEFF/, "");

/**
 * Parses the JSON-lines emitted by `LIST_SCRIPT` into upgrade items. Exported
 * for unit testing.
 */
export function parseWindowsUpdates(stdout: string): UpgradeItem[] {
  const text = stripBom(stdout).trim();
  if (!text) return [];

  const records: WuRecord[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (Array.isArray(parsed)) records.push(...(parsed as WuRecord[]));
      else if (parsed && typeof parsed === "object") records.push(parsed as WuRecord);
    } catch {
      // Ignore anything that isn't JSON (stray warnings from PowerShell).
    }
  }

  const items: UpgradeItem[] = [];
  for (const record of records) {
    const updateId = typeof record.UpdateID === "string" ? record.UpdateID.trim() : "";
    if (!updateId) continue;

    const kb = String(record.KB ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

    const sizeMB = Number(record.SizeMB);
    const hintParts = kb.map((value) => `KB${value}`);
    const size = formatSize(sizeMB);
    if (size) hintParts.push(size);

    const title =
      typeof record.Title === "string" && record.Title.trim() ? record.Title.trim() : updateId;

    items.push({
      id: `windows-update:${updateId}`,
      source: "windows-update",
      name: title,
      current: "not installed",
      latest: kb[0] ? `KB${kb[0]}` : "update",
      hint: hintParts.join(" · ") || undefined,
      meta: {
        updateId,
        kb,
        severity: record.Severity ?? undefined,
        sizeMB: Number.isFinite(sizeMB) ? sizeMB : undefined,
      },
    });
  }

  return items;
}

/** Parses the result JSON written by the elevated install script. */
export function parseInstallResults(text: string): WuInstallRecord[] {
  const clean = stripBom(text).trim();
  if (!clean) return [];
  try {
    const parsed = JSON.parse(clean) as unknown;
    if (Array.isArray(parsed)) return parsed as WuInstallRecord[];
    if (parsed && typeof parsed === "object") return [parsed as WuInstallRecord];
  } catch {
    // Fall through to empty.
  }
  return [];
}

/** PowerShell that installs the given update ids and writes JSON results. */
export function buildInstallScript(updateIds: string[], resultPath: string): string {
  const ids = updateIds.map(psLiteral).join(", ");
  return `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ids = @(${ids})
$out = ${psLiteral(resultPath)}
$session = New-Object -ComObject Microsoft.Update.Session
$searcher = $session.CreateUpdateSearcher()
$searchResult = $searcher.Search("IsInstalled=0 and IsHidden=0 and Type='Software'")
$results = @()
foreach ($id in $ids) {
  try {
    $update = @($searchResult.Updates | Where-Object { $_.Identity.UpdateID -eq $id })[0]
    if (-not $update) {
      $results += [pscustomobject]@{ UpdateID = $id; Title = $null; ResultCode = -1; RebootRequired = $false; HResult = 0; Message = 'Update is no longer available' }
      continue
    }
    $coll = New-Object -ComObject Microsoft.Update.UpdateColl
    $coll.Add($update) | Out-Null
    if (-not $update.IsDownloaded) {
      $downloader = $session.CreateUpdateDownloader()
      $downloader.Updates = $coll
      $downloader.Download() | Out-Null
    }
    $installer = $session.CreateUpdateInstaller()
    $installer.Updates = $coll
    $install = $installer.Install()
    $results += [pscustomobject]@{ UpdateID = $id; Title = $update.Title; ResultCode = $install.ResultCode; RebootRequired = [bool]$install.RebootRequired; HResult = $install.HResult; Message = $null }
  } catch {
    $results += [pscustomobject]@{ UpdateID = $id; Title = $null; ResultCode = -1; RebootRequired = $false; HResult = 0; Message = $_.Exception.Message }
  }
}
$json = $results | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($out, $json, (New-Object System.Text.UTF8Encoding($false)))`;
}

function describeBatch(items: UpgradeItem[]): string {
  const labels = items.map((item) => {
    const kb = (item.meta?.kb as string[] | undefined) ?? [];
    return kb.length ? kb.map((value) => `KB${value}`).join(" / ") : item.latest;
  });
  return `Install ${items.length} Windows update(s) (elevated): ${labels.join(", ")}`;
}

/** Downloads + installs the given items in one elevated process (one UAC prompt). */
async function runBatch(
  items: UpgradeItem[],
  opts: UpgradeOptions,
): Promise<UpgradeResult[]> {
  const command = describeBatch(items);

  if (opts.dryRun) {
    return items.map((item) => ({ item, ok: true, command }));
  }

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const scriptPath = join(tmpdir(), `updater-wu-${stamp}.ps1`);
  const resultPath = join(tmpdir(), `updater-wu-${stamp}.json`);
  const ids = items
    .map((item) => String(item.meta?.updateId ?? ""))
    .filter((id) => id.length > 0);

  try {
    await Bun.write(scriptPath, buildInstallScript(ids, resultPath));

    const launch =
      `$ErrorActionPreference = 'Stop'; ` +
      `Start-Process -FilePath ${psLiteral(POWERSHELL)} -Verb RunAs -Wait ` +
      `-ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',${psLiteral(scriptPath)}`;

    const res = await run([
      POWERSHELL,
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      launch,
    ]);

    if (res.code !== 0) {
      throw new Error(res.stderr.trim() || `elevation failed (exit code ${res.code})`);
    }

    const resultFile = Bun.file(resultPath);
    const records = (await resultFile.exists())
      ? parseInstallResults(await resultFile.text())
      : [];

    return items.map((item): UpgradeResult => {
      const updateId = String(item.meta?.updateId ?? "");
      const record = records.find((candidate) => candidate.UpdateID === updateId);
      if (!record) {
        return {
          item,
          ok: false,
          command,
          error: "No result returned (the update may no longer be applicable)",
        };
      }

      const code = Number(record.ResultCode);
      const ok = code === 2 || code === 3;
      return {
        item,
        ok,
        command,
        rebootRequired: Boolean(record.RebootRequired),
        error: ok ? undefined : record.Message || `install result code ${code}`,
        output: record.Message ?? undefined,
      };
    });
  } catch (err) {
    return items.map((item) => ({ item, ok: false, command, error: errorMessage(err) }));
  } finally {
    await rm(scriptPath, { force: true }).catch(() => {});
    await rm(resultPath, { force: true }).catch(() => {});
  }
}

/** Upgrades Windows updates via the Windows Update Agent COM API. */
export const windowsUpdateSource: Source = {
  id: "windows-update",
  title: "Windows Update",

  async isAvailable(): Promise<boolean> {
    if (process.platform !== "win32") return false;
    return Bun.which("powershell") !== null || Bun.which("pwsh") !== null;
  },

  async list(): Promise<UpgradeItem[]> {
    const res = await run([
      POWERSHELL,
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      LIST_SCRIPT,
    ]);

    if (res.code !== 0) {
      throw new Error(res.stderr.trim() || `Windows Update search failed (exit ${res.code})`);
    }
    return parseWindowsUpdates(res.stdout);
  },

  upgrade(item, opts) {
    return runBatch([item], opts).then((results) => results[0]!);
  },

  upgradeBatch(items, opts) {
    return runBatch(items, opts);
  },
};
