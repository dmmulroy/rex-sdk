/**
 * Exhaustive checks of the SDK's small, finite domains: every case is enumerated, so nothing is
 * left to sampling.
 *
 * - Every server error code, and one it doesn't know, becomes its tagged error.
 * - Every REJECT reason byte becomes its named reason.
 * - Every WebSocket close code (1000–4999), and every non-close failure, gets one meaning on a
 *   data connection.
 * - Every handshake reply of one or two bytes, and every first byte of a 32-byte reply, decodes
 *   as the documented layout says.
 * - Every UTF-16 code unit at the start and end of a ticket is accepted exactly when it is
 *   base64url.
 * - A stream holding every kind of Rex message and lookalike parses the same at every pair of
 *   split points.
 * - For one event of every type, every pair of event stream options obeys the selection rules.
 */
import { Arbitrary, Effect, Exit, Option } from "effect";
import { Socket } from "effect/socket";
import { describe, expect, test } from "vite-plus/test";
import { rexEventStreamSelects, type RexEventStreamOptions } from "./event-service.ts";
import { makeRexConfig } from "./rex-config.ts";
import { decodeRexDataHandshakeReply, encodeRexDataHello } from "./rex-data-codec.ts";
import { rexDataCloseFailure } from "./rex-data-connection.ts";
import { SessionId } from "./rex-domain.ts";
import { RexDataRejected, rexServerFailure } from "./rex-errors.ts";
import { decodeRexEvent, rexEventSessionId, type RexEvent } from "./rex-events.ts";
import { makeRexTerminalStreamParser, type RexTerminalStreamItem } from "./rex-terminal-stream.ts";
import {
  rexControlEventOf,
  rexEventBodyArbitrary,
  rexTestSessionIds,
} from "./testing/rex-event-arbitraries.ts";
import { rexWireContract } from "./testing/rex-wire-contract.ts";

describe("server error codes", () => {
  const documented: ReadonlyArray<readonly [string, string]> = [
    ["bad_request", "RexBadRequest"],
    ["not_found", "RexNotFound"],
    ["session_not_found", "RexSessionNotFound"],
    ["method_not_found", "RexMethodNotFound"],
    ["conflict", "RexConflict"],
    ["not_supported", "RexNotSupported"],
    ["refused", "RexRefused"],
    ["client_unavailable", "RexClientUnavailable"],
    ["too_large", "RexTooLarge"],
    ["revision_too_low", "RexRevisionTooLow"],
    ["timeout", "RexServerTimeout"],
    ["internal", "RexServerError"],
    ["a_code_from_a_newer_server", "RexServerError"],
    ["", "RexServerError"],
  ];

  test.each(documented)("%s becomes %s", (code, tag) => {
    const failure = rexServerFailure({
      method: "session.view",
      requestId: "7",
      code,
      status: 418,
      serverMessage: "message",
    });
    expect(failure._tag).toBe(tag);
    expect(failure.message).toContain("session.view");
  });
});

describe("data REJECT reasons", () => {
  const named = [
    "unknown_ticket",
    "already_connected",
    "stream_unavailable",
    "limit_reached",
    "malformed_handshake",
    "server_failed",
    "wrong_subprotocol",
  ];

  test("every reason byte has a reason, named for 1 through 7 and unknown otherwise", () => {
    for (let byte = 0; byte <= 255; byte += 1) {
      const rejected = new RexDataRejected(byte);
      expect(rejected.reasonCode).toBe(byte);
      expect(rejected.reason).toBe(named[byte - 1] ?? "unknown");
      expect(rejected.message).toContain(`0x${byte.toString(16).padStart(2, "0")}`);
    }
  });
});

