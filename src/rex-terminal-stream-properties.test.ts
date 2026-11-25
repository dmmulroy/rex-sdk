/**
 * Property checks of the terminal stream parser against a reference parser.
 *
 * Streams are built from pieces that exercise every path through the parser: program output with
 * any bytes, Rex messages with the channel's nonce, sequences that only look like Rex messages
 * (another nonce, bad JSON, a prefix that never ends, other escape sequences), and stray escape
 * bytes. Each stream is then cut into chunks at generated points, as a WebSocket might deliver it.
 *
 * The reference parser reads the whole stream at once and follows the rule terminals follow for
 * APC strings: an ESC inside one ends it. A Rex message is `ESC _ rex1;<nonce>;<json> ESC \` whose
 * body holds no ESC (Rex's JSON never does) and whose JSON is an object with a string `type`.
 */
import { Arbitrary, Option, Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";
import {
  makeRexTerminalStreamParser,
  type RexTerminalStreamItem,
  type RexTerminalStreamMessage,
} from "./rex-terminal-stream.ts";
import { assertRexProperty } from "./testing/rex-property.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ESC = 0x1b;

/** One item of a parsed stream, in a form that compares by value. */
type Parsed =
  | { readonly _tag: "Output"; readonly bytes: ReadonlyArray<number> }
  | { readonly _tag: "Message"; readonly message: RexTerminalStreamMessage };

/** Joins adjacent output, so chunking that splits output differently still compares equal. */
function normalize(items: ReadonlyArray<RexTerminalStreamItem>): ReadonlyArray<Parsed> {
  const result: Array<Parsed> = [];
  for (const item of items) {
    const last = result.at(-1);
    if (item._tag === "Output") {
      if (item.bytes.length === 0) continue;
      if (last?._tag === "Output") {
        result[result.length - 1] = { _tag: "Output", bytes: [...last.bytes, ...item.bytes] };
      } else {
        result.push({ _tag: "Output", bytes: Array.from(item.bytes) });
      }
    } else {
      result.push({ _tag: "Message", message: item.message });
    }
  }
  return result;
}

function parseChunks(
  nonce: bigint,
  bytes: Uint8Array,
  cuts: ReadonlyArray<number>,
): ReadonlyArray<Parsed> {
  const parser = makeRexTerminalStreamParser(nonce);
  const items: Array<RexTerminalStreamItem> = [];
  let start = 0;
  for (const end of [
    ...cuts.filter((cut) => cut > 0 && cut < bytes.length).toSorted((a, b) => a - b),
    bytes.length,
  ]) {
    if (end < start) continue;
    items.push(...parser.push(bytes.slice(start, end)));
    start = end;
  }
  items.push(...parser.flush());
  return normalize(items);
}

const decodeJsonText = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));
const decodeJson = Schema.decodeUnknownSync(Schema.Json);
const MessageType = Schema.Struct({ type: Schema.String });
const isMessageObject = Schema.is(MessageType);

/** A message span the reference parser found, and the JSON its body held. */
type ReferenceItem =
  | { readonly _tag: "Output"; readonly bytes: ReadonlyArray<number> }
  | { readonly _tag: "Message"; readonly json: Schema.Json; readonly type: string };

const prefix = encoder.encode("\u001b_rex1;");

/** Reads a whole stream at once, following the rules in this file's description. */
function referenceParse(nonce: bigint, bytes: Uint8Array): ReadonlyArray<ReferenceItem> {
  const items: Array<ReferenceItem> = [];
  let output: Array<number> = [];
  const flushOutput = () => {
    if (output.length > 0) items.push({ _tag: "Output", bytes: output });
    output = [];
  };
  let index = 0;
  while (index < bytes.length) {
    if (prefix.every((byte, offset) => bytes[index + offset] === byte)) {
      const bodyStart = index + prefix.length;
      const end = bytes.indexOf(ESC, bodyStart);
      if (end !== -1 && bytes[end + 1] === 0x5c) {
        const body = decoder.decode(bytes.subarray(bodyStart, end));
        const separator = body.indexOf(";");
        if (separator !== -1 && body.slice(0, separator) === nonce.toString()) {
          const json = decodeJsonText(body.slice(separator + 1));
          if (Option.isSome(json) && isMessageObject(json.value)) {
            flushOutput();
            items.push({ _tag: "Message", json: json.value, type: json.value.type });
            index = end + 2;
            continue;
          }
        }
      }
    }
    output.push(bytes[index] ?? 0);
    index += 1;
  }
  flushOutput();
  return items;
}

/** A piece of a generated stream, with the message it must parse to when it is one. */
interface Piece {
  readonly bytes: Uint8Array;
  readonly message: Option.Option<RexTerminalStreamMessage>;
}

const piece = (text: string | Uint8Array, message?: RexTerminalStreamMessage): Piece => ({
  bytes: typeof text === "string" ? encoder.encode(text) : text,
  message: Option.fromUndefinedOr(message),
});

const rexSequence = (nonce: bigint, body: string) => `\u001b_rex1;${nonce};${body}\u001b\\`;

