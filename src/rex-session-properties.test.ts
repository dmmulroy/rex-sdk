/**
 * Property checks of session attachment and `watchView` as state machines, against the test
 * server, each with a model that predicts every request the SDK sends.
 *
 * Attachment: session-scoped calls (alone or concurrently), explicit attaches and detaches,
 * attaches the server refuses, and dropped connections that the server does or doesn't resume.
 * The model keeps the set of sessions the current client is attached to; the SDK must send
 * exactly one `session.attach` for a session outside that set before using it, and none inside.
 *
 * `watchView`: view changes, changes to other sessions, stale revisions, and dropped events. The
 * model predicts which events make the SDK read the view again and which views it emits.
 */
import { Arbitrary, Deferred, Effect, Exit, Fiber, Queue, Schema, Stream } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { RexControl } from "./rex-control.ts";
import { SessionId } from "./rex-domain.ts";
import { RexSdk } from "./rex-sdk.ts";
import { checkRexProperty, waitForRexCondition } from "./testing/rex-property.ts";
import { rexSdkTest } from "./testing/rex-test-runtime.ts";
import { rexTestServerError, type IRexTestServer } from "./testing/rex-test-server.ts";

const sessionIds = [
  SessionId.make("session:01a1aaaa-0000-0000-0000-000000000001"),
  SessionId.make("session:01a1aaaa-0000-0000-0000-000000000002"),
  SessionId.make("session:01a1aaaa-0000-0000-0000-000000000003"),
] as const;
const sessionOf = (index: number) => sessionIds[index % sessionIds.length] ?? sessionIds[0];

const failureTags = <A, E extends { readonly _tag: string }>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.map((reason) => (reason._tag === "Fail" ? reason.error._tag : reason._tag))
    : ["Success"];

const decodeSession = Schema.decodeUnknownSync(Schema.Struct({ session_id: Schema.String }));
const view = (revision: number, sessionId: string) => ({
  revision,
  session_id: sessionId,
  windows: [],
});

const session = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 }));
const Command = Schema.Union([
  Schema.TaggedStruct("Call", { session }),
  Schema.TaggedStruct("Calls", { sessions: Schema.Array(session).check(Schema.isMaxLength(5)) }),
  Schema.TaggedStruct("Attach", { session }),
  Schema.TaggedStruct("Detach", { session }),
  Schema.TaggedStruct("RefuseNextAttach", { session }),
  Schema.TaggedStruct("Drop", {}),
]);
type Command = typeof Command.Type;

/** One request the server saw, as the model predicts it. */
interface Sent {
  readonly method: string;
  readonly session: string;
  readonly connection: number;
}

const sentKey = (sent: Sent) => `${sent.connection} ${sent.method} ${sent.session}`;

/** Waits until the SDK has seen its connection end, so the next call reconnects. */
const dropConnection = (server: IRexTestServer) =>
  Effect.scoped(
    Effect.gen(function* () {
      const control = yield* RexControl;
      const watcher = yield* control.subscribe;
      server.connections()[0]?.terminate();
      expect(failureTags(yield* Effect.exit(Queue.take(watcher)))).toEqual(["RexEventsLost"]);
    }),
  );

