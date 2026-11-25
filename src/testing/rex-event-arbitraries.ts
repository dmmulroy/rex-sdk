/**
 * Generators of control event frames as the server sends them: every server event, session event,
 * and block event in the event reference, plus event types the SDK doesn't know, with payloads
 * from their schemas. Sessions and blocks come from small pools, so generated events often name
 * the same session or block, as a real stream does.
 *
 * @since 0.1.0
 */
import { Arbitrary, Schema } from "effect";
import type { RexControlEvent } from "../rex-control.ts";
import { rexWireArbitrary, rexWireContract } from "./rex-wire-contract.ts";

/** Sessions generated events name. */
export const rexTestSessionIds = [
  "session:01a1aaaa-0000-0000-0000-000000000001",
  "session:01a1aaaa-0000-0000-0000-000000000002",
  "session:01a1aaaa-0000-0000-0000-000000000003",
] as const;

/** Blocks generated events name. */
export const rexTestBlockIds = [
  "block:01a1bbbb-0000-0000-0000-000000000001",
  "block:01a1bbbb-0000-0000-0000-000000000002",
] as const;

function pick<const A extends ReadonlyArray<string>>(values: A): Arbitrary.Arbitrary<A[number]> {
  return Arbitrary.schema(Schema.Literals(values));
}

function isJsonObject(
  value: Schema.Json | undefined,
): value is { readonly [key: string]: Schema.Json } {
  return (
    value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)
  );
}

/** Replaces the session and block IDs a payload names with ones from the pools. */
function fromPools(payload: Schema.Json, sessionId: string, blockId: string): Schema.Json {
  if (!isJsonObject(payload)) return payload;
  return Object.fromEntries(
    Object.entries(payload).map(([key, value]) => {
      if (key === "session_id" && typeof value === "string") return [key, sessionId];
      if (key === "block_id" && typeof value === "string") return [key, blockId];
      return [key, value];
    }),
  );
}

function oneOf<A>(choices: ReadonlyArray<Arbitrary.Arbitrary<A>>): Arbitrary.Arbitrary<A> {
  const [first] = choices;
  if (first === undefined) throw new Error("oneOf needs a choice");
  return Arbitrary.schema(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: choices.length - 1 })),
  ).pipe(Arbitrary.flatMap((index) => choices[index] ?? first));
}

/** An event frame's type and payload, before the connection gives it a `seq`. */
export interface RexTestEventBody {
  readonly type: string;
  readonly payload: Schema.Json;
}

let cached: Arbitrary.Arbitrary<RexTestEventBody> | undefined;

/**
 * Any event the server can send, with sessions and blocks from the pools.
 *
 * @category constructors
 * @since 0.1.0
 */
export function rexEventBodyArbitrary(): Arbitrary.Arbitrary<RexTestEventBody> {
  if (cached !== undefined) return cached;
  const contract = rexWireContract();
  const ids = Arbitrary.all([pick(rexTestSessionIds), pick(rexTestBlockIds)]);
  const server = Object.entries(contract.serverEvents).map(([type, schema]) =>
    Arbitrary.all([
      rexWireArbitrary(`event:${type}`, schema, {
        side: "result",
        definitions: contract.eventDefinitions,
      }),
      ids,
    ]).pipe(
      Arbitrary.map(([payload, [sessionId, blockId]]) => ({
        type,
        payload: fromPools(payload, sessionId, blockId),
      })),
    ),
  );
  const session = Object.entries(contract.sessionEvents)
    .filter(([type]) => type !== "block_event")
    .map(([type, schema]) =>
      Arbitrary.all([
        rexWireArbitrary(`event:${type}`, schema, {
          side: "result",
          definitions: contract.eventDefinitions,
        }),
        ids,
      ]).pipe(
        Arbitrary.map(([payload, [sessionId, blockId]]) => ({
          type: "session_event",
          payload: {
            session_id: sessionId,
            event: { type, payload: fromPools(payload, sessionId, blockId) },
          },
        })),
      ),
    );
  const block = contract.blockEvents.map((event) =>
    Arbitrary.all([
      rexWireArbitrary(`block-event:${event.creator}/${event.name}`, event.payload, {
        side: "result",
      }),
      ids,
    ]).pipe(
      Arbitrary.map(([payload, [sessionId, blockId]]) => ({
        type: "session_event",
        payload: {
          session_id: sessionId,
          event: {
            type: "block_event",
            payload: { block_id: blockId, creator_name: event.creator, name: event.name, payload },
          },
        },
      })),
    ),
  );
  const unknown = Arbitrary.all([
    pick(["future_server_event", "brand_new"]),
    pick(rexTestSessionIds),
    Arbitrary.schema(Schema.Boolean),
  ]).pipe(
    Arbitrary.map(([type, sessionId, inSession]) =>
      inSession
        ? {
            type: "session_event",
            payload: { session_id: sessionId, event: { type, payload: { x: 1 } } },
          }
        : { type, payload: { x: 1 } },
    ),
  );
  // Each family is chosen equally often, so rare server events don't crowd out session ones.
  cached = oneOf([oneOf(server), oneOf(session), oneOf(block), unknown]);
  return cached;
}

/**
 * A control event frame, as `RexControl` hands it to subscribers.
 *
 * @category constructors
 * @since 0.1.0
 */
export function rexControlEventOf(body: RexTestEventBody, seq: number): RexControlEvent {
  return { generation: 1, seq, type: body.type, payload: body.payload };
}
