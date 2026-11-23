import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Exit, Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";
import {
  rexBlockMethods,
  rexWireMethods,
  type RexWireMethod,
} from "./generated/rex-wire-schemas.ts";

const RexApiExamples = Schema.Struct({
  methods: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      request_example: Schema.optionalKey(Schema.String),
      response_example: Schema.optionalKey(Schema.String),
    }),
  ),
});

const decodeRexApiExamples = Schema.decodeUnknownSync(Schema.fromJsonString(RexApiExamples));
const apiExamples = decodeRexApiExamples(
  readFileSync(join(import.meta.dirname, "../schema/rex-api.json"), "utf8"),
);

function isRexWireMethod(name: string): name is RexWireMethod {
  return Object.hasOwn(rexWireMethods, name);
}

/** Replaces documentation placeholders such as `session:<uuid>` with well-formed IDs. */
function concreteExample(example: string): unknown {
  return JSON.parse(example.replaceAll("<uuid>", "01234567-89ab-cdef-0123-456789abcdef"));
}

describe("generated wire schemas", () => {
  test("cover every server method in the snapshot", () => {
    expect(apiExamples.methods.map((method) => method.name).toSorted()).toEqual(
      Object.keys(rexWireMethods).toSorted(),
    );
  });

  for (const method of apiExamples.methods) {
    const name = method.name;
    if (!isRexWireMethod(name)) continue;
    const codecs = rexWireMethods[name];

    if (method.response_example !== undefined) {
      const responseExample = method.response_example;
      test(`${name} decodes its documented result`, () => {
        const exit = Effect.runSyncExit(
          Schema.decodeUnknownEffect(codecs.result)(concreteExample(responseExample)),
        );
        expect(Exit.isSuccess(exit), String(exit)).toBe(true);
      });
    }

    if (method.request_example !== undefined) {
      const requestExample = method.request_example;
      test(`${name} round-trips its documented arguments`, () => {
        const wire = concreteExample(requestExample);
        const roundTrip = Effect.gen(function* () {
          const decoded = yield* Schema.decodeUnknownEffect(codecs.input)(wire);
          return yield* Schema.encodeUnknownEffect(codecs.input)(decoded);
        });
        const exit = Effect.runSyncExit(roundTrip);
        expect(Exit.isSuccess(exit), String(exit)).toBe(true);
        if (Exit.isSuccess(exit)) expect(exit.value).toEqual(wire);
      });
    }
  }
});

describe("generated wire schema mapping", () => {
  test("rejects an ID of the wrong kind where a branded ID is expected", () => {
    const exit = Effect.runSyncExit(
      Schema.decodeUnknownEffect(rexWireMethods["session.new_split"].result)({
        anchor_id: "block:1",
        block_ids: ["window:1"],
        split_ids: ["split:1"],
        revision: 1,
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("reads null and missing arrays as empty arrays and optional nullable values as Option", () => {
    const decoded = Effect.runSync(
      Schema.decodeUnknownEffect(rexWireMethods["session.view"].result)({
        revision: 3,
        session_id: "session:1",
        active_window_id: null,
      }),
    );
    expect(decoded.windows).toEqual([]);
    expect(decoded.activeWindowId._tag).toBe("None");
    const split = Effect.runSync(
      Schema.decodeUnknownEffect(rexWireMethods["session.new_split"].result)({
        anchor_id: "block:1",
        block_ids: null,
        split_ids: null,
        revision: 3,
      }),
    );
    expect(split.blockIds).toEqual([]);
    expect(split.anchorId).toBe("block:1");
  });

  test("treats null in a required ID field as a contract violation", () => {
    const exit = Effect.runSyncExit(
      Schema.decodeUnknownEffect(rexWireMethods["session.new_split"].result)({
        anchor_id: null,
        block_ids: [],
        split_ids: [],
        revision: 3,
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("enforces documented numeric bounds on arguments", () => {
    const exit = Effect.runSyncExit(
      Schema.decodeUnknownEffect(rexBlockMethods["com.superlogical.terminal.resize"].args)({
        columns: -1,
        rows: 24,
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