describe("data connection close codes", () => {
  const config = Effect.runSync(makeRexConfig({ server: "/tmp/rex-sdk-exhaustive.sock" }));
  const closed = (code: number) =>
    new Socket.SocketError({ reason: new Socket.SocketCloseError({ code, closeReason: "why" }) });

  test("every close code from 1000 to 4999 has exactly one meaning", () => {
    for (let code = 1000; code <= 4999; code += 1) {
      const failure = rexDataCloseFailure(config, "block:1", closed(code));
      if (code === 1000) expect(failure).toBeUndefined();
      else if (code === 4000) expect(failure?._tag).toBe("RexBlockClosed");
      else {
        expect(failure?._tag).toBe("RexDataStreamFailed");
        expect(failure?._tag === "RexDataStreamFailed" && failure.code).toBe(code);
      }
    }
  });

  test("a failure without a close frame is a connection failure", () => {
    const read = rexDataCloseFailure(
      config,
      "block:1",
      new Socket.SocketError({ reason: new Socket.SocketReadError({ cause: "reset" }) }),
    );
    const open = rexDataCloseFailure(
      config,
      "block:1",
      new Socket.SocketError({
        reason: new Socket.SocketOpenError({ kind: "Timeout", cause: "slow" }),
      }),
    );
    expect([read?._tag, open?._tag]).toEqual(["RexConnectionError", "RexConnectionError"]);
  });
});

describe("handshake replies", () => {
  const expected = (message: Uint8Array) => {
    if (message[0] === 0x82 && message.length >= 2) return Option.some("Reject");
    if (
      message[0] === 0x81 &&
      message.length === 32 &&
      Buffer.from(message).readBigUInt64LE(24) !== 0n
    ) {
      return Option.some("Welcome");
    }
    return Option.none();
  };
  const tagOf = (message: Uint8Array) =>
    Option.map(decodeRexDataHandshakeReply(message), (reply) => reply._tag);

  test("every reply of zero, one, or two bytes decodes as the layout says", () => {
    expect(tagOf(new Uint8Array(0))).toEqual(Option.none());
    for (let first = 0; first <= 255; first += 1) {
      expect(tagOf(Uint8Array.of(first))).toEqual(Option.none());
      for (let second = 0; second <= 255; second += 1) {
        const message = Uint8Array.of(first, second);
        const tag = tagOf(message);
        if (Option.isSome(tag) !== Option.isSome(expected(message))) {
          expect(tag).toEqual(expected(message));
        }
      }
    }
  });

  test("every first byte of a 32-byte reply, with and without a nonce, decodes as the layout says", () => {
    for (let first = 0; first <= 255; first += 1) {
      for (const nonce of [0n, 1n, 2n ** 64n - 1n]) {
        const message = Buffer.alloc(32);
        message[0] = first;
        message.writeBigUInt64LE(nonce, 24);
        expect(tagOf(new Uint8Array(message))).toEqual(expected(new Uint8Array(message)));
      }
    }
  });
});

describe("tickets", () => {
  const base64url = /^[A-Za-z0-9_-]$/;
  const valid = "AAECAwQFBgcICQoLDA0ODw";

  test("every code unit at the first and last place is accepted exactly when it is base64url", () => {
    for (let unit = 0; unit <= 0xffff; unit += 1) {
      const character = String.fromCharCode(unit);
      for (const ticket of [character + valid.slice(1), valid.slice(0, -1) + character]) {
        expect(Option.isSome(encodeRexDataHello(ticket))).toBe(base64url.test(character));
      }
    }
  });

  test("every length but 22 is refused", () => {
    for (let length = 0; length <= 64; length += 1) {
      expect(Option.isSome(encodeRexDataHello("A".repeat(length)))).toBe(length === 22);
    }
  });
});

describe("terminal stream split points", () => {
  const nonce = 31337n;
  const message = (json: object, other = nonce) =>
    `\u001b_rex1;${other};${JSON.stringify(json)}\u001b\\`;
  const stream =
    "é✓" +
    message({ type: "resize", cols: 80, rows: 24, owner: null }) +
    "\u001b[1m" +
    message({ type: "child_exited", exit_code: 0 }, 99n) +
    "\u001b_rex1;broken" +
    message({ type: "theme", palette: ["1=ff0000"] }) +
    "\u001b_Gf=1\u001b\\" +
    message({ type: "child_exited", exit_code: 7 }) +
    "\u001b";
  const bytes = new TextEncoder().encode(stream);

  const parse = (cuts: ReadonlyArray<number>) => {
    const parser = makeRexTerminalStreamParser(nonce);
    const items: Array<RexTerminalStreamItem> = [];
    let start = 0;
    for (const end of [...cuts, bytes.length]) {
      items.push(...parser.push(bytes.slice(start, end)));
      start = end;
    }
    items.push(...parser.flush());
    const joined: Array<string | object> = [];
    for (const item of items) {
      const last = joined.at(-1);
      if (item._tag === "Output") {
        const text = Buffer.from(item.bytes).toString("latin1");
        if (typeof last === "string") joined[joined.length - 1] = last + text;
        else joined.push(text);
      } else joined.push(item.message);
    }
    return joined;
  };

  test("every pair of split points gives the result of one chunk", () => {
    const whole = parse([]);
    expect(whole.filter((item) => typeof item !== "string")).toHaveLength(3);
    for (let first = 1; first < bytes.length; first += 1) {
      for (let second = first; second < bytes.length; second += 1) {
        const parsed = parse([first, second]);
        if (JSON.stringify(parsed) !== JSON.stringify(whole)) {
          expect({ first, second, parsed }).toEqual({ first, second, parsed: whole });
        }
      }
    }
  });
});

