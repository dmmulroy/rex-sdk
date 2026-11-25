/**
 * Property checks of data streams and exit waits as state machines, against the test server.
 *
 * - Downloads: the server's side follows a generated script of data, half-closes, text messages,
 *   and closes. A model of the completion rule (`docs/research/rex-data-bytes-v1.md`) predicts the
 *   result and the close code each side ends with.
 * - Terminal streams: output with Rex messages, cut into chunks, with connection drops between
 *   them. Up to three drops, the stream resumes without losing or repeating a byte; a fourth
 *   fails it.
 * - `waitForExit`: unrelated events, dropped events, and one way the wait ends. A model predicts
 *   the result and how many times the SDK reads the process again.
 */
import { Arbitrary, Effect, Exit, Fiber, Option, Schema, Stream } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { BlockId, SessionId } from "./rex-domain.ts";
import { RexSdk } from "./rex-sdk.ts";
import type { RexTerminalStreamItem, RexTerminalStreamMessage } from "./rex-terminal-stream.ts";
import { checkRexProperty, formatValue, waitForRexCondition } from "./testing/rex-property.ts";
import { rexSdkTest } from "./testing/rex-test-runtime.ts";
import {
  rexTestServerError,
  type IRexTestServer,
  type RexTestServerBytesPeer,
} from "./testing/rex-test-server.ts";

const sessionId = SessionId.make("session:01a1aaaa-0000-0000-0000-000000000001");
const otherSessionId = SessionId.make("session:01a1aaaa-0000-0000-0000-000000000002");
const blockId = BlockId.make("block:01a1bbbb-0000-0000-0000-000000000001");
const otherBlockId = BlockId.make("block:01a1bbbb-0000-0000-0000-000000000002");
const target = { sessionId, blockId };
const encoder = new TextEncoder();

const failureTags = <A, E extends { readonly _tag: string }>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.map((reason) => (reason._tag === "Fail" ? reason.error._tag : reason._tag))
    : ["Success"];

function handleAttach(server: IRexTestServer) {
  server.handle("session.attach", () =>
    Effect.succeed({
      client_id: "client:test-1",
      view: { revision: 1, session_id: sessionId, windows: [] },
    }),
  );
}

const decodeRef = Schema.decodeUnknownSync(
  Schema.Struct({ args: Schema.Struct({ ref: Schema.String }) }),
);

const smallInt = (minimum: number, maximum: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })));

const DownloadAction = Schema.Union([
  Schema.TaggedStruct("Data", {
    bytes: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))).check(
      Schema.isBetweenLength(1, 20),
    ),
  }),
  Schema.TaggedStruct("HalfClose", {}),
  Schema.TaggedStruct("Text", {}),
  Schema.TaggedStruct("Close", { code: Schema.Literals([1000, 1001, 1011, 4000, 4002]) }),
]);
type DownloadAction = typeof DownloadAction.Type;

/** What the completion rule says a download script ends with. */
type DownloadOutcome =
  | { readonly _tag: "Success"; readonly bytes: ReadonlyArray<number> }
  | {
      readonly _tag: "Failure";
      readonly error: string;
      /** The client aborts with 4001, unless the script's own close reaches the wire first. */
      readonly clientAborts: boolean;
      /** The script closes after the action that ended the stream. */
      readonly serverClosesLater: boolean;
    };

