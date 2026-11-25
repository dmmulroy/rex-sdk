/**
 * Property checks of the generated wire codecs against the server's own contract.
 *
 * Every server method, block method, and event is checked in both directions, with values
 * generated two independent ways: from the SDK's codecs (what callers can send) and from the
 * server's JSON Schemas (what the server can send or accept). ajv, compiled from the same server
 * schemas, is the judge of what the server accepts. See `src/testing/rex-wire-contract.ts` for the
 * few facts the generators add to the server's schemas.
 *
 * Decoding is checked for what a client must tolerate as well: unknown enum values and unknown
 * fields from a newer server, and IDs that break the contract, which must fail as
 * `RexInvalidResponse` rather than reach callers.
 */
import { Arbitrary, Effect, Exit, Option, Result, Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";
import {
  RexServerEventFrame,
  rexBlockMethods,
  rexServerEvents,
  rexSessionEvents,
  rexWireMethods,
} from "./generated/rex-wire-schemas.ts";
import type { RexControlEvent } from "./rex-control.ts";
import { decodeRexEvent, REX_TERMINAL_CREATOR, rexEventSessionId } from "./rex-events.ts";
import { checkRexProperty, assertRexProperty, formatValue } from "./testing/rex-property.ts";
import {
  rexBlockRequestSchema,
  rexEventViolation,
  rexFutureField,
  rexWireArbitrary,
  rexWireContract,
  rexWireViolation,
  type RexJsonSchemaObject,
} from "./testing/rex-wire-contract.ts";

const contract = rexWireContract();
const decodeJson = Schema.decodeUnknownSync(Schema.Json);

/** What crosses the wire: the value after a JSON round trip. */
const overTheWire = (value: unknown): Schema.Json =>
  decodeJson(JSON.parse(JSON.stringify(value) ?? "null"));

/**
 * Whether `sent` survives JSON unchanged as `received`. Unlike `toEqual`, 0 and -0 are the same,
 * as JSON can't tell them apart; NaN and the infinities are lost, because JSON turns them into
 * `null`.
 */
function sameOverTheWire(sent: unknown, received: Schema.Json): boolean {
  if (typeof sent === "number") return typeof received === "number" && sent === received;
  if (Array.isArray(sent)) {
    return (
      Array.isArray(received) &&
      sent.length === received.length &&
      sent.every((item, index) => {
        const other = received[index];
        return other !== undefined && sameOverTheWire(item, other);
      })
    );
  }
  if (sent !== null && typeof sent === "object") {
    if (!isJsonObject(received)) return false;
    const entries = Object.entries(sent).filter(([, value]) => value !== undefined);
    return (
      entries.length === Object.keys(received).length &&
      entries.every(([key, value]) => {
        const other = received[key];
        return other !== undefined && sameOverTheWire(value, other);
      })
    );
  }
  return sent === received;
}

/** Codecs of one method side, without their precise types, for checks shared by every method. */
interface WireCodecs {
  readonly request: Schema.Codec<unknown, unknown>;
  readonly result: Schema.Codec<unknown, unknown>;
}

function serverCodecs(method: string): WireCodecs | undefined {
  if (!Object.hasOwn(rexWireMethods, method)) return undefined;
  for (const [name, codecs] of Object.entries(rexWireMethods)) {
    if (name === method) return { request: codecs.input, result: codecs.result };
  }
  return undefined;
}

function blockCodecs(method: string): WireCodecs | undefined {
  for (const [name, codecs] of Object.entries(rexBlockMethods)) {
    if (name === method) return { request: codecs.args, result: codecs.result };
  }
  return undefined;
}

const decodeWith = (schema: Schema.Codec<unknown, unknown>, value: unknown) =>
  Effect.runSyncExit(Schema.decodeUnknownEffect(schema)(value));
const encodeWith = (schema: Schema.Codec<unknown, unknown>, value: unknown) =>
  Effect.runSyncExit(Schema.encodeUnknownEffect(schema)(value));

function expectSuccess<A, E>(exit: Exit.Exit<A, E>, context: string): A {
  if (Exit.isSuccess(exit)) return exit.value;
  throw new Error(`${context}: ${String(exit.cause)}`);
}

function isJsonObject(
  value: Schema.Json | undefined,
): value is { readonly [key: string]: Schema.Json } {
  return (
    value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)
  );
}

