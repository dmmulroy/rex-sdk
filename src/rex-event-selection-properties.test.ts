/**
 * Property checks of which events a stream selects (`rexEventStreamSelects`), over every event
 * the server can send.
 *
 * Streams share one connection, which receives the union of what they asked for, so each stream
 * filters for itself. The rules checked here are the ones that make sharing safe: asking for
 * more never selects less, an event of a listed session is always selected, and a stream sees
 * nothing a connection attached only as it asked would not receive.
 */
import { Arbitrary, Effect, Exit, Option, Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { SessionId } from "./rex-domain.ts";
import { rexEventStreamSelects, type RexEventStreamOptions } from "./event-service.ts";
import { decodeRexEvent, rexEventSessionId, type RexEvent } from "./rex-events.ts";
import {
  rexControlEventOf,
  rexEventBodyArbitrary,
  rexTestSessionIds,
} from "./testing/rex-event-arbitraries.ts";
import { assertRexProperty } from "./testing/rex-property.ts";

const decodeSessionIds = Schema.decodeUnknownSync(Schema.Array(SessionId));
const lists = (sessions: ReadonlyArray<string>, sessionId: Option.Option<SessionId>) =>
  Option.isSome(sessionId) && sessions.some((listed) => listed === sessionId.value);

const eventArbitrary = rexEventBodyArbitrary().pipe(
  Arbitrary.map((body): RexEvent => {
    const exit = Effect.runSyncExit(decodeRexEvent(rexControlEventOf(body, 1)));
    if (Exit.isFailure(exit))
      throw new Error(`generated event failed to decode: ${String(exit.cause)}`);
    return exit.value;
  }),
);

const sessionSubset = Arbitrary.schema(
  Schema.Array(Schema.Literals(rexTestSessionIds)).check(Schema.isMaxLength(3)),
);
const scopeArbitrary = Arbitrary.schema(Schema.Literals(["none", "session", "all"]));
const rank = { none: 0, session: 1, all: 2 } as const;

function options(
  sessions: ReadonlyArray<string> | undefined,
  server: "none" | "session" | "all" | undefined,
): RexEventStreamOptions {
  const sessionIds: ReadonlyArray<SessionId> | undefined =
    sessions === undefined ? undefined : decodeSessionIds(sessions);
  return { sessionIds, server };
}

describe("event stream selection", () => {
  test("asking for more sessions or a wider server scope never selects fewer events", () =>
    assertRexProperty(
      "event selection is monotone",
      Arbitrary.all([eventArbitrary, sessionSubset, sessionSubset, scopeArbitrary, scopeArbitrary]),
      ([event, some, more, narrow, wide]) => {
        const smaller = options(some, rank[narrow] <= rank[wide] ? narrow : wide);
        const larger = options([...some, ...more], rank[narrow] <= rank[wide] ? wide : narrow);
        if (rexEventStreamSelects(smaller)(event)) {
          expect(rexEventStreamSelects(larger)(event)).toBe(true);
        }
      },
      { runs: 500 },
    ));

  test("an event of a listed session is always selected; server scope all selects everything", () =>
    assertRexProperty(
      "listed sessions and scope all",
      Arbitrary.all([eventArbitrary, sessionSubset, scopeArbitrary]),
      ([event, sessions, server]) => {
        const sessionId = rexEventSessionId(event);
        if (lists(sessions, sessionId)) {
          expect(rexEventStreamSelects(options(sessions, server))(event)).toBe(true);
        }
        expect(rexEventStreamSelects(options(sessions, "all"))(event)).toBe(true);
        // Without sessions, the default is everything.
        expect(rexEventStreamSelects(options(undefined, undefined))(event)).toBe(true);
      },
      { runs: 500 },
    ));

  test("a stream sees nothing a connection attached only as it asked would not receive", () =>
    assertRexProperty(
      "selection never exceeds the stream's own attachments",
      Arbitrary.all([eventArbitrary, sessionSubset, scopeArbitrary]),
      ([event, sessions, server]) => {
        if (!rexEventStreamSelects(options(sessions, server))(event)) return;
        const sessionId = rexEventSessionId(event);
        const listed = lists(sessions, sessionId);
        if (listed || server === "all") return;
        // Neither listed nor scope all: only the session scope can have selected it.
        expect(server).toBe("session");
        expect(event._tag).not.toBe("TerminalEvent");
        expect(event._tag).not.toBe("BlockEvent");
      },
      { runs: 500 },
    ));
});