function downloadModel(
  actions: ReadonlyArray<DownloadAction>,
  maxBytes: number | undefined,
): DownloadOutcome {
  const bytes: Array<number> = [];
  let remoteEnded = false;
  const abort = (error: string, at: number): DownloadOutcome => ({
    _tag: "Failure",
    error,
    clientAborts: true,
    serverClosesLater: actions.slice(at + 1).some((action) => action._tag === "Close"),
  });
  for (const [at, action] of actions.entries()) {
    switch (action._tag) {
      case "Text":
        return abort("RexInvalidResponse", at);
      case "Data":
        if (remoteEnded) return abort("RexInvalidResponse", at);
        bytes.push(...action.bytes);
        if (maxBytes !== undefined && bytes.length > maxBytes)
          return abort("RexTransferTooLarge", at);
        break;
      case "HalfClose":
        if (remoteEnded) return abort("RexInvalidResponse", at);
        remoteEnded = true;
        break;
      case "Close":
        if (action.code === 1000) {
          return remoteEnded
            ? { _tag: "Success", bytes }
            : {
                _tag: "Failure",
                error: "RexTransferIncomplete",
                clientAborts: false,
                serverClosesLater: false,
              };
        }
        return {
          _tag: "Failure",
          error: action.code === 4000 ? "RexBlockClosed" : "RexDataStreamFailed",
          clientAborts: false,
          serverClosesLater: false,
        };
    }
  }
  // Nothing more arrives: the stall timer (or the close timer after a half-close) runs out.
  return abort("RexTransferStalled", actions.length);
}

const playScript =
  (actions: ReadonlyArray<DownloadAction>): RexTestServerBytesPeer =>
  (connection) => {
    for (const action of actions) {
      switch (action._tag) {
        case "Data":
          connection.send(Uint8Array.from(action.bytes));
          break;
        case "HalfClose":
          connection.send(new Uint8Array(0));
          break;
        case "Text":
          connection.sendText("not bytes");
          break;
        case "Close":
          connection.close(action.code, "scripted");
          return;
      }
    }
  };

describe("downloads", () => {
  test(
    "every server script ends as the completion rule predicts, on both sides",
    () =>
      Effect.runPromise(
        checkRexProperty(
          "download follows the completion rule",
          Arbitrary.all({
            actions: Arbitrary.array(Arbitrary.schema(DownloadAction), { maxLength: 8 }),
            maxBytes: Arbitrary.schema(
              Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60 }))),
            ),
          }),
          ({ actions, maxBytes }) =>
            rexSdkTest((server) =>
              Effect.gen(function* () {
                handleAttach(server);
                server.handle("com.superlogical.terminal.download_begin", (payload) =>
                  Effect.sync(() => ({
                    path: "/srv/file",
                    name: "file",
                    size: 0,
                    modified_at: "2026-11-23T06:36:08Z",
                    ticket: server.issueBytesTicket(
                      decodeRef(payload).args.ref,
                      playScript(actions),
                    ),
                    expires_in_ms: 60_000,
                  })),
                );
                const rex = yield* RexSdk;
                const exit = yield* Effect.exit(
                  rex.terminals.readFile(target, "/srv/file", {
                    maxBytes,
                    stallTimeout: "150 millis",
                  }),
                );
                const expected = downloadModel(actions, maxBytes);
                if (expected._tag === "Success") {
                  expect(Exit.isSuccess(exit) && Array.from(exit.value.bytes)).toEqual(
                    expected.bytes,
                  );
                } else {
                  expect(failureTags(exit)).toEqual([expected.error]);
                }
                // The client aborts with 4001 exactly when it, not the server, ended the stream.
                yield* waitForRexCondition(
                  "the stream closed",
                  () => server.bytesStreams().at(-1)?.closed !== undefined,
                );
                const closed = server.bytesStreams().at(-1)?.closed?.code;
                if (expected._tag === "Failure" && expected.clientAborts) {
                  if (!expected.serverClosesLater) expect(closed).toBe(4001);
                } else {
                  expect(closed).not.toBe(4001);
                }
                // A download never sends anything to the server.
                expect(server.bytesStreams().at(-1)?.received).toEqual([]);
              }),
            ),
          { runs: 60, runTimeoutMillis: 5000 },
        ),
      ),
    120_000,
  );
});

/** Every action kind, once each: enough to reach every branch of the completion rule. */
const actionAlphabet: ReadonlyArray<DownloadAction> = [
  { _tag: "Data", bytes: [1, 2] },
  { _tag: "HalfClose" },
  { _tag: "Text" },
  { _tag: "Close", code: 1000 },
  { _tag: "Close", code: 4000 },
  { _tag: "Close", code: 1011 },
];