/** Removes the field a newer server might add from every object in `value`. */
function withoutFutureFields(value: Schema.Json): Schema.Json {
  if (Array.isArray(value)) return value.map(withoutFutureFields);
  if (!isJsonObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== rexFutureField)
      .map(([key, child]) => [key, withoutFutureFields(child)]),
  );
}

const idField = /(^|_)(session|window|block|split|layer|client)_id$|^anchor_id$/;

/**
 * Paths to the required ID fields of a result schema, through objects and arrays. A result with
 * `null` or a malformed ID at one of them breaks the contract.
 */
function requiredIdPaths(schema: Schema.Json): ReadonlyArray<ReadonlyArray<string>> {
  // A recursive (anchored) node is left out: forcing a path through it would force it forever.
  if (!isJsonObject(schema) || schema["$anchor"] !== undefined) return [];
  const paths: Array<ReadonlyArray<string>> = [];
  const properties = schema["properties"];
  const required = schema["required"];
  if (isJsonObject(properties)) {
    const requiredKeys = new Set(
      Array.isArray(required) ? required.filter((key) => typeof key === "string") : [],
    );
    for (const [key, child] of Object.entries(properties)) {
      if (requiredKeys.has(key) && idField.test(key)) paths.push([key]);
      for (const inner of requiredIdPaths(child)) paths.push([key, ...inner]);
    }
  }
  const items = schema["items"];
  if (items !== undefined) {
    for (const inner of requiredIdPaths(items)) paths.push(["[]", ...inner]);
  }
  return paths;
}

/** Replaces the value at every place `path` reaches in `value`; reports whether any was found. */
function replaceAt(
  value: Schema.Json,
  path: ReadonlyArray<string>,
  replacement: Schema.Json,
): { readonly value: Schema.Json; readonly found: boolean } {
  const [head, ...rest] = path;
  if (head === undefined) return { value: replacement, found: true };
  if (head === "[]") {
    if (!Array.isArray(value)) return { value, found: false };
    const replaced = value.map((item) => replaceAt(item, rest, replacement));
    return {
      value: replaced.map((item) => item.value),
      found: replaced.some((item) => item.found),
    };
  }
  if (!isJsonObject(value) || !Object.hasOwn(value, head)) return { value, found: false };
  const child = value[head];
  if (child === undefined) return { value, found: false };
  const inner = replaceAt(child, rest, replacement);
  return { value: withFields(value, { [head]: inner.value }), found: inner.found };
}

/** A copy of a JSON object with `fields` set. */
function withFields(
  object: { readonly [key: string]: Schema.Json },
  fields: { readonly [key: string]: Schema.Json },
): { readonly [key: string]: Schema.Json } {
  return Object.fromEntries([...Object.entries(object), ...Object.entries(fields)]);
}

/**
 * A copy of `schema` in which every value on `path` is present: each object field on it is
 * required and not null, and each array on it has an item. Values generated from it always have
 * an ID at the end of `path`, which plain generation reaches only by chance.
 */
function forcePath(schema: Schema.Json, path: ReadonlyArray<string>): Schema.Json {
  const [head, ...rest] = path;
  if (head === undefined || !isJsonObject(schema)) return schema;
  const withoutNull = (node: Schema.Json): Schema.Json => {
    if (!isJsonObject(node)) return node;
    const type = node["type"];
    return Array.isArray(type)
      ? withFields(node, { type: type.filter((member) => member !== "null") })
      : node;
  };
  if (head === "[]") {
    const items = schema["items"];
    if (items === undefined) return schema;
    return withFields(schema, { minItems: 1, items: withoutNull(forcePath(items, rest)) });
  }
  const properties = schema["properties"];
  if (!isJsonObject(properties)) return schema;
  const child = properties[head];
  if (child === undefined) return schema;
  const required = Array.isArray(schema["required"]) ? schema["required"] : [];
  return withFields(schema, {
    required: required.includes(head) ? required : [...required, head],
    properties: withFields(properties, { [head]: withoutNull(forcePath(child, rest)) }),
  });
}

