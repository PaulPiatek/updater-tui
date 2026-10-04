/**
 * The terminal overlay: runs an interactive child on a ConPTY and renders it
 * live over the app, instead of `renderer.suspend()` handing over the whole
 * terminal.
 *
 * The app owns the overlay and the pty; the caller only supplies the argv and a
 * title. Two-way wiring:
 *
 *   child stdout (pty data)  →  panel.write()
 *   your keys (panel onData) →  pty.write()
 *
 * Keys go to the child, with one exception: `Ctrl+Q` / `Esc` are reserved for
 * the app — they kill the child (while it is still running) and close the
 * overlay. `Ctrl+C` is deliberately *not* reserved; it is forwarded so a script
 * receives the interrupt it expects.
 *
 * The triggering keypress (the Enter that starts an upgrade) is not delivered
 * into the panel: the panel is created and focused on the next tick, after the
 * trigger has been dispatched. See `tests/enter-race.test.ts`.
 */
import {
  BoxRenderable,
  CliRenderEvents,
  EmbeddedTerminalRenderable,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core";
import { colors, truncate } from "./theme";

/** How long the exit status stays on screen before the overlay closes. */
const CLOSE_DELAY_MS = 700;

export interface HostProcessOptions {
  cwd?: string;
  title?: string;
}

export class TerminalOverlay {
  private readonly backdrop: BoxRenderable;
  private readonly frame: BoxRenderable;
  private readonly header: TextRenderable;
  private readonly footer: TextRenderable;
  private panel: EmbeddedTerminalRenderable | null = null;
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private closed = false;
  /** The child's exit code once it has finished (0 until then). */
  exitCode = 0;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly onClose: () => void,
  ) {
    // A full-screen backdrop so the app behind doesn't bleed through, padded to
    // centre the frame.
    this.backdrop = new BoxRenderable(renderer, {
      flexDirection: "column",
      width: "100%",
      height: "100%",
      padding: 1,
    });

    this.frame = new BoxRenderable(renderer, {
      flexDirection: "column",
      width: "100%",
      height: "100%",
      borderStyle: "rounded",
      borderColor: colors.accent,
    });

    this.header = new TextRenderable(renderer, {
      content: "",
      fg: colors.accent,
      wrapMode: "none",
    });
    this.footer = new TextRenderable(renderer, {
      content: "Ctrl+Q / Esc to close",
      fg: colors.dim,
      wrapMode: "none",
    });

    const headerRow = new BoxRenderable(renderer, {
      flexDirection: "row",
      width: "100%",
      height: 1,
      paddingLeft: 1,
      paddingRight: 1,
    });
    headerRow.add(this.header);

    const footerRow = new BoxRenderable(renderer, {
      flexDirection: "row",
      width: "100%",
      height: 1,
      paddingLeft: 1,
      paddingRight: 1,
    });
    footerRow.add(this.footer);

    this.frame.add(headerRow);
    this.frame.add(this.footer);
    this.backdrop.add(this.frame);

    // Keep the child pty at the panel's real size (initial + every resize).
    const sync = (): void => {
      const term = this.proc?.terminal;
      if (this.panel && term && this.panel.width > 0 && this.panel.height > 0) {
        term.resize(this.panel.width, this.panel.height);
      }
    };
    this.frame.on(CliRenderEvents.RESIZE, sync);

    // Reserved keys. Registered on the app's handler (attached before any
    // focused-renderable handler), so preventDefault/stopPropagation prevents
    // the panel from forwarding them to the child.
    renderer.keyInput.on("keypress", this.onKey);
  }

  /** Runs `argv` on a pty, hosted in the overlay. Resolves with the exit code. */
  async run(argv: string[], options: HostProcessOptions = {}): Promise<number> {
    this.header.content = truncate(`● ${options.title ?? argv[0] ?? "process"}`, 60);
    this.renderer.root.add(this.backdrop);
    this.renderer.requestRender();

    // Create the panel + focus *after* the triggering key has been dispatched,
    // so the trigger Enter is not delivered into the child. See the class doc.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (this.closed) return -1;

    this.panel = new EmbeddedTerminalRenderable(this.renderer, {
      flexGrow: 1,
      flexBasis: 0,
      width: "100%",
      // Keys (and terminal query responses) the panel emits go to the child.
      onData: (data) => this.proc?.terminal?.write(data),
      // The panel resizes with the overlay; keep the child pty the same size.
      onTerminalResize: (cols, rows) => this.proc?.terminal?.resize(cols, rows),
    });
    this.frame.add(this.panel);

    const proc = Bun.spawn(argv, {
      cwd: options.cwd,
      terminal: {
        cols: 80,
        rows: 24,
        data: (_terminal: unknown, bytes?: Uint8Array) => {
          const chunk = bytes ?? (_terminal as Uint8Array);
          this.panel?.write(chunk);
        },
      },
    });
    this.proc = proc;

    this.renderer.requestRender();
    setTimeout(() => {
      if (this.closed) return;
      this.panel?.focus();
      const term = this.proc?.terminal;
      if (this.panel && term && this.panel.width > 0) {
        term.resize(this.panel.width, this.panel.height);
      }
    }, 0);

    const code = await proc.exited;
    this.exitCode = code;
    if (!this.closed) {
      try {
        this.footer.content = `exited ${code} · closing…`;
        this.renderer.requestRender();
        await new Promise<void>((resolve) => setTimeout(resolve, CLOSE_DELAY_MS));
      } catch {
        // The app may have been destroyed while the child was exiting.
      }
    }
    this.close();
    return code;
  }

  /**
   * Reserved keys: kill the child (while it is running) and close. Nothing to
   * kill once it has exited — the overlay auto-closes anyway.
   */
  private onKey = (key: KeyEvent): void => {
    if (this.closed) return;
    const reserved = key.name === "escape" || (key.ctrl && key.name === "q");
    if (!reserved) return;
    key.preventDefault();
    key.stopPropagation();
    this.kill();
    this.close();
  };

  private kill(): void {
    if (this.proc && this.proc.exitCode === null) {
      try {
        this.proc.kill();
      } catch {
        // already gone
      }
    }
  }

  /** Tears the overlay down. Safe to call more than once. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.renderer.keyInput.off("keypress", this.onKey);
    this.kill();
    this.panel?.destroyRecursively();
    this.panel = null;
    this.proc = null;
    this.backdrop.destroyRecursively();
    this.renderer.requestRender();
    this.onClose();
  }
}