describe("event stream options", () => {
  const contract = rexWireContract();
  const types = new Set([
    ...Object.keys(contract.serverEvents),
    ...Object.keys(contract.sessionEvents)
      .filter((type) => type !== "block_event")
      .map((type) => `session/${type}`),
    ...contract.blockEvents.map((event) => `block/${event.creator}/${event.name}`),
  ]);
  /** One generated event of every type, from a fixed seed. */
  const samples = Effect.runSync(
    Arbitrary.sampleEffect(rexEventBodyArbitrary(), { count: 3000, seed: 7 }),
  );
  const events = new Map<string, RexEvent>();
  for (const body of samples) {
    const exit = Effect.runSyncExit(decodeRexEvent(rexControlEventOf(body, 1)));
    if (Exit.isFailure(exit)) throw new Error(String(exit.cause));
    const event = exit.value;
    const key =
      event._tag === "ServerEvent"
        ? event.type
        : event._tag === "SessionEvent"
          ? `session/${event.type}`
          : event._tag === "TerminalEvent"
            ? `block/com.superlogical.terminal/${event.name}`
            : event._tag === "BlockEvent"
              ? `block/${Option.getOrElse(event.creatorName, () => "")}/${event.name}`
              : `unknown/${Option.isSome(event.sessionId)}`;
    if (!events.has(key)) events.set(key, event);
  }

  const subsets = Array.from({ length: 8 }, (_, mask) =>
    rexTestSessionIds
      .filter((_, index) => (mask & (1 << index)) !== 0)
      .map((id) => SessionId.make(id)),
  );
  const scopes = [undefined, "none", "session", "all"] as const;
  const allOptions: ReadonlyArray<RexEventStreamOptions> = [
    { sessionIds: undefined, server: undefined },
    ...subsets.flatMap((sessionIds) => scopes.map((server) => ({ sessionIds, server }))),
  ];
  const effectiveScope = (options: RexEventStreamOptions) =>
    options.server ?? (options.sessionIds === undefined ? "all" : "none");
  const rank = { none: 0, session: 1, all: 2 } as const;
  const includes = (wide: RexEventStreamOptions, narrow: RexEventStreamOptions) =>
    rank[effectiveScope(wide)] >= rank[effectiveScope(narrow)] &&
    (narrow.sessionIds ?? []).every((id) => (wide.sessionIds ?? []).includes(id));

  test("the samples hold an event of every type in the event reference", () => {
    for (const type of types) expect(events.has(type), type).toBe(true);
    expect(events.has("unknown/true") && events.has("unknown/false")).toBe(true);
  });

  test("for every event and every pair of options, wider options select at least as much", () => {
    for (const event of events.values()) {
      const selected = allOptions.map((options) => rexEventStreamSelects(options)(event));
      allOptions.forEach((narrow, narrowIndex) => {
        const sessionId = rexEventSessionId(event);
        if (Option.isSome(sessionId) && (narrow.sessionIds ?? []).includes(sessionId.value)) {
          expect(selected[narrowIndex]).toBe(true);
        }
        if (effectiveScope(narrow) === "all") expect(selected[narrowIndex]).toBe(true);
        if (!selected[narrowIndex]) return;
        allOptions.forEach((wide, wideIndex) => {
          if (includes(wide, narrow)) expect(selected[wideIndex]).toBe(true);
        });
      });
    }
  });
});