const brokenIds = Arbitrary.schema(
  Schema.Union([Schema.Null, Schema.Literals(["", "not-an-id", "window:", "unknown:1"])]),
);

/** Generated results with a null or malformed ID at one of their required ID paths. */
function brokenIdArbitrary(key: string, schema: RexJsonSchemaObject) {
  const paths = requiredIdPaths(schema);
  const generators = paths.map((path, index) =>
    rexWireArbitrary(`${key}:id-path-${index}`, forceObject(forcePath(schema, path)), {
      side: "result",
    }),
  );
  return Arbitrary.all([
    Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: paths.length - 1 }))),
    brokenIds,
  ]).pipe(
    Arbitrary.flatMap(([index, broken]) => {
      const path = paths[index] ?? [];
      return (generators[index] ?? Arbitrary.Constant(null)).pipe(
        Arbitrary.map((value) => ({ path, broken, value: replaceAt(value, path, broken) })),
      );
    }),
  );
}

function forceObject(schema: Schema.Json): RexJsonSchemaObject {
  return isJsonObject(schema) ? schema : {};
}

interface MethodUnderTest {
  readonly method: string;
  readonly codecs: WireCodecs;
  /** The request schema the server validates, for server-side generation. */
  readonly requestSchema: RexJsonSchemaObject | undefined;
  /** Wraps encoded arguments into the request payload the server receives. */
  readonly toPayload: (encoded: Schema.Json) => Schema.Json;
  /** Unwraps a server-generated request into what the codec decodes. */
  readonly fromPayload: (payload: Schema.Json) => Schema.Json | undefined;
  readonly resultSchema: RexJsonSchemaObject | undefined;
}

const blockTarget = {
  session_id: "session:01a1aaaa-0000-0000-0000-000000000001",
  block_id: "block:01a1bbbb-0000-0000-0000-000000000001",
};

const methodsUnderTest: ReadonlyArray<MethodUnderTest> = [
  ...contract.serverMethods.flatMap((method): ReadonlyArray<MethodUnderTest> => {
    const codecs = serverCodecs(method.method);
    if (codecs === undefined) return [];
    return [
      {
        method: method.method,
        codecs,
        requestSchema: method.input,
        toPayload: (encoded) => encoded,
        fromPayload: (payload) => payload,
        resultSchema: method.output,
      },
    ];
  }),
  ...contract.blockMethods.flatMap((method): ReadonlyArray<MethodUnderTest> => {
    const codecs = blockCodecs(method.method);
    if (codecs === undefined) return [];
    return [
      {
        method: method.method,
        codecs,
        requestSchema: rexBlockRequestSchema(method.args),
        toPayload: (encoded) => ({ ...blockTarget, args: encoded }),
        fromPayload: (payload) => (isJsonObject(payload) ? (payload["args"] ?? {}) : undefined),
        resultSchema: method.output,
      },
    ];
  }),
];

describe("wire contract coverage", () => {
  test("every server and block method in the snapshot has codecs under test", () => {
    expect(methodsUnderTest.map((method) => method.method).toSorted()).toEqual(
      [
        ...contract.serverMethods.map((method) => method.method),
        ...contract.blockMethods.map((method) => method.method),
      ].toSorted(),
    );
  });
});

