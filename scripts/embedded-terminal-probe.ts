/**
 * Small probe: can a custom script run on a Bun.Terminal (ConPTY) and have its
 * output rendered live inside an OpenTUI pane via EmbeddedTerminalRenderable,
 * instead of suspend/resume taking over the whole terminal?
 *
 * Also checks whether the renderer delivers keypresses to the focused embedded
 * terminal automatically (the suspected cause of the earlier revert).
 *
 * Manual harness: `bun run scripts/embedded-terminal-probe.ts`
 */
import { createTestRenderer } from "@opentui/core/testing";
import { EmbeddedTerminalRenderable, type KeyEvent } from "@opentui/core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHILD = `
process.stdout.write("READY\\r\\n");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  if (/[\\r\\n]/.test(buf)) {
    process.stdout.write("GOT:" + buf.replace(/[\\r\\n]/g, "") + "\\r\\n");
    setTimeout(() => process.exit(0), 150);
  }
});
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), "etr-probe-"));
  const child = join(dir, "child.js");
  await writeFile(child, CHILD);

  const setup = await createTestRenderer({ width: 40, height: 10 });
  const results: Array<[string, boolean]> = [];

  const sources: string[] = [];
  let term: { write(data: string | Uint8Array): void } | null = null;

  const panel = new EmbeddedTerminalRenderable(setup.renderer, {
    width: 40,
    height: 10,
    cols: 40,
    rows: 10,
    onData: (data, source) => {
      sources.push(source);
      term?.write(data);
    },
  });
  setup.renderer.root.add(panel);

  const proc = Bun.spawn([process.execPath, child], {
    terminal: {
      cols: 40,
      rows: 10,
      data(_t: unknown, d?: Uint8Array) {
        panel.write(d ?? (_t as Uint8Array));
      },
    },
  }) as unknown as { terminal: { write(d: string | Uint8Array): void }; kill(): void };

  term = proc.terminal;

  const frameHas = async (needle: string, ms = 5000): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (setup.captureCharFrame().includes(needle)) return true;
      await sleep(50);
    }
    return false;
  };

  results.push(["child output rendered inside the pane", await frameHas("READY")]);

  // Capture the real KeyEvents the mock sends, and focus the panel.
  const seen: KeyEvent[] = [];
  setup.renderer.keyInput.on("keypress", (k: KeyEvent) => seen.push(k));
  panel.focus();
  await setup.mockInput.typeText("hi");
  setup.mockInput.pressEnter();
  await sleep(300);

  const routed = await frameHas("GOT", 1000);
  results.push(["focused panel received keys automatically", routed]);

  if (!routed && seen.length > 0) {
    for (const key of seen) panel.handleKeyPress(key);
    results.push(["handleKeyPress(key) reaches the pty", await frameHas("GOT", 1000)]);
    await sleep(100);
  }

  console.log("--- captured frame (last) ---");
  console.log(setup.captureCharFrame());
  console.log("--- onData sources:", sources.join(","), "| captured keys:", seen.map((k) => k.name).join(","));
  console.log(panel.screen().text.split("\n").map((l) => `|${l}|`).join("\n"));

  proc.kill();
  setup.renderer.destroy();
  await rm(dir, { recursive: true, force: true });

  console.log("--- results ---");
  for (const [name, ok] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  return results.every(([, ok]) => ok) ? 0 : 1;
}

process.exit(await main());