describe("automatic attachment", () => {
  test(
    "attaches exactly once per session per client, before first use, as the model predicts",
    () =>
      Effect.runPromise(
        checkRexProperty(
          "attachment follows the model",
          Arbitrary.all({
            commands: Arbitrary.array(Arbitrary.schema(Command), { maxLength: 14 }),
            resume: Arbitrary.schema(Schema.Boolean),
          }),
          ({ commands, resume }) =>
            rexSdkTest(
              (server) =>
                Effect.gen(function* () {
                  const rex = yield* RexSdk;
                  // The server's own record of attaches to refuse, apart from the model's.
                  const serverRefuses = new Set<string>();
                  const refused = new Set<string>();
                  server.handle("session.attach", (payload) =>
                    Effect.sync(() => {
                      const sessionId = decodeSession(payload).session_id;
                      if (serverRefuses.delete(sessionId))
                        return rexTestServerError("session_not_found");
                      return { client_id: "client:test-1", view: view(1, sessionId) };
                    }),
                  );
                  server.handle("session.view", (payload) =>
                    Effect.sync(() => view(1, decodeSession(payload).session_id)),
                  );
                  server.handle("session.detach", () => Effect.succeed({}));

                  // The model: who the current client is attached to, and which connection is open.
                  let attached = new Set<string>();
                  let connection = 0;
                  let open = false;
                  const connect = () => {
                    if (open) return;
                    connection += 1;
                    open = true;
                  };

                  for (const command of commands) {
                    const seen = server.requests().length;
                    const predicted: Array<Sent> = [];
                    switch (command._tag) {
                      case "Call":
                      case "Calls": {
                        const targets =
                          command._tag === "Call" ? [command.session] : [...command.sessions];
                        if (targets.length === 0) break;
                        connect();
                        const exits = yield* Effect.forEach(
                          targets,
                          (index) =>
                            Effect.exit(rex.sessions.view({ sessionId: sessionOf(index) })),
                          { concurrency: "unbounded" },
                        );
                        // Sessions this call attaches to, and those whose attach is refused once.
                        const refusedNow = new Set<string>();
                        for (const id of new Set(targets.map(sessionOf))) {
                          if (attached.has(id)) continue;
                          predicted.push({ method: "session.attach", session: id, connection });
                          if (refused.delete(id)) refusedNow.add(id);
                          else attached.add(id);
                        }
                        targets.forEach((index, position) => {
                          const id = sessionOf(index);
                          const exit = exits[position];
                          if (exit === undefined) return;
                          if (attached.has(id)) {
                            expect(Exit.isSuccess(exit)).toBe(true);
                            predicted.push({ method: "session.view", session: id, connection });
                          } else {
                            expect(failureTags(exit)).toEqual(["RexSessionNotFound"]);
                          }
                        });
                        expect(refusedNow.size === 0 || exits.some(Exit.isFailure)).toBe(true);
                        break;
                      }
                      case "Attach": {
                        connect();
                        const id = sessionOf(command.session);
                        const exit = yield* Effect.exit(rex.sessions.attach({ sessionId: id }));
                        predicted.push({ method: "session.attach", session: id, connection });
                        if (refused.delete(id)) {
                          expect(failureTags(exit)).toEqual(["RexSessionNotFound"]);
                        } else {
                          expect(Exit.isSuccess(exit)).toBe(true);
                          attached.add(id);
                        }
                        break;
                      }
                      case "Detach": {
                        connect();
                        const id = sessionOf(command.session);
                        yield* rex.sessions.detach({ sessionId: id });
                        predicted.push({ method: "session.detach", session: id, connection });
                        attached.delete(id);
                        break;
                      }
                      case "RefuseNextAttach":
                        refused.add(sessionOf(command.session));
                        serverRefuses.add(sessionOf(command.session));
                        break;
                      case "Drop":
                        if (!open) break;
                        yield* dropConnection(server);
                        open = false;
                        if (!resume) attached = new Set();
                        break;
                    }
                    const actual = server
                      .requests()
                      .slice(seen)
                      .map((request) => ({
                        method: request.method,
                        session: decodeSession(request.payload).session_id,
                        connection: request.connectionId,
                      }));
                    // Concurrent calls may reach the server in any order, but each attach comes
                    // before every call that needs it.
                    expect(actual.map(sentKey).toSorted()).toEqual(
                      predicted.map(sentKey).toSorted(),
                    );
                    for (const [position, sent] of actual.entries()) {
                      if (sent.method !== "session.view") continue;
                      const attach = actual.findIndex(
                        (other) =>
                          other.method === "session.attach" && other.session === sent.session,
                      );
                      expect(attach === -1 || attach < position).toBe(true);
                    }
                  }
                }),
              { server: { resumeClients: resume } },
            ),
          { runs: 40, runTimeoutMillis: 5000 },
        ),
      ),
    120_000,
  );
});