describe.each(methodsUnderTest)("$method", (method) => {
  test("every request the SDK can encode is one the server accepts", () =>
    assertRexProperty(
      `${method.method} request encodes to the server's schema`,
      Arbitrary.schema(method.codecs.request),
      (value) => {
        const encoded = expectSuccess(encodeWith(method.codecs.request, value), "encode");
        const wire = overTheWire(encoded);
        // Encoding produces plain JSON: nothing is lost or changed on the way to the server.
        expect(sameOverTheWire(encoded, wire), formatValue({ encoded, wire })).toBe(true);
        expect(rexWireViolation(method.method, "input", method.toPayload(wire))).toBeUndefined();
      },
      { runs: 40, size: 12 },
    ));

  test.runIf(method.requestSchema !== undefined)(
    "every request the server accepts decodes and encodes back unchanged",
    () => {
      const schema = method.requestSchema;
      if (schema === undefined) return;
      return assertRexProperty(
        `${method.method} server-valid request round-trips`,
        rexWireArbitrary(`${method.method}:request`, schema, { side: "request" }),
        (payload) => {
          // The generator stands for the server: its value must pass the server's own check.
          expect(rexWireViolation(method.method, "input", payload)).toBeUndefined();
          const wire = method.fromPayload(payload);
          const decoded = expectSuccess(decodeWith(method.codecs.request, wire), "decode");
          const encoded = expectSuccess(encodeWith(method.codecs.request, decoded), "encode");
          expect(overTheWire(encoded)).toEqual(wire);
        },
        { runs: 40, size: 12 },
      );
    },
  );

  test.runIf(method.resultSchema !== undefined)(
    "every result the server can send decodes, and encodes back to a valid result",
    () => {
      const schema = method.resultSchema;
      if (schema === undefined) return;
      return assertRexProperty(
        `${method.method} server-valid result decodes`,
        rexWireArbitrary(`${method.method}:result`, schema, { side: "result" }),
        (wire) => {
          expect(rexWireViolation(method.method, "output", wire)).toBeUndefined();
          const decoded = expectSuccess(decodeWith(method.codecs.result, wire), "decode");
          const encoded = overTheWire(
            expectSuccess(encodeWith(method.codecs.result, decoded), "encode"),
          );
          expect(rexWireViolation(method.method, "output", encoded)).toBeUndefined();
          const again = expectSuccess(decodeWith(method.codecs.result, encoded), "decode again");
          expect(again).toEqual(decoded);
        },
        { runs: 40, size: 12 },
      );
    },
  );

  test.runIf(method.resultSchema !== undefined)(
    "results from a newer server, with unknown enum values and fields, still decode",
    () => {
      const schema = method.resultSchema;
      if (schema === undefined) return;
      return assertRexProperty(
        `${method.method} forward-compatible result decodes`,
        rexWireArbitrary(`${method.method}:result`, schema, {
          side: "result",
          openEnums: true,
          futureFields: true,
        }),
        (wire) => {
          const future = expectSuccess(decodeWith(method.codecs.result, wire), "decode");
          const plain = expectSuccess(
            decodeWith(method.codecs.result, withoutFutureFields(wire)),
            "decode without unknown fields",
          );
          // Unknown fields change nothing, except inside values the SDK keeps as raw JSON.
          const encoded = expectSuccess(encodeWith(method.codecs.result, future), "encode");
          const plainEncoded = expectSuccess(encodeWith(method.codecs.result, plain), "encode");
          expect(withoutFutureFields(overTheWire(encoded))).toEqual(overTheWire(plainEncoded));
        },
        { runs: 25, size: 10 },
      );
    },
  );

  const idPaths = method.resultSchema === undefined ? [] : requiredIdPaths(method.resultSchema);
  test.runIf(idPaths.length > 0)(
    "a result with a null or malformed required ID fails to decode",
    () => {
      const schema = method.resultSchema;
      if (schema === undefined) return;
      return assertRexProperty(
        `${method.method} broken required ID is rejected`,
        brokenIdArbitrary(`${method.method}:result`, schema),
        ({ value }) => {
          expect(value.found).toBe(true);
          expect(Exit.isFailure(decodeWith(method.codecs.result, value.value))).toBe(true);
        },
        { runs: 25, size: 8 },
      );
    },
  );
});

const frame = (type: string, payload: Schema.Json, seq = 1): RexControlEvent => ({
  generation: 1,
  seq,
  type,
  payload,
});

