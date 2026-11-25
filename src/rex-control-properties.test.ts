/**
 * Property checks of the control connection as a state machine, against the test server.
 *
 * Each run scripts one connection's life: requests whose responses the server releases in a
 * generated order (answers, server errors, or none at all), then a drop at a generated point,
 * then a reconnect. A model predicts every request's outcome from the script alone:
 *
 * - a released response reaches exactly its own request, whatever the order;
 * - a server error becomes the tagged error for its code;
 * - every request still waiting when the connection drops fails with `RexConnectionLost`;
 * - nothing is ever sent twice, and the next request reconnects with the last reconnect token.
 *
 * Events are scripted the same way: subscribers receive every event in `seq` order up to a gap
 * or a drop, and then fail with `RexEventsLost`.
 */
import { Arbitrary, Deferred, Effect, Exit, Fiber, Layer, Queue, Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { rexConfigLayerFromOptions } from "./rex-config.ts";
import { RexControl, rexControlLayerWithoutDependencies } from "./rex-control.ts";
import { checkRexProperty, waitForRexCondition } from "./testing/rex-property.ts";
import {
  rexTestServerError,
  startRexTestServer,
  type IRexTestServer,
  type RexTestServerOptions,
} from "./testing/rex-test-server.ts";

function withControl<A, E>(
  body: (server: IRexTestServer) => Effect.Effect<A, E, RexControl>,
  serverOptions: RexTestServerOptions = {},
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* startRexTestServer(serverOptions);
      const layer = rexControlLayerWithoutDependencies.pipe(
        Layer.provide(
          rexConfigLayerFromOptions({
            server: server.socketPath,
            client: { kind: "agent", name: "rex-sdk-test", version: "0.0.0" },
          }),
        ),
      );
      const result = yield* body(server).pipe(Effect.provide(layer));
      expect(server.violations()).toEqual([]);
      return result;
    }),
  );
}

const failureTags = <A, E extends { readonly _tag: string }>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.map((reason) => (reason._tag === "Fail" ? reason.error._tag : reason._tag))
    : ["Success"];

/** Each documented server error code and the error it must become; any other code is generic. */
const errorTags: Readonly<Record<string, string>> = {
  bad_request: "RexBadRequest",
  not_found: "RexNotFound",
  session_not_found: "RexSessionNotFound",
  method_not_found: "RexMethodNotFound",
  conflict: "RexConflict",
  not_supported: "RexNotSupported",
  refused: "RexRefused",
  client_unavailable: "RexClientUnavailable",
  too_large: "RexTooLarge",
  revision_too_low: "RexRevisionTooLow",
  timeout: "RexServerTimeout",
  internal: "RexServerError",
  some_future_code: "RexServerError",
};

/** What the server does with one request. */
type Plan =
  | { readonly _tag: "Answer" }
  | { readonly _tag: "Error"; readonly code: string }
  | { readonly _tag: "NoAnswer" };

const planArbitrary: Arbitrary.Arbitrary<Plan> = Arbitrary.schema(
  Schema.Union([
    Schema.TaggedStruct("Answer", {}),
    Schema.TaggedStruct("Error", { code: Schema.Literals(Object.keys(errorTags)) }),
    Schema.TaggedStruct("NoAnswer", {}),
  ]),
);

const scriptArbitrary = Arbitrary.all({
  plans: Arbitrary.array(planArbitrary, { minLength: 1, maxLength: 6 }),
  /** Sort keys: requests are released in the order of their keys. */
  order: Arbitrary.array(Arbitrary.schema(Schema.Int), { minLength: 6, maxLength: 6 }),
  /** How many released responses arrive before the drop. */
  releasedBeforeDrop: Arbitrary.schema(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })),
  ),
  /** How the connection ends. */
  drop: Arbitrary.schema(Schema.Literals(["terminate", "close", "malformed"])),
});

const decodeLabel = Schema.decodeUnknownSync(Schema.Struct({ label: Schema.String }));
const indexOfLabel = (payload: unknown) =>
  Number(decodeLabel(payload).label.slice("request-".length));

