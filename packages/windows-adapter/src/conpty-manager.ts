import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

import { RuntimeError } from "@sovereign/runtime-core";
import { assertOutputCapacity, BoundedOutputBuffer } from "./output-buffer.js";
import { sanitizedChildEnvironment } from "./process-environment.js";

export type TerminalSessionState = "starting" | "running" | "exited" | "closed" | "failed";

export interface TerminalSessionRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly relativeCwd: string;
  readonly state: TerminalSessionState;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly processId: number | null;
  readonly exitCode: number | null;
  readonly columns: number;
  readonly rows: number;
  readonly output: string;
  readonly outputTruncated: boolean;
  readonly outputStartOffset?: number;
  readonly outputEndOffset?: number;
  readonly error: string | null;
}

interface MutableTerminalSession {
  id: string;
  workspaceId: string;
  relativeCwd: string;
  state: TerminalSessionState;
  createdAt: string;
  completedAt: string | null;
  processId: number | null;
  exitCode: number | null;
  columns: number;
  rows: number;
  output: BoundedOutputBuffer;
  error: string | null;
  child: ChildProcessWithoutNullStreams;
  protocolBuffer: string;
  terminalQueryBuffer: string;
  terminalNegotiated: boolean;
  inputReady: boolean;
  pendingInput: string[];
  inputFlushTimer: NodeJS.Timeout | null;
  closeTimer: NodeJS.Timeout | null;
}

export interface StartTerminalSessionRequest {
  readonly workspaceId: string;
  readonly relativeCwd: string;
  readonly absoluteCwd: string;
  readonly shellPath: string;
  readonly columns: number;
  readonly rows: number;
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function parseInteger(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function terminateProcessTree(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null) {
    return;
  }
  if (process.platform === "win32" && child.pid !== undefined) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      env: sanitizedChildEnvironment(),
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("error", () => child.kill());
    killer.once("close", (exitCode) => {
      if (exitCode !== 0) {
        child.kill();
      }
    });
    return;
  }
  child.kill();
}

function cloneSession(session: MutableTerminalSession): TerminalSessionRecord {
  return {
    id: session.id,
    workspaceId: session.workspaceId,
    relativeCwd: session.relativeCwd,
    state: session.state,
    createdAt: session.createdAt,
    completedAt: session.completedAt,
    processId: session.processId,
    exitCode: session.exitCode,
    columns: session.columns,
    rows: session.rows,
    output: session.output.text(),
    outputTruncated: session.output.truncated(),
    outputStartOffset: session.output.range().startOffset,
    outputEndOffset: session.output.range().endOffset,
    error: session.error,
  };
}

export class ConPtySessionManager {
  readonly #nativeAgentPath: string | null;
  readonly #maxOutputBytes: number;
  readonly #sessions = new Map<string, MutableTerminalSession>();
  #closed = false;