const decodeEvent = (event: RexControlEvent) => Effect.runSyncExit(decodeRexEvent(event));

const sessionIdArbitrary = rexWireArbitrary(
  "session-id",
  { type: "object", properties: { session_id: { type: "string" } }, required: ["session_id"] },
  { side: "result" },
).pipe(
  Arbitrary.filterMap((value) =>
    isJsonObject(value) && typeof value["session_id"] === "string"
      ? Result.succeed(value["session_id"])
      : Result.fail(value),
  ),
);

const blockIdArbitrary = sessionIdArbitrary.pipe(
  Arbitrary.map((id) => `block:${id.slice("session:".length)}`),
);

describe("server events", () => {
  test("the SDK knows every server event in the event reference", () => {
    expect(Object.keys(rexServerEvents).toSorted()).toEqual(
      Object.keys(contract.serverEvents).toSorted(),
    );
    expect(RexServerEventFrame.members.length).toBe(Object.keys(contract.serverEvents).length);
  });

  test.each(Object.entries(contract.serverEvents))(
    "%s decodes as a ServerEvent, with unknown fields too",
    (type, schema) =>
      assertRexProperty(
        `server event ${type} decodes`,
        Arbitrary.all([
          rexWireArbitrary(`event:${type}`, schema, {
            side: "result",
            definitions: contract.eventDefinitions,
          }),
          rexWireArbitrary(`event:${type}:open`, schema, {
            side: "result",
            openEnums: true,
            futureFields: true,
            definitions: contract.eventDefinitions,
          }),
          Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2 ** 40 }))),
        ]),
        ([payload, open, seq]) => {
          expect(rexEventViolation("server", type, payload)).toBeUndefined();
          const event = expectSuccess(decodeEvent(frame(type, payload, seq)), "decode");
          expect(event._tag).toBe("ServerEvent");
          expect(event._tag === "ServerEvent" && event.type).toBe(type);
          expect(event.seq).toBe(seq);
          expectSuccess(decodeEvent(frame(type, open, seq)), "future");
        },
        { runs: 30, size: 10 },
      ),
  );
});

describe("session events", () => {
  test("the SDK knows every session event in the event reference", () => {
    expect(Object.keys(rexSessionEvents).toSorted()).toEqual(
      Object.keys(contract.sessionEvents).toSorted(),
    );
  });

  test.each(Object.entries(contract.sessionEvents).filter(([type]) => type !== "block_event"))(
    "%s decodes as a SessionEvent of its session, with unknown fields too",
    (type, schema) =>
      assertRexProperty(
        `session event ${type} decodes`,
        Arbitrary.all([
          sessionIdArbitrary,
          rexWireArbitrary(`event:${type}`, schema, {
            side: "result",
            definitions: contract.eventDefinitions,
          }),
          rexWireArbitrary(`event:${type}:open`, schema, {
            side: "result",
            openEnums: true,
            futureFields: true,
            definitions: contract.eventDefinitions,
          }),
        ]),
        ([sessionId, payload, open]) => {
          expect(rexEventViolation("session", type, payload)).toBeUndefined();
          const wrap = (inner: Schema.Json) =>
            frame("session_event", { session_id: sessionId, event: { type, payload: inner } });
          const event = expectSuccess(decodeEvent(wrap(payload)), "decode");
          expect(event._tag === "SessionEvent" && event.type).toBe(type);
          expect(rexEventSessionId(event)).toEqual(Option.some(sessionId));
          expectSuccess(decodeEvent(wrap(open)), "future");
        },
        { runs: 30, size: 10 },
      ),
  );

  test.each(
    contract.blockEvents.map((event) => [`${event.creator} ${event.name}`, event] as const),
  )("block event %s decodes, typed when a terminal sent it", (_label, blockEvent) =>
    assertRexProperty(
      `block event ${blockEvent.creator}/${blockEvent.name} decodes`,
      Arbitrary.all([
        sessionIdArbitrary,
        blockIdArbitrary,
        rexWireArbitrary(
          `block-event:${blockEvent.creator}/${blockEvent.name}`,
          blockEvent.payload,
          {
            side: "result",
          },
        ),
        rexWireArbitrary(
          `block-event:${blockEvent.creator}/${blockEvent.name}:open`,
          blockEvent.payload,
          { side: "result", openEnums: true, futureFields: true },
        ),
      ]),
      ([sessionId, blockId, payload, open]) => {
        expect(rexEventViolation(blockEvent.creator, blockEvent.name, payload)).toBeUndefined();
        const wrap = (inner: Schema.Json) =>
          frame("session_event", {
            session_id: sessionId,
            event: {
              type: "block_event",
              payload: {
                block_id: blockId,
                creator_name: blockEvent.creator,
                name: blockEvent.name,
                payload: inner,
              },
            },
          });
        const event = expectSuccess(decodeEvent(wrap(payload)), "decode");
        if (blockEvent.creator === REX_TERMINAL_CREATOR) {
          expect(event._tag === "TerminalEvent" && [event.name, event.blockId]).toEqual([
            blockEvent.name,
            blockId,
          ]);
        } else {
          expect(event._tag === "BlockEvent" && [event.name, event.blockId, event.payload]).toEqual(
            [blockEvent.name, blockId, payload],
          );
        }
        expect(rexEventSessionId(event)).toEqual(Option.some(sessionId));
        expectSuccess(decodeEvent(wrap(open)), "future");
      },
      { runs: 30, size: 10 },
    ),
  );
});