function scriptsUpTo(length: number): ReadonlyArray<ReadonlyArray<DownloadAction>> {
  if (length === 0) return [[]];
  const shorter = scriptsUpTo(length - 1);
  return [
    ...shorter.filter((script) => script.length < length - 1),
    ...shorter
      .filter((script) => script.length === length - 1)
      .flatMap((script) => actionAlphabet.map((action) => [...script, action])),
  ];
}

describe("every download script", () => {
  const scripts = scriptsUpTo(3);

  test(
    `all ${scripts.length} scripts of up to three actions end as the completion rule predicts`,
    () =>
      Effect.runPromise(
        rexSdkTest((server) =>
          Effect.gen(function* () {
            handleAttach(server);
            let current: ReadonlyArray<DownloadAction> = [];
            server.handle("com.superlogical.terminal.download_begin", (payload) =>
              Effect.sync(() => ({
                path: "/srv/file",
                name: "file",
                size: 0,
                modified_at: "2026-11-23T06:36:08Z",
                ticket: server.issueBytesTicket(decodeRef(payload).args.ref, playScript(current)),
                expires_in_ms: 60_000,
              })),
            );
            const rex = yield* RexSdk;
            for (const script of scripts) {
              current = script;
              const exit = yield* Effect.exit(
                rex.terminals.readFile(target, "/srv/file", {
                  maxBytes: 3,
                  stallTimeout: "40 millis",
                }),
              );
              const expected = downloadModel(script, 3);
              const actual =
                expected._tag === "Success"
                  ? Exit.isSuccess(exit) && Array.from(exit.value.bytes)
                  : failureTags(exit);
              expect(actual, formatValue(script)).toEqual(
                expected._tag === "Success" ? expected.bytes : [expected.error],
              );
            }
            expect(server.bytesStreams().length).toBe(scripts.length);
          }),
        ),
      ),
    120_000,
  );
});

const NONCE = 4242n;

/** A piece of terminal output: plain text, or a Rex message. */
const PieceSchema = Schema.Union([
  Schema.TaggedStruct("Text", { text: Schema.String.check(Schema.isMaxLength(16)) }),
  Schema.TaggedStruct("Exit", {
    code: Schema.Int.check(Schema.isBetween({ minimum: -1, maximum: 255 })),
  }),
]);
type Piece = typeof PieceSchema.Type;

const pieceBytes = (piece: Piece) =>
  encoder.encode(
    piece._tag === "Text"
      ? piece.text.replaceAll("\u001b", "")
      : `\u001b_rex1;${NONCE};${JSON.stringify({ type: "child_exited", exit_code: piece.code })}\u001b\\`,
  );

type Rendered = { readonly output: string } | { readonly message: RexTerminalStreamMessage };

function render(items: ReadonlyArray<RexTerminalStreamItem>): ReadonlyArray<Rendered> {
  const result: Array<Rendered> = [];
  const decoder = new TextDecoder();
  let pending: Array<number> = [];
  const flush = () => {
    if (pending.length > 0) result.push({ output: decoder.decode(Uint8Array.from(pending)) });
    pending = [];
  };
  for (const item of items) {
    if (item._tag === "Output") pending.push(...item.bytes);
    else {
      flush();
      result.push({ message: item.message });
    }
  }
  flush();
  return result;
}

