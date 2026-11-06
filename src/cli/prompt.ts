import readline from "node:readline";

/**
 * Interactive prompts for `setup` and `hash-password`.
 *
 * - Ctrl+C or end-of-input during any prompt rejects with CancelledError, and
 *   the terminal is always returned to normal (cooked, echoing) mode.
 * - Hidden input is only used on a real terminal. If it isn't available we
 *   refuse (HiddenInputUnavailableError) instead of silently echoing a secret.
 */

export class CancelledError extends Error {
  readonly code = "CANCELLED";
  constructor(message = "Cancelled.") {
    super(message);
    this.name = "CancelledError";
  }
}

export class HiddenInputUnavailableError extends Error {
  readonly code = "HIDDEN_INPUT_UNAVAILABLE";
  constructor() {
    super("Hidden input isn't available because this is not an interactive terminal, so the passphrase would be visible.");
    this.name = "HiddenInputUnavailableError";
  }
}

export interface Choice<T extends string> {
  value: T;
  label: string;
}

export interface Prompter {
  /** Print a line for the user (stderr for the terminal prompter). */
  out(message?: string): void;
  ask(question: string, opts?: { default?: string }): Promise<string>;
  confirm(question: string, defaultYes: boolean): Promise<boolean>;
  choose<T extends string>(question: string, choices: Array<Choice<T>>, defaultValue: T): Promise<T>;
  /** Read a secret without echoing it. Throws HiddenInputUnavailableError when that's impossible. */
  secret(question: string): Promise<string>;
  close(): void;
}

type In = NodeJS.ReadStream;
type Out = NodeJS.WritableStream;

export function parseYesNo(answer: string, defaultYes: boolean): boolean | undefined {
  const a = answer.trim().toLowerCase();
  if (!a) return defaultYes;
  if (["y", "yes"].includes(a)) return true;
  if (["n", "no"].includes(a)) return false;
  return undefined;
}

export function parseChoice<T extends string>(answer: string, choices: Array<Choice<T>>, defaultValue: T): T | undefined {
  const a = answer.trim();
  if (!a) return defaultValue;
  const n = Number(a);
  if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1]!.value;
  return choices.find((c) => c.value === a.toLowerCase())?.value;
}

/**
 * Read one line without echo from a TTY in raw mode. Handles Backspace,
 * Ctrl+C (cancel), Ctrl+D on an empty line (cancel), and ignores escape
 * sequences such as arrow keys. Always restores the previous raw-mode state.
 */
export function readHidden(question: string, input: In, output: Out): Promise<string> {
  if (!input.isTTY || typeof input.setRawMode !== "function") return Promise.reject(new HiddenInputUnavailableError());
  return new Promise((resolve, reject) => {
    const wasRaw = Boolean(input.isRaw);
    let buf = "";
    let done = false;
    const restore = () => {
      try {
        input.setRawMode(wasRaw);
      } catch {
        /* stream already closed */
      }
    };
    const finish = (err: Error | null, value?: string) => {
      if (done) return;
      done = true;
      input.removeListener("data", onData);
      process.removeListener("exit", restore);
      restore();
      input.pause();
      output.write("\n");
      buf = "";
      if (err) reject(err);
      else resolve(value!);
    };
    const onData = (chunk: Buffer | string) => {
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (s.startsWith("\u001b")) return; // arrow keys and other escape sequences
      for (const ch of s) {
        if (ch === "\u0003") return finish(new CancelledError());
        if (ch === "\u0004") {
          if (!buf) return finish(new CancelledError());
          continue;
        }
        if (ch === "\r" || ch === "\n") return finish(null, buf);
        if (ch === "\u007f" || ch === "\b") {
          buf = Array.from(buf).slice(0, -1).join("");
          continue;
        }
        if (ch < " ") continue;
        buf += ch;
      }
    };
    output.write(question);
    process.once("exit", restore); // never leave the terminal in raw mode
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

export function createTerminalPrompter(input: In = process.stdin, output: Out = process.stderr): Prompter {
  let rl: readline.Interface | undefined;
  const getRl = () => {
    if (!rl) {
      rl = readline.createInterface({ input, output, terminal: Boolean(input.isTTY) });
    }
    return rl;
  };
  const closeRl = () => {
    rl?.close();
    rl = undefined;
  };

  const ask = (question: string, opts: { default?: string } = {}) =>
    new Promise<string>((resolve, reject) => {
      const r = getRl();
      let answered = false;
      const onClose = () => {
        if (!answered) {
          rl = undefined;
          reject(new CancelledError());
        }
      };
      const onSigint = () => {
        answered = true;
        cleanup();
        output.write("\n");
        closeRl();
        reject(new CancelledError());
      };
      const cleanup = () => {
        r.removeListener("close", onClose);
        r.removeListener("SIGINT", onSigint);
      };
      r.once("close", onClose);
      r.once("SIGINT", onSigint);
      const suffix = opts.default !== undefined && opts.default !== "" ? ` [${opts.default}]` : "";
      r.question(`${question}${suffix} `, (answer) => {
        answered = true;
        cleanup();
        resolve(answer === "" && opts.default !== undefined ? opts.default : answer);
      });
    });

  return {
    out: (m = "") => output.write(`${m}\n`),
    ask,
    async confirm(question, defaultYes) {
      for (;;) {
        const v = parseYesNo(await ask(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"}`), defaultYes);
        if (v !== undefined) return v;
        output.write("Please answer y or n.\n");
      }
    },
    async choose(question, choices, defaultValue) {
      output.write(`${question}\n`);
      choices.forEach((c, i) => output.write(`  ${i + 1}) ${c.label}${c.value === defaultValue ? " (default)" : ""}\n`));
      for (;;) {
        const v = parseChoice(await ask("Choose a number:"), choices, defaultValue);
        if (v !== undefined) return v;
        output.write(`Please enter a number from 1 to ${choices.length}.\n`);
      }
    },
    async secret(question) {
      closeRl(); // readline must not also consume the raw keystrokes
      return readHidden(question, input, output);
    },
    close: closeRl,
  };
}