const knownTypes = new Set([...Object.keys(rexServerEvents), "session_event"]);
const knownSessionTypes = new Set(Object.keys(rexSessionEvents));

const jsonArbitrary = Arbitrary.schema(Schema.Json);
const typeArbitrary = Arbitrary.schema(
  Schema.Union([
    Schema.Literals([...knownTypes]),
    Schema.String.check(Schema.isPattern(/^[a-z_]{1,24}$/)),
  ]),
);

describe("event decoding is total", () => {
  test("an event of a type the SDK doesn't know becomes an UnknownEvent with its payload", () =>
    assertRexProperty(
      "unknown event types are kept",
      Arbitrary.all([
        Arbitrary.schema(Schema.String).pipe(Arbitrary.filter((type) => !knownTypes.has(type))),
        jsonArbitrary,
        sessionIdArbitrary,
        Arbitrary.schema(Schema.String).pipe(
          Arbitrary.filter((type) => !knownSessionTypes.has(type)),
        ),
      ]),
      ([type, payload, sessionId, sessionType]) => {
        const server = expectSuccess(decodeEvent(frame(type, payload)), "server");
        expect(server).toEqual({
          _tag: "UnknownEvent",
          seq: 1,
          sessionId: Option.none(),
          type,
          payload,
        });
        const session = expectSuccess(
          decodeEvent(
            frame("session_event", {
              session_id: sessionId,
              event: { type: sessionType, payload },
            }),
          ),
          "session",
        );
        expect(session).toEqual({
          _tag: "UnknownEvent",
          seq: 1,
          sessionId: Option.some(sessionId),
          type: sessionType,
          payload,
        });
      },
      { runs: 100 },
    ));

  test("any frame decodes or fails as RexInvalidResponse, and never crashes", () =>
    Effect.runPromise(
      checkRexProperty(
        "event decoding is total",
        Arbitrary.all([typeArbitrary, jsonArbitrary, Arbitrary.schema(Schema.Int)]),
        ([type, payload, seq]) =>
          decodeRexEvent(frame(type, payload, seq)).pipe(
            Effect.exit,
            Effect.map((exit) => {
              if (Exit.isSuccess(exit)) {
                expect(exit.value.seq).toBe(seq);
                return;
              }
              const reasons = exit.cause.reasons.map((reason) =>
                reason._tag === "Fail" ? reason.error._tag : reason._tag,
              );
              expect(reasons, formatValue({ type, payload })).toEqual(["RexInvalidResponse"]);
            }),
          ),
        { runs: 300 },
      ),
    ));
});