const smallInt = Arbitrary.schema(
  Schema.Int.check(Schema.isBetween({ minimum: -5, maximum: 70_000 })),
);
const shortText = Arbitrary.schema(Schema.String.check(Schema.isMaxLength(12)));
const optionalText = Arbitrary.schema(Schema.optional(Schema.String.check(Schema.isMaxLength(8))));

/** Genuine Rex messages, as Rex writes them, with what the parser must return for each. */
function genuineMessage(nonce: bigint): Arbitrary.Arbitrary<Piece> {
  const resize = Arbitrary.all({
    cols: smallInt,
    rows: smallInt,
    cellWidth: Arbitrary.schema(
      Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 64 }))),
    ),
    cellHeight: Arbitrary.schema(
      Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 64 }))),
    ),
    owner: Arbitrary.schema(
      Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(8)))),
    ),
  }).pipe(
    Arbitrary.map(({ cols, rows, cellWidth, cellHeight, owner }) =>
      piece(
        rexSequence(
          nonce,
          JSON.stringify({
            type: "resize",
            cols,
            rows,
            cell_width_px: cellWidth,
            cell_height_px: cellHeight,
            owner,
          }),
        ),
        {
          type: "resize",
          cols,
          rows,
          cellWidthPx: cellWidth ?? 0,
          cellHeightPx: cellHeight ?? 0,
          owner: Option.fromNullishOr(owner),
        },
      ),
    ),
  );
  const theme = Arbitrary.all({
    foreground: optionalText,
    background: optionalText,
    cursor: optionalText,
    palette: Arbitrary.schema(
      Schema.optional(Schema.NullOr(Schema.Array(Schema.String.check(Schema.isMaxLength(9))))),
    ),
    scheme: optionalText,
  }).pipe(
    Arbitrary.map(({ foreground, background, cursor, palette, scheme }) =>
      piece(
        rexSequence(
          nonce,
          JSON.stringify({ type: "theme", foreground, background, cursor, palette, scheme }),
        ),
        {
          type: "theme",
          foreground: Option.fromUndefinedOr(foreground),
          background: Option.fromUndefinedOr(background),
          cursor: Option.fromUndefinedOr(cursor),
          palette: palette ?? [],
          scheme: Option.fromUndefinedOr(scheme),
        },
      ),
    ),
  );
  const childExited = smallInt.pipe(
    Arbitrary.map((exitCode) =>
      piece(rexSequence(nonce, JSON.stringify({ type: "child_exited", exit_code: exitCode })), {
        type: "child_exited",
        exitCode,
      }),
    ),
  );
  const unknown = Arbitrary.all([
    Arbitrary.schema(Schema.String.check(Schema.isPattern(/^[a-z_]{1,10}$/))).pipe(
      Arbitrary.filter((type) => !["resize", "theme", "child_exited"].includes(type)),
    ),
    Arbitrary.schema(Schema.Json),
  ]).pipe(
    Arbitrary.map(([type, value]) => {
      // What the parser sees is the JSON text, so compare with the value JSON gives back.
      const message = decodeJson(JSON.parse(JSON.stringify({ type, value })));
      return piece(rexSequence(nonce, JSON.stringify(message)), {
        type: "unknown",
        messageType: type,
        message,
      });
    }),
  );
  return oneOf([resize, theme, childExited, unknown]);
}

/** Pieces that look like Rex messages, or parts of them, but are program output. */
function lookalike(nonce: bigint): Arbitrary.Arbitrary<Piece> {
  const otherNonce = Arbitrary.schema(Schema.BigInt).pipe(
    Arbitrary.filter((other) => other !== nonce),
    Arbitrary.map((other) =>
      piece(rexSequence(other, JSON.stringify({ type: "child_exited", exit_code: 0 }))),
    ),
  );
  const badJson = Arbitrary.schema(
    Schema.Literals(["", "{", "[]", "1", '{"type":1}', '"type"', '{"type":"x"', "null", "{}"]),
  ).pipe(Arbitrary.map((body) => piece(rexSequence(nonce, body))));
  const noNonceSeparator = shortText.pipe(
    Arbitrary.map((text) =>
      piece(`\u001b_rex1;${text.replaceAll(";", "").replaceAll("\u001b", "")}\u001b\\`),
    ),
  );
  const unterminated = shortText.pipe(
    Arbitrary.map((text) =>
      piece(`\u001b_rex1;${nonce};{"type":"x${text.replaceAll("\u001b", "")}`),
    ),
  );
  const foreignApc = shortText.pipe(
    Arbitrary.map((text) => piece(`\u001b_Gf=100;${text.replaceAll("\u001b", "")}\u001b\\`)),
  );
  const fragments = Arbitrary.schema(
    Schema.Literals([
      "\u001b",
      "\u001b_",
      "\u001b_r",
      "\u001b_rex1",
      "\u001b_rex1;",
      "\u001b\\",
      "\u001b[31m",
      "\u001b]0;t\u0007",
      "_rex1;",
    ]),
  ).pipe(Arbitrary.map((text) => piece(text)));
  return oneOf([otherNonce, badJson, noNonceSeparator, unterminated, foreignApc, fragments]);
}