  constructor(nativeAgentPath: string | undefined, maxOutputBytes: number) {
    this.#nativeAgentPath = nativeAgentPath?.trim() || null;
    this.#maxOutputBytes = Math.max(16_384, Math.min(maxOutputBytes, 4_194_304));
    assertOutputCapacity(this.#maxOutputBytes);
  }

  available(): boolean {
    return process.platform === "win32" && this.#nativeAgentPath !== null && existsSync(this.#nativeAgentPath);
  }

  start(request: StartTerminalSessionRequest): TerminalSessionRecord {
    if (this.#closed) {
      throw new RuntimeError("PROCESS_FAILED", "The interactive terminal manager is closed.", 503);
    }
    if (!this.available() || this.#nativeAgentPath === null) {
      throw new RuntimeError(
        "PROCESS_FAILED",
        "The native ConPTY helper is unavailable. Rebuild the desktop application on Windows.",
        503,
      );
    }
    if (!Number.isInteger(request.columns) || request.columns < 20 || request.columns > 500) {
      throw new RuntimeError("INVALID_INPUT", "Terminal columns must be from 20 through 500.", 400);
    }
    if (!Number.isInteger(request.rows) || request.rows < 5 || request.rows > 200) {
      throw new RuntimeError("INVALID_INPUT", "Terminal rows must be from 5 through 200.", 400);
    }

    this.#prune();
    const child = spawn(
      this.#nativeAgentPath,
      [
        "conpty",
        encode(request.shellPath),
        encode(request.absoluteCwd),
        String(request.columns),
        String(request.rows),
      ],
      {
        cwd: request.absoluteCwd,
        env: sanitizedChildEnvironment(),
        windowsHide: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const session: MutableTerminalSession = {
      id: randomUUID(),
      workspaceId: request.workspaceId,
      relativeCwd: request.relativeCwd,
      state: "starting",
      createdAt: new Date().toISOString(),
      completedAt: null,
      processId: null,
      exitCode: null,
      columns: request.columns,
      rows: request.rows,
      output: new BoundedOutputBuffer(this.#maxOutputBytes),
      error: null,
      child,
      protocolBuffer: "",
      terminalQueryBuffer: "",
      terminalNegotiated: false,
      inputReady: false,
      pendingInput: [],
      inputFlushTimer: null,
      closeTimer: null,
    };
    this.#sessions.set(session.id, session);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.#consumeProtocol(session, chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#appendOutput(session, Buffer.from(chunk, "utf8"));
    });
    child.once("error", (error) => {
      session.error = error.message;
      session.state = "failed";
      session.completedAt = new Date().toISOString();
    });
    child.once("close", (exitCode) => {
      if (session.protocolBuffer.length > 0) {
        this.#consumeProtocol(session, "\n");
      }
      session.output.finish();
      if (session.closeTimer !== null) {
        clearTimeout(session.closeTimer);
        session.closeTimer = null;
      }
      if (!["exited", "closed", "failed"].includes(session.state)) {
        session.state = exitCode === 0 ? "exited" : "failed";
      }
      session.exitCode ??= exitCode;
      session.completedAt ??= new Date().toISOString();
    });

    return cloneSession(session);
  }

  list(workspaceId?: string): readonly TerminalSessionRecord[] {
    return [...this.#sessions.values()]
      .filter((session) => workspaceId === undefined || session.workspaceId === workspaceId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((session) => cloneSession(session));
  }

  get(sessionId: string): TerminalSessionRecord | null {
    const session = this.#sessions.get(sessionId);
    return session === undefined ? null : cloneSession(session);
  }

  write(sessionId: string, data: string, appendEnter: boolean): TerminalSessionRecord {
    const session = this.#requireActive(sessionId);
    if (data.length === 0 || data.length > 32_768 || data.includes("\0")) {
      throw new RuntimeError(
        "INVALID_INPUT",
        "Terminal input must contain 1 through 32768 characters and no NUL bytes.",
        400,
      );
    }
    const payload = appendEnter ? `${data}\r` : data;
    if (session.inputReady) {
      this.#writeUserInput(session, payload);
    } else {
      session.pendingInput.push(payload);
    }
    return cloneSession(session);
  }

  resize(sessionId: string, columns: number, rows: number): TerminalSessionRecord {
    const session = this.#requireActive(sessionId);
    if (!Number.isInteger(columns) || columns < 20 || columns > 500) {
      throw new RuntimeError("INVALID_INPUT", "Terminal columns must be from 20 through 500.", 400);
    }
    if (!Number.isInteger(rows) || rows < 5 || rows > 200) {
      throw new RuntimeError("INVALID_INPUT", "Terminal rows must be from 5 through 200.", 400);
    }
    session.columns = columns;
    session.rows = rows;
    session.child.stdin.write(`R\t${columns}\t${rows}\n`, "utf8");
    return cloneSession(session);
  }

  close(sessionId: string): TerminalSessionRecord {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      throw new RuntimeError("RUN_NOT_FOUND", "The requested terminal session was not found.", 404);
    }
    if (["exited", "closed", "failed"].includes(session.state)) {
      return cloneSession(session);
    }
    session.state = "closed";
    session.completedAt = new Date().toISOString();
    session.child.stdin.end();
    terminateProcessTree(session.child);
    return cloneSession(session);
  }

  async shutdown(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    const active = [...this.#sessions.values()].filter(
      (session) => session.state === "starting" || session.state === "running",
    );
    for (const session of active) {
      try {
        this.close(session.id);
      } catch {
        terminateProcessTree(session.child);
      }
    }
    await Promise.allSettled(
      active.map(
        (session) =>
          new Promise<void>((resolve) => {
            if (session.child.exitCode !== null) {
              resolve();
              return;
            }
            const timer = setTimeout(resolve, 2_500);
            session.child.once("close", () => {
              clearTimeout(timer);
              resolve();
            });
          }),
      ),
    );
    for (const session of active) {
      if (session.child.exitCode === null) {
        terminateProcessTree(session.child);
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }

  #requireActive(sessionId: string): MutableTerminalSession {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      throw new RuntimeError("RUN_NOT_FOUND", "The requested terminal session was not found.", 404);
    }
    if (session.state !== "starting" && session.state !== "running") {
      throw new RuntimeError("PROCESS_FAILED", "The terminal session is not active.", 409);
    }
    return session;
  }

  #consumeProtocol(session: MutableTerminalSession, chunk: string): void {
    session.protocolBuffer += chunk;
    while (true) {
      const newline = session.protocolBuffer.indexOf("\n");
      if (newline < 0) {
        break;
      }
      const line = session.protocolBuffer.slice(0, newline).replace(/\r$/u, "");
      session.protocolBuffer = session.protocolBuffer.slice(newline + 1);
      if (line.length === 0) {
        continue;
      }
      const fields = line.split("\t");
      switch (fields[0]) {
        case "READY": {
          session.processId = parseInteger(fields[1]);
          session.state = "running";
          break;
        }
        case "DATA": {
          const encoded = fields[1];
          if (encoded !== undefined) {
            try {
              const data = Buffer.from(encoded, "base64");
              this.#respondToTerminalQueries(session, data.toString("utf8"));
              this.#appendOutput(session, data);
            } catch {
              session.error = "The native terminal returned malformed output.";
            }
          }
          break;
        }
        case "INPUT": {
          const written = parseInteger(fields[1]);
          this.#appendOutput(
            session,
            Buffer.from(`\r\n[conpty input accepted: ${written ?? 0} bytes]\r\n`, "utf8"),
          );
          break;
        }
        case "ERROR": {
          const encoded = fields[1];
          const message = encoded === undefined
            ? "The native terminal reported an error."
            : Buffer.from(encoded, "base64").toString("utf8");
          session.error = message;
          this.#appendOutput(session, Buffer.from(`\r\n[terminal error] ${message}\r\n`, "utf8"));
          if (session.state === "starting") {
            session.state = "failed";
          }
          break;
        }
        case "EXIT": {
          session.exitCode = parseInteger(fields[1]);
          if (session.state !== "closed") {
            session.state = session.exitCode === 0 ? "exited" : "failed";
          }
          session.completedAt = new Date().toISOString();
          break;
        }
      }
    }
  }

  #writeUserInput(session: MutableTerminalSession, payload: string): void {
    session.child.stdin.write(`K\t${encode(payload)}\n`, "utf8");
  }