describe("control connection", () => {
  test(
    "every request gets its own outcome, drops fail the rest as lost, nothing is replayed",
    () =>
      Effect.runPromise(
        checkRexProperty(
          "control requests follow the model",
          scriptArbitrary,
          ({ plans, order, releasedBeforeDrop, drop }) =>
            withControl((server) =>
              Effect.scoped(
                Effect.gen(function* () {
                  const control = yield* RexControl;
                  // Fails once the SDK has seen the connection end: the signal to reconnect.
                  const watcher = yield* control.subscribe;
                  const gates = yield* Effect.forEach(plans, () => Deferred.make<void>());
                  server.handle("session.set_label", (payload) =>
                    Effect.gen(function* () {
                      const index = indexOfLabel(payload);
                      yield* Deferred.await(gates[index] ?? (yield* Deferred.make<void>()));
                      const plan = plans[index];
                      return plan?._tag === "Error"
                        ? rexTestServerError(plan.code)
                        : { revision: index };
                    }),
                  );
                  const fibers = yield* Effect.forEach(plans, (_, index) =>
                    Effect.forkChild(
                      Effect.exit(
                        control.request("session.set_label", {
                          session_id: "session:x",
                          label: `request-${index}`,
                        }),
                      ),
                    ),
                  );
                  yield* waitForRexCondition(
                    "the server received every request",
                    () => server.requestsFor("session.set_label").length === plans.length,
                  );

                  // Release answered requests in the generated order, up to the drop.
                  const releasable = plans
                    .map((plan, index) => ({ plan, index, key: order[index] ?? 0 }))
                    .filter(({ plan }) => plan._tag !== "NoAnswer")
                    .toSorted((left, right) => left.key - right.key || left.index - right.index);
                  const released = releasable.slice(0, releasedBeforeDrop);
                  for (const { plan, index } of released) {
                    const gate = gates[index];
                    const fiber = fibers[index];
                    if (gate === undefined || fiber === undefined) continue;
                    yield* Deferred.succeed(gate, undefined);
                    const exit = yield* Fiber.join(fiber);
                    if (plan._tag === "Answer") {
                      expect(Exit.isSuccess(exit) && exit.value.payload).toEqual({
                        revision: index,
                      });
                    } else if (plan._tag === "Error") {
                      expect(failureTags(exit)).toEqual([errorTags[plan.code]]);
                    }
                  }

                  // End the connection; everything still waiting may have run, and is lost.
                  const connection = server.connections()[0];
                  if (drop === "terminate") connection?.terminate();
                  else if (drop === "close") connection?.close(1001, "going away");
                  else connection?.sendRaw("{not json");
                  const releasedIndexes = new Set(released.map(({ index }) => index));
                  for (const [index, fiber] of fibers.entries()) {
                    if (releasedIndexes.has(index)) continue;
                    expect(failureTags(yield* Fiber.join(fiber))).toEqual(["RexConnectionLost"]);
                  }
                  // Late answers to the lost connection change nothing.
                  for (const gate of gates) yield* Deferred.succeed(gate, undefined);
                  expect(failureTags(yield* Effect.exit(Queue.take(watcher)))).toEqual([
                    "RexEventsLost",
                  ]);

                  server.handle("session.set_label", () => Effect.succeed({ revision: 99 }));
                  const again = yield* control.request("session.set_label", {
                    session_id: "session:x",
                    label: "after",
                  });
                  expect(again.payload).toEqual({ revision: 99 });
                  expect(server.connectionCount()).toBe(2);
                  expect(server.connections().at(-1)?.hello).toMatchObject({
                    reconnect_token: "token-1",
                  });
                  expect((yield* control.connection).generation).toBe(2);
                  // Every request reached the server exactly once.
                  expect(
                    server
                      .requestsFor("session.set_label")
                      .map((request) => decodeLabel(request.payload).label),
                  ).toEqual([...plans.map((_, index) => `request-${index}`), "after"]);
                }),
              ),
            ),
          { runs: 40, runTimeoutMillis: 3000 },
        ),
      ),
    60_000,
  );

  test(
    "subscribers receive events in seq order until a gap or a drop, then fail as lost",
    () =>
      Effect.runPromise(
        checkRexProperty(
          "control events follow the model",
          Arbitrary.all({
            before: Arbitrary.schema(
              Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30 })),
            ),
            subscribers: Arbitrary.schema(
              Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
            ),
            end: Arbitrary.schema(
              Schema.Literals(["gap", "terminate", "close", "malformed", "none"]),
            ),
            unknownMessages: Arbitrary.schema(
              Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
            ),
          }),
          ({ before, subscribers, end, unknownMessages }) =>
            withControl((server) =>
              Effect.scoped(
                Effect.gen(function* () {
                  const control = yield* RexControl;
                  const queues = yield* Effect.forEach(
                    Array.from({ length: subscribers }),
                    () => control.subscribe,
                  );
                  yield* control.connection;
                  const connection = server.connections()[0];
                  for (let index = 0; index < unknownMessages; index += 1) {
                    connection?.sendRaw(JSON.stringify({ type: "future_message", index }));
                  }
                  for (let index = 0; index < before; index += 1) {
                    server.emit({ type: "hosts_changed", payload: { hash: `${index}` } });
                  }
                  if (end === "gap") {
                    connection?.sendRaw(
                      JSON.stringify({
                        type: "event",
                        seq: before + 2,
                        payload: { type: "hosts_changed", payload: { hash: "gap" } },
                      }),
                    );
                  } else if (end === "terminate") connection?.terminate();
                  else if (end === "close") connection?.close(1001, "keepalive timeout");
                  else if (end === "malformed") connection?.sendRaw("[");

                  for (const queue of queues) {
                    const received = yield* Queue.takeN(queue, before);
                    expect(received.map((event) => event.seq)).toEqual(
                      Array.from({ length: before }, (_, index) => index + 1),
                    );
                    if (end === "none") continue;
                    expect(failureTags(yield* Effect.exit(Queue.take(queue)))).toEqual([
                      "RexEventsLost",
                    ]);
                  }
                }),
              ),
            ),
          { runs: 40, runTimeoutMillis: 3000 },
        ),
      ),
    60_000,
  );
});
