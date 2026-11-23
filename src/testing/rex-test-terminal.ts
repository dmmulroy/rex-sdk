/**
 * A scripted terminal block on {@link IRexTestServer}: its text, its output stream, typing, and
 * its program's exit, kept consistent with each other the way Rex keeps them.
 *
 * - `format` and `blob_read` read one snapshot of the text, in parts when `max_bytes` asks, with
 *   byte offsets and `total` as Rex reports them.
 * - The data stream starts with a snapshot and a `resize` message, then carries what the program
 *   prints and a `child_exited` message when it exits.
 * - `write` echoes typed text, as a shell does: it appears in the text and on the stream.
 *
 * @since 0.1.0
 */
import { Effect, Schema } from "effect";
import {
  rexTestServerError,
  type IRexTestServer,
  type RexTestServerHandler,
} from "./rex-test-server.ts";

/** The test terminal's controls. */
export interface RexTestTerminal {
  /** The whole output, as `format` returns it with `trim` and `unwrap`. */
  readonly content: () => string;
  /** The program prints `text`: it is added to the output and sent on the stream. */
  readonly print: (text: string) => void;
  /** Replaces the output without sending stream bytes, as when scrollback is trimmed. */
  readonly replace: (content: string) => void;
  /** The program exits with `exitCode`. */
  readonly exit: (exitCode: number) => void;
  /** How many `format` requests were answered. */
  readonly reads: () => number;
}

/** Options for {@link startRexTestTerminal}. */
export interface RexTestTerminalOptions {
  /** The output already there; defaults to a shell prompt. */
  readonly content?: string | undefined;
  /** The exit code of a program that exited before the test started. */
  readonly exitedWith?: number | undefined;
  /** Whether `write` echoes typed text; defaults to true. */
  readonly echo?: boolean | undefined;
}

const NONCE = 7_777_777n;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const rexMessage = (json: object) =>
  encoder.encode(`\u001b_rex1;${NONCE};${JSON.stringify(json)}\u001b\\`);

const FormatArgs = Schema.Struct({
  args: Schema.Struct({ max_bytes: Schema.optionalKey(Schema.Number) }),
});
const BlobReadArgs = Schema.Struct({
  args: Schema.Struct({
    id: Schema.Number,
    offset: Schema.optionalKey(Schema.Number),
    max_bytes: Schema.optionalKey(Schema.Number),
  }),
});
const WriteArgs = Schema.Struct({ args: Schema.Struct({ data: Schema.String }) });
const SessionArgs = Schema.Struct({ session_id: Schema.String });

/** The end of `bytes` at or before `end` that doesn't split a UTF-8 character. */
function characterBoundary(bytes: Uint8Array, end: number): number {
  let boundary = Math.min(end, bytes.length);
  while (boundary > 0 && boundary < bytes.length && ((bytes[boundary] ?? 0) & 0xc0) === 0x80) {
    boundary -= 1;
  }
  return boundary;
}

interface TerminalState {
  content: string;
  exitCode: number | undefined;
  reads: number;
  readonly echo: boolean;
  readonly blobs: Map<number, Uint8Array>;
}

const BlockArgs = Schema.Struct({ block_id: Schema.String });

/** The terminals served on each test server, by block ID. */
const terminalsByServer = new WeakMap<IRexTestServer, Map<string, TerminalState>>();

/** Installs the handlers that route terminal methods to the block they name. */
function terminalsOf(server: IRexTestServer): Map<string, TerminalState> {
  const existing = terminalsByServer.get(server);
  if (existing !== undefined) return existing;
  const terminals = new Map<string, TerminalState>();
  terminalsByServer.set(server, terminals);
  let nextBlob = 1;

  const route =
    (
      handler: (state: TerminalState, payload: unknown, blockId: string) => Schema.Json,
    ): RexTestServerHandler =>
    (payload) =>
      Effect.sync(() => {
        const blockId = Schema.decodeUnknownSync(BlockArgs)(payload).block_id;
        const state = terminals.get(blockId);
        return state === undefined
          ? rexTestServerError("not_found", `no terminal ${blockId}`)
          : handler(state, payload, blockId);
      });

  server.handle("session.attach", (payload) =>
    Effect.sync(() => ({
      client_id: "client:01a1dddd-0000-0000-0000-000000000001",
      view: {
        revision: 1,
        session_id: Schema.decodeUnknownSync(SessionArgs)(payload).session_id,
        windows: [],
      },
    })),
  );
  server.handle(
    "com.superlogical.terminal.format",
    route((state, payload) => {
      state.reads += 1;
      const maxBytes = Schema.decodeUnknownSync(FormatArgs)(payload).args.max_bytes ?? 0;
      const bytes = encoder.encode(state.content);
      if (maxBytes === 0) return { content: state.content };
      if (bytes.length <= maxBytes)
        return { content: state.content, total: bytes.length, eof: true };
      const id = nextBlob++;
      state.blobs.set(id, bytes);
      const first = characterBoundary(bytes, maxBytes);
      return {
        content: decoder.decode(bytes.subarray(0, first)),
        id,
        total: bytes.length,
        eof: false,
      };
    }),
  );
  server.handle(
    "com.superlogical.terminal.blob_read",
    route((state, payload) => {
      const { id, offset = 0, max_bytes } = Schema.decodeUnknownSync(BlobReadArgs)(payload).args;
      const bytes = state.blobs.get(id) ?? new Uint8Array(0);
      const end = characterBoundary(bytes, offset + (max_bytes ?? bytes.length));
      return {
        id,
        data: decoder.decode(bytes.subarray(Math.min(offset, end), end)),
        total: bytes.length,
        eof: end >= bytes.length,
      };
    }),
  );
  server.handle(
    "com.superlogical.terminal.write",
    route((state, payload, blockId) => {
      const data = Schema.decodeUnknownSync(WriteArgs)(payload).args.data;
      if (state.echo) {
        const echoed = data.replaceAll("\r", "\n");
        state.content += echoed;
        server.sendData(blockId, encoder.encode(echoed));
      }
      return { bytes_written: encoder.encode(data).length };
    }),
  );
  server.handle(
    "com.superlogical.terminal.process",
    route((state) => ({
      last_exit: state.exitCode === undefined ? null : { exit_code: state.exitCode },
    })),
  );
  return terminals;
}

/**
 * Serves a terminal block on the test server, and session attaches. Several terminals can share
 * one server: terminal methods go to the block they name, and fail with `not_found` for others.
 *
 * @category constructors
 * @since 0.1.0
 */
export function startRexTestTerminal(
  server: IRexTestServer,
  target: { readonly sessionId: string; readonly blockId: string },
  options: RexTestTerminalOptions = {},
): RexTestTerminal {
  const state: TerminalState = {
    content: options.content ?? "user@host ~\n$ ",
    exitCode: options.exitedWith,
    reads: 0,
    echo: options.echo ?? true,
    blobs: new Map(),
  };
  terminalsOf(server).set(target.blockId, state);
  server.serveData({
    sessionId: target.sessionId,
    blockId: target.blockId,
    nonce: NONCE,
    chunks: [
      encoder.encode(`snapshot of ${target.blockId}`),
      rexMessage({ type: "resize", cols: 80, rows: 24 }),
    ],
  });

  return {
    content: () => state.content,
    print: (text) => {
      state.content += text;
      server.sendData(target.blockId, encoder.encode(text));
    },
    replace: (next) => {
      state.content = next;
    },
    exit: (code) => {
      state.exitCode = code;
      server.sendData(target.blockId, rexMessage({ type: "child_exited", exit_code: code }));
    },
    reads: () => state.reads,
  };
}