describe("terminal streams", () => {
  test(
    "resume after up to three drops without losing or repeating a byte; a fourth fails",
    () =>
      Effect.runPromise(
        checkRexProperty(
          "terminal stream resumes exactly",
          Arbitrary.all({
            pieces: Arbitrary.array(Arbitrary.schema(PieceSchema), { maxLength: 8 }),
            cuts: Arbitrary.array(smallInt(1, 200), { maxLength: 8 }),
            drops: Arbitrary.array(smallInt(0, 8), { maxLength: 4 }),
          }),
          ({ pieces, cuts, drops }) =>
            rexSdkTest((server) =>
              Effect.gen(function* () {
                handleAttach(server);
                server.serveData({ ...target, nonce: NONCE, chunks: [] });
                const all = pieces.flatMap((piece) => Array.from(pieceBytes(piece)));
                const bounds = [...new Set(cuts.filter((cut) => cut < all.length))].toSorted(
                  (left, right) => left - right,
                );
                const chunks = [0, ...bounds]
                  .map((start, index) => all.slice(start, bounds[index] ?? all.length))
                  .filter((chunk) => chunk.length > 0);
                const rex = yield* RexSdk;
                const items: Array<RexTerminalStreamItem> = [];
                const fiber = yield* Effect.forkChild(
                  Effect.exit(
                    Stream.runForEach(rex.terminals.stream(target), (item) =>
                      Effect.sync(() => void items.push(item)),
                    ),
                  ),
                );
                yield* waitForRexCondition(
                  "the stream opened",
                  () => server.dataHandshakes().length === 1,
                );
                let dropped = 0;
                for (let index = 0; index <= chunks.length; index += 1) {
                  for (const _ of drops.filter((at) => Math.min(at, chunks.length) === index)) {
                    server.terminateData(blockId);
                    dropped += 1;
                    if (dropped > 3) break;
                    yield* waitForRexCondition(
                      "the stream resumed",
                      () => server.dataHandshakes().length === 1 + dropped,
                    );
                  }
                  if (dropped > 3) break;
                  const chunk = chunks[index];
                  if (chunk !== undefined) server.sendData(blockId, Uint8Array.from(chunk));
                }
                if (dropped > 3) {
                  const exit = yield* Fiber.join(fiber);
                  expect(["RexDataStreamFailed", "RexConnectionError"]).toContain(
                    failureTags(exit)[0],
                  );
                  return;
                }
                server.closeData(blockId, 1000, "");
                expect(Exit.isSuccess(yield* Fiber.join(fiber))).toBe(true);
                const expected = render(
                  pieces.map((piece): RexTerminalStreamItem =>
                    piece._tag === "Text"
                      ? { _tag: "Output", bytes: pieceBytes(piece) }
                      : {
                          _tag: "Message",
                          message: { type: "child_exited", exitCode: piece.code },
                        },
                  ),
                );
                expect(render(items), formatValue({ chunks, drops })).toEqual(expected);
                // Every RESUME asked for exactly the bytes after those already received.
                for (const handshake of server.dataHandshakes().slice(1)) {
                  expect(handshake[0]).toBe(0x02);
                  expect(Buffer.from(handshake).readBigUInt64LE(17)).toBeLessThanOrEqual(
                    BigInt(all.length),
                  );
                }
              }),
            ),
          { runs: 60, runTimeoutMillis: 5000 },
        ),
      ),
    120_000,
  );
});

const WaitStep = Schema.Union([
  Schema.TaggedStruct("Noise", {
    kind: Schema.Literals([
      "otherBlockExit",
      "otherCreatorEvent",
      "otherSessionDrop",
      "serverDrop",
      "otherBlockClosed",
      "dropAboutBlockNoChange",
    ]),
  }),
  Schema.TaggedStruct("End", {
    how: Schema.Literals(["exitEvent", "closedEvent", "droppedExit", "droppedClose"]),
  }),
]);