const anyBytes = Arbitrary.schema(
  Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))),
).pipe(Arbitrary.map((values) => piece(Uint8Array.from(values))));
const text = Arbitrary.schema(Schema.String).pipe(Arbitrary.map((value) => piece(value)));

function oneOf<A>(choices: ReadonlyArray<Arbitrary.Arbitrary<A>>): Arbitrary.Arbitrary<A> {
  const [first] = choices;
  if (first === undefined) throw new Error("oneOf needs a choice");
  return Arbitrary.schema(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: choices.length - 1 })),
  ).pipe(Arbitrary.flatMap((index) => choices[index] ?? first));
}

const nonceArbitrary = Arbitrary.schema(
  Schema.BigInt.check(Schema.isBetweenBigInt({ minimum: 1n, maximum: 2n ** 64n - 1n })),
);

function concat(pieces: ReadonlyArray<Piece>): Uint8Array {
  const joined = new Uint8Array(pieces.reduce((total, part) => total + part.bytes.length, 0));
  let offset = 0;
  for (const part of pieces) {
    joined.set(part.bytes, offset);
    offset += part.bytes.length;
  }
  return joined;
}

/** A stream of pieces, the nonce it was written with, and cut points. */
const streamArbitrary = nonceArbitrary.pipe(
  Arbitrary.flatMap((nonce) =>
    Arbitrary.all({
      nonce: Arbitrary.Constant(nonce),
      pieces: Arbitrary.array(oneOf([genuineMessage(nonce), lookalike(nonce), text, anyBytes]), {
        maxLength: 12,
      }),
      cuts: Arbitrary.array(
        Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4096 }))),
        {
          maxLength: 16,
        },
      ),
    }),
  ),
);

function expectMatchesReference(nonce: bigint, bytes: Uint8Array, parsed: ReadonlyArray<Parsed>) {
  const reference = referenceParse(nonce, bytes);
  expect(parsed.map((item) => item._tag)).toEqual(reference.map((item) => item._tag));
  parsed.forEach((item, index) => {
    const expected = reference[index];
    if (item._tag === "Output" && expected?._tag === "Output") {
      expect(item.bytes).toEqual(expected.bytes);
    } else if (item._tag === "Message" && expected?._tag === "Message") {
      const type = item.message.type === "unknown" ? item.message.messageType : item.message.type;
      expect(type).toBe(expected.type);
    }
  });
}

describe("terminal stream parser", () => {
  test("parses any stream as the reference parser does, wherever it is cut", () =>
    assertRexProperty(
      "terminal stream parses like the reference",
      streamArbitrary,
      ({ nonce, pieces, cuts }) => {
        const bytes = concat(pieces);
        expectMatchesReference(nonce, bytes, parseChunks(nonce, bytes, cuts));
      },
      { runs: 400, size: 20 },
    ));

  test("returns every genuine message with its fields, and everything else as output", () =>
    assertRexProperty(
      "terminal stream keeps output and messages",
      nonceArbitrary.pipe(
        Arbitrary.flatMap((nonce) =>
          Arbitrary.all({
            nonce: Arbitrary.Constant(nonce),
            // Output without ESC can't combine with a neighbour into a sequence.
            pieces: Arbitrary.array(
              oneOf([
                genuineMessage(nonce),
                Arbitrary.schema(Schema.String).pipe(
                  Arbitrary.map((value) => piece(value.replaceAll("\u001b", ""))),
                ),
              ]),
              { maxLength: 10 },
            ),
            cuts: Arbitrary.array(
              Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2048 }))),
              { maxLength: 12 },
            ),
          }),
        ),
      ),
      ({ nonce, pieces, cuts }) => {
        const expected = normalize(
          pieces.map((part): RexTerminalStreamItem =>
            Option.match(part.message, {
              onNone: () => ({ _tag: "Output", bytes: part.bytes }),
              onSome: (message) => ({ _tag: "Message", message }),
            }),
          ),
        );
        expect(parseChunks(nonce, concat(pieces), cuts)).toEqual(expected);
      },
      { runs: 300, size: 20 },
    ));

  test("a message survives a program's unterminated sequence before it", () =>
    assertRexProperty(
      "terminal stream finds a message after an unterminated lookalike",
      Arbitrary.all([nonceArbitrary, shortText]),
      ([nonce, junk]) => {
        const exit = rexSequence(nonce, JSON.stringify({ type: "child_exited", exit_code: 3 }));
        const bytes = encoder.encode(`\u001b_rex1;${junk.replaceAll("\u001b", "")}${exit}after`);
        const parsed = parseChunks(nonce, bytes, []);
        expect(parsed.filter((item) => item._tag === "Message")).toEqual([
          { _tag: "Message", message: { type: "child_exited", exitCode: 3 } },
        ]);
      },
      { runs: 100 },
    ));
});