  #respondToTerminalQueries(session: MutableTerminalSession, text: string): void {
    const previousLength = session.terminalQueryBuffer.length;
    const combined = `${session.terminalQueryBuffer}${text}`;
    const bootstrapReady = combined.includes("SCR_CONPTY_BOOTSTRAP_READY");
    const consoleModeReady =
      combined.includes("\u001b[?9001h") && combined.includes("\u001b[?1004h");
    const responses: string[] = [];
    if (consoleModeReady && !session.terminalNegotiated) {
      session.terminalNegotiated = true;
      responses.push("\u001b[I");
    }
    const queries = [
      { pattern: /\u001b\[5n/gu, response: "\u001b[0n" },
      { pattern: /\u001b\[6n/gu, response: "\u001b[1;1R" },
      { pattern: /\u001b\[\?6n/gu, response: "\u001b[?1;1R" },
      { pattern: /\u001b\[(?:0)?c/gu, response: "\u001b[?1;0c" },
    ] as const;
    for (const query of queries) {
      for (const match of combined.matchAll(query.pattern)) {
        const index = match.index;
        if (index !== undefined && index + match[0].length > previousLength) {
          responses.push(query.response);
        }
      }
    }
    session.terminalQueryBuffer = combined.slice(-32);
    for (const response of responses) {
      session.child.stdin.write(`I\t${encode(response)}\n`, "utf8");
    }

    if (
      (bootstrapReady || session.terminalNegotiated) &&
      !session.inputReady &&
      session.inputFlushTimer === null
    ) {
      session.inputFlushTimer = setTimeout(() => {
        session.inputFlushTimer = null;
        if (session.state !== "starting" && session.state !== "running") {
          session.pendingInput = [];
          return;
        }
        session.inputReady = true;
        const pending = session.pendingInput.splice(0);
        for (const payload of pending) {
          this.#writeUserInput(session, payload);
        }
      }, 100);
    }
  }

  #appendOutput(session: MutableTerminalSession, chunk: Buffer): void {
    if (chunk.byteLength > 0) session.output.append(chunk);
  }

  #prune(): void {
    const completed = [...this.#sessions.values()]
      .filter((session) => ["exited", "closed", "failed"].includes(session.state))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    for (const session of completed.slice(40)) {
      this.#sessions.delete(session.id);
    }
  }
}