describe("waitForExit", () => {
  test(
    "ends with the exit or the close, rereading the process after each relevant drop",
    () =>
      Effect.runPromise(
        checkRexProperty(
          "waitForExit follows the model",
          Arbitrary.all({
            alreadyExited: Arbitrary.schema(Schema.Boolean),
            exitCode: smallInt(-1, 255),
            steps: Arbitrary.array(Arbitrary.schema(WaitStep), { maxLength: 8 }),
          }),
          ({ alreadyExited, exitCode, steps }) =>
            rexSdkTest((server) =>
              Effect.gen(function* () {
                handleAttach(server);
                let state: "running" | "exited" | "closed" = alreadyExited ? "exited" : "running";
                let reads = 0;
                server.handle("com.superlogical.terminal.process", () =>
                  Effect.sync(() => {
                    reads += 1;
                    if (state === "closed")
                      return rexTestServerError("not_found", "block not found");
                    return { last_exit: state === "exited" ? { exit_code: exitCode } : null };
                  }),
                );
                const rex = yield* RexSdk;
                const fiber = yield* Effect.forkChild(
                  Effect.exit(rex.terminals.waitForExit(target)),
                );
                yield* waitForRexCondition("the first read", () => reads === 1);
                if (alreadyExited) {
                  expect(yield* Fiber.join(fiber)).toEqual(
                    Exit.succeed({ exitCode, error: Option.none() }),
                  );
                  return;
                }
                const blockEvent = (
                  block: string,
                  creator: string,
                  name: string,
                  payload: object,
                ) => ({
                  type: "session_event",
                  payload: {
                    session_id: sessionId,
                    event: {
                      type: "block_event",
                      payload: { block_id: block, creator_name: creator, name, payload },
                    },
                  },
                });
                const dropped = (payload: object) => ({
                  type: "event_dropped",
                  payload: { size: 2_000_000, event_type: "block_event", ...payload },
                });
                let expectedReads = 1;
                let ending: "exit" | "closed" = "exit";
                const end = steps.find((step) => step._tag === "End");
                for (const step of steps) {
                  if (step._tag === "End") break;
                  switch (step.kind) {
                    case "otherBlockExit":
                      server.emit(
                        blockEvent(otherBlockId, "com.superlogical.terminal", "child_exited", {
                          exit_code: 1,
                        }),
                      );
                      break;
                    case "otherCreatorEvent":
                      server.emit(
                        blockEvent(blockId, "com.example.viewer", "child_exited", { exit_code: 1 }),
                      );
                      break;
                    case "otherSessionDrop":
                      server.emit(dropped({ session_id: otherSessionId, block_id: blockId }));
                      break;
                    case "serverDrop":
                      server.emit(dropped({}));
                      break;
                    case "otherBlockClosed":
                      server.emit({
                        type: "session_event",
                        payload: {
                          session_id: sessionId,
                          event: { type: "block_closed", payload: { block_id: otherBlockId } },
                        },
                      });
                      break;
                    case "dropAboutBlockNoChange":
                      server.emit(dropped({ session_id: sessionId, block_id: blockId }));
                      expectedReads += 1;
                      break;
                  }
                  yield* waitForRexCondition(
                    "the SDK reread the process",
                    () => reads === expectedReads,
                  );
                }
                switch (end?.how ?? "exitEvent") {
                  case "exitEvent":
                    server.emit(
                      blockEvent(blockId, "com.superlogical.terminal", "child_exited", {
                        exit_code: exitCode,
                      }),
                    );
                    break;
                  case "closedEvent":
                    ending = "closed";
                    server.emit({
                      type: "session_event",
                      payload: {
                        session_id: sessionId,
                        event: { type: "block_closed", payload: { block_id: blockId } },
                      },
                    });
                    break;
                  case "droppedExit":
                    state = "exited";
                    expectedReads += 1;
                    server.emit(
                      dropped({
                        session_id: sessionId,
                        block_id: blockId,
                        block_event_name: "child_exited",
                      }),
                    );
                    break;
                  case "droppedClose":
                    state = "closed";
                    ending = "closed";
                    expectedReads += 1;
                    server.emit(dropped({ session_id: sessionId, event_type: "block_closed" }));
                    break;
                }
                const exit = yield* Fiber.join(fiber);
                if (ending === "exit") {
                  expect(exit).toEqual(Exit.succeed({ exitCode, error: Option.none() }));
                } else {
                  expect(failureTags(exit)).toEqual(["RexBlockClosed"]);
                }
                expect(reads).toBe(expectedReads);
              }),
            ),
          { runs: 60, runTimeoutMillis: 5000 },
        ),
      ),
    120_000,
  );
});