const WatchStep = Schema.Union([
  /** The view changes on the server, and the server says so with this revision. */
  Schema.TaggedStruct("Change", {
    notify: Schema.Literals(["viewChanged", "dropped", "none"]),
  }),
  /** An event that must not make the SDK read the view. */
  Schema.TaggedStruct("Noise", {
    kind: Schema.Literals(["otherSession", "staleRevision", "serverDrop", "otherSessionDrop"]),
  }),
  /** A dropped event about the session while nothing changed. */
  Schema.TaggedStruct("DroppedUnchanged", {}),
]);

describe("watchView", () => {
  test(
    "emits the first view, then exactly the newer views the model predicts, until destroyed",
    () =>
      Effect.runPromise(
        checkRexProperty(
          "watchView follows the model",
          Arbitrary.array(Arbitrary.schema(WatchStep), { maxLength: 12 }),
          (steps) =>
            rexSdkTest((server) =>
              Effect.gen(function* () {
                const rex = yield* RexSdk;
                const sessionId = sessionOf(0);
                const other = sessionOf(1);
                server.handle("session.attach", (payload) =>
                  Effect.sync(() => ({
                    client_id: "client:test-1",
                    view: view(1, decodeSession(payload).session_id),
                  })),
                );
                let revision = 1;
                const reads: Array<number> = [];
                server.handle("session.view", () =>
                  Effect.sync(() => {
                    reads.push(revision);
                    return view(revision, sessionId);
                  }),
                );
                const emitted: Array<number> = [];
                const ready = yield* Deferred.make<void>();
                const fiber = yield* Effect.forkChild(
                  Stream.runForEach(rex.sessions.watchView(sessionId), (current) =>
                    Effect.gen(function* () {
                      emitted.push(current.revision);
                      yield* Deferred.succeed(ready, undefined);
                    }),
                  ),
                );
                yield* Deferred.await(ready);

                // The model: the newest view the SDK has emitted, and the reads it must make.
                let current = 1;
                const expectedEmits = [1];
                let expectedReads = 1;
                const sessionEvent = (id: string, type: string, payload: object) => ({
                  type: "session_event",
                  payload: { session_id: id, event: { type, payload } },
                });
                const dropped = (id: string | undefined) => ({
                  type: "event_dropped",
                  payload: {
                    event_type: "session_view_changed",
                    size: 2_000_000,
                    ...(id === undefined ? {} : { session_id: id }),
                  },
                });
                for (const step of steps) {
                  if (step._tag === "Change") {
                    revision += 1;
                    if (step.notify === "viewChanged") {
                      server.emit(sessionEvent(sessionId, "session_view_changed", { revision }));
                    } else if (step.notify === "dropped") {
                      server.emit(dropped(sessionId));
                    }
                    if (step.notify !== "none") {
                      expectedReads += 1;
                      if (revision > current) {
                        current = revision;
                        expectedEmits.push(revision);
                      }
                    }
                  } else if (step._tag === "DroppedUnchanged") {
                    server.emit(dropped(sessionId));
                    expectedReads += 1;
                    if (revision > current) {
                      current = revision;
                      expectedEmits.push(revision);
                    }
                  } else if (step.kind === "otherSession") {
                    server.emit(
                      sessionEvent(other, "session_view_changed", { revision: revision + 10 }),
                    );
                  } else if (step.kind === "staleRevision") {
                    server.emit(
                      sessionEvent(sessionId, "session_view_changed", { revision: current }),
                    );
                  } else if (step.kind === "serverDrop") {
                    server.emit(dropped(undefined));
                  } else {
                    server.emit(dropped(other));
                  }
                  // Step only once the SDK has made the reads this step calls for.
                  yield* waitForRexCondition(
                    "the SDK read the view",
                    () => reads.length >= expectedReads,
                  );
                  yield* waitForRexCondition(
                    "the SDK emitted the view",
                    () => emitted.length >= expectedEmits.length,
                  );
                }
                server.emit({ type: "session_destroyed", payload: { session_id: sessionId } });
                yield* Fiber.join(fiber);
                expect(emitted).toEqual(expectedEmits);
                expect(reads.length).toBe(expectedReads);
              }),
            ),
          { runs: 40, runTimeoutMillis: 5000 },
        ),
      ),
    120_000,
  );
});
