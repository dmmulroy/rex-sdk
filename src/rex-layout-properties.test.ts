/**
 * Property checks of layout encoding: every layout tree encodes to the wire form the server reads,
 * node for node, or fails as `RexInvalidInput` exactly when one of its split ratios is invalid.
 * Terminal options are checked against the terminal flavor's own options schema.
 */
import { Ajv2020 } from "ajv/dist/2020.js";
import { Arbitrary, Effect, Exit, Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { TerminalShellOptions } from "./generated/rex-wire-schemas.ts";
import { encodeRexLayout, REX_TERMINAL_SHELL_FLAVOR, RexLayoutNode } from "./rex-layout.ts";
import { assertRexProperty } from "./testing/rex-property.ts";
import { rexWireContract } from "./testing/rex-wire-contract.ts";

const terminalOptionsSchema = rexWireContract().flavorOptions[REX_TERMINAL_SHELL_FLAVOR];
const validateTerminalOptions = new Ajv2020({ strict: false }).compile(terminalOptionsSchema ?? {});
const decodeTerminalOptions = Schema.decodeUnknownSync(TerminalShellOptions);
const decodeWireObject = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json));

const validRatio = (ratio: number | undefined) =>
  ratio === undefined || (Number.isFinite(ratio) && ratio > 0 && ratio < 1);

function allRatiosValid(node: RexLayoutNode): boolean {
  if (node._tag !== "Split") return true;
  return validRatio(node.ratio) && allRatiosValid(node.before) && allRatiosValid(node.after);
}

/** Checks that `wire` is the encoding of `node`, field by field. */
function expectEncodes(node: RexLayoutNode, wire: Schema.Json): void {
  const object = decodeWireObject(wire);
  if (node._tag === "Split") {
    expect(Object.keys(object)).toEqual(["split"]);
    const split = decodeWireObject(object["split"]);
    expect(split["direction"]).toBe(node.direction);
    expect(split["ratio"]).toBe(node.ratio);
    expectEncodes(node.before, split["before"] ?? null);
    expectEncodes(node.after, split["after"] ?? null);
    return;
  }
  expect(Object.keys(object)).toEqual(["block"]);
  const block = decodeWireObject(object["block"]);
  expect(block["label"]).toBe(node.label);
  if (node._tag === "Block") {
    expect(block["flavor"]).toBe(node.flavor);
    expect(block["options"]).toEqual(node.options);
    return;
  }
  expect(block["flavor"]).toBe(REX_TERMINAL_SHELL_FLAVOR);
  const options = block["options"];
  if (options === undefined) {
    // Options are left out only when there are none to send.
    expect(node.options === undefined || Object.keys(node.options).length === 0).toBe(true);
    return;
  }
  expect(validateTerminalOptions(options), JSON.stringify(validateTerminalOptions.errors)).toBe(
    true,
  );
  expect(decodeTerminalOptions(options)).toEqual(node.options);
}

/** Ratios from the whole number line, valid ones included often. */
const invalidRatios = [0, 1, -0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY];
const ratioArbitrary = Arbitrary.all([
  Arbitrary.schema(Schema.Boolean),
  Arbitrary.schema(Schema.Number.check(Schema.isBetween({ minimum: 0.001, maximum: 0.999 }))),
  Arbitrary.schema(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: invalidRatios.length - 1 })),
  ),
]).pipe(Arbitrary.map(([valid, ratio, index]) => (valid ? ratio : (invalidRatios[index] ?? 0))));

/** Layout trees, with ratios replaced by ones from `ratioArbitrary` where a split has one. */
const layoutArbitrary = Arbitrary.all([
  Arbitrary.schema(RexLayoutNode),
  Arbitrary.array(ratioArbitrary, { maxLength: 16 }),
]).pipe(
  Arbitrary.map(([node, ratios]) => {
    let next = 0;
    const withRatios = (current: RexLayoutNode): RexLayoutNode => {
      if (current._tag !== "Split") return current;
      const ratio =
        current.ratio === undefined ? undefined : ratios[next++ % Math.max(ratios.length, 1)];
      return {
        ...current,
        ratio: ratio ?? current.ratio,
        before: withRatios(current.before),
        after: withRatios(current.after),
      };
    };
    return withRatios(node);
  }),
);

describe("layout encoding", () => {
  test("encodes every tree node for node, failing exactly when a ratio is invalid", () =>
    assertRexProperty(
      "layout encodes node for node",
      layoutArbitrary,
      (node) => {
        const exit = Effect.runSyncExit(encodeRexLayout("session.new_split", node));
        if (!allRatiosValid(node)) {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(
              exit.cause.reasons.map((reason) => reason._tag === "Fail" && reason.error._tag),
            ).toEqual(["RexInvalidInput"]);
          }
          return;
        }
        if (Exit.isFailure(exit)) throw new Error(String(exit.cause));
        expectEncodes(node, exit.value);
      },
      { runs: 300, size: 10 },
    ));
});
