#!/usr/bin/env bun
/**
 * PROTOTYPE — run an interactive child process on a ConPTY and render it live
 * *inside* an OpenTUI pane, instead of `renderer.suspend()` handing the whole
 * terminal over.
 *
 * This is a standalone experiment, not wired into the app. The point is to feel
 * the behaviour: output streams in a panel, your keystrokes reach the child
 * (prompts work), and the app frame stays up around it.
 *
 * Usage:
 *   bun run scripts/tui-terminal-prototype.ts
 *   bun run scripts/tui-terminal-prototype.ts -- pwsh -NoLogo
 *   bun run scripts/tui-terminal-prototype.ts -- pwsh -File "C:\Users\Paul\.config\updater\msys-update.ps1"
 *
 * Keys: everything goes to the child, except Ctrl+Q which closes the prototype.
 */
import {
  BoxRenderable,
  EmbeddedTerminalRenderable,
  RGBA,
  TextRenderable,
  createCliRenderer,
} from "@opentui/core";

const args = Bun.argv.slice(2);
if (args[0] === "--help" || args[0] === "-h") {
  console.log(`Usage: bun run scripts/tui-terminal-prototype.ts [--] [command...]

Runs an interactive command on a ConPTY and renders it inside an OpenTUI pane.
With no command, launches your default shell. Ctrl+Q closes the prototype.`);
  process.exit(0);
}

const argv = args[0] === "--" ? args.slice(1) : args;
const pwsh = Bun.which("pwsh");
const command =
  argv.length > 0
    ? argv
    : pwsh
      ? [pwsh, "-NoLogo"]
      : [process.env.ComSpec ?? "cmd.exe"];

const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  useMouse: true,
  // Don't let the renderer treat Ctrl+C as a process signal — it is a keystroke
  // meant for the child.
  exitSignals: [],
});

const root = new BoxRenderable(renderer, {
  flexDirection: "column",
  width: "100%",
  height: "100%",
});

const header = new BoxRenderable(renderer, {
  flexDirection: "row",
  width: "100%",
  paddingLeft: 1,
  paddingRight: 1,
});
header.add(
  new TextRenderable(renderer, {
    content: `▸ ${command.join(" ")}`,
    fg: RGBA.fromIndex(14),
  }),
);

const panelBox = new BoxRenderable(renderer, {
  flexDirection: "column",
  flexGrow: 1,
  flexBasis: 0,
  borderStyle: "rounded",
  borderColor: RGBA.fromIndex(8),
  title: " Running (embedded terminal) ",
  titleAlignment: "left",
});

const status = new TextRenderable(renderer, {
  content: "starting…",
  fg: RGBA.fromIndex(8),
});

let term: { write(data: string | Uint8Array): void; resize(cols: number, rows: number): void } | null =
  null;

const panel = new EmbeddedTerminalRenderable(renderer, {
  flexGrow: 1,
  flexBasis: 0,
  width: "100%",
  height: "100%",
  cols: 80,
  rows: 24,
  // Keys (and terminal query responses) typed into the panel go to the child.
  onData: (data) => term?.write(data),
  // The panel resizes with the app; keep the child pty the same size.
  onTerminalResize: (cols, rows) => term?.resize(cols, rows),
});

panelBox.add(panel);
root.add(header);
root.add(panelBox);
root.add(status);
renderer.root.add(root);

const proc = Bun.spawn(command, {
  terminal: {
    cols: 80,
    rows: 24,
    data(_t: unknown, d?: Uint8Array) {
      panel.write(d ?? (_t as Uint8Array));
    },
  },
});

term = proc.terminal ?? null;
if (!term) {
  renderer.destroy();
  console.error("✖ Failed to create a PTY for the child.");
  process.exit(1);
}

status.content = "running · all keys go to the process · Ctrl+Q to close";

void proc.exited.then((code) => {
  status.content = `process exited (${code}) · Ctrl+Q to close`;
});

// Focus after the first layout pass so the panel has its real size, and nudge
// the child's pty to that size (the panel also does this via onTerminalResize).
setTimeout(() => {
  panel.focus();
  if (term) term.resize(panel.width, panel.height);
}, 100);

let quitting = false;
const quit = (): void => {
  if (quitting) return;
  quitting = true;
  try {
    proc.kill();
  } catch {
    // already gone
  }
  renderer.destroy();
  process.exit(0);
};

renderer.keyInput.on("keypress", (key) => {
  if (key.ctrl && key.name === "q") {
    // Consume it so the child never sees the Ctrl+Q.
    key.preventDefault();
    key.stopPropagation();
    quit();
  }
});
