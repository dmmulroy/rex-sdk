import { Option } from "effect";
import { describe, expect, test } from "vite-plus/test";
import {
  decodeRexDataHandshakeReply,
  encodeRexDataHello,
  encodeRexDataResume,
} from "./rex-data-codec.ts";
import { makeRexTerminalStreamParser, type RexTerminalStreamItem } from "./rex-terminal-stream.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const NONCE = 1234567890123n;
const rexMessage = (nonce: bigint, json: object) =>
  `\u001b_rex1;${nonce};${JSON.stringify(json)}\u001b\\`;

function render(items: ReadonlyArray<RexTerminalStreamItem>) {
  const result: Array<string | object> = [];
  for (const item of items) {
    if (item._tag === "Output") {
      const text = decoder.decode(item.bytes);
      const last = result.at(-1);
      if (typeof last === "string") result[result.length - 1] = last + text;
      else result.push(text);
    } else {
      result.push(item.message);
    }
  }
  return result;
}

function parseInChunks(input: string, splitAt: ReadonlyArray<number>) {
  const bytes = encoder.encode(input);
  const parser = makeRexTerminalStreamParser(NONCE);
  const items: Array<RexTerminalStreamItem> = [];
  let start = 0;
  for (const end of [...splitAt, bytes.length]) {
    items.push(...parser.push(bytes.slice(start, end)));
    start = end;
  }
  items.push(...parser.flush());
  return render(items);
}

describe("terminal stream parser", () => {
  const stream =
    "snapshot\r\n" +
    rexMessage(NONCE, {
      type: "resize",
      cols: 80,
      rows: 24,
      cell_width_px: 9,
      cell_height_px: 18,
      owner: null,
    }) +
    "$ ls\r\n" +
    rexMessage(NONCE, { type: "child_exited", exit_code: 2 }) +
    "after";

  const expected = [
    "snapshot\r\n",
    { type: "resize", cols: 80, rows: 24, cellWidthPx: 9, cellHeightPx: 18, owner: Option.none() },
    "$ ls\r\n",
    { type: "child_exited", exitCode: 2 },
    "after",
  ];

  test("separates output from Rex messages", () => {
    expect(parseInChunks(stream, [])).toEqual(expected);
  });

  test("gives the same result wherever the stream is split", () => {
    const length = encoder.encode(stream).length;
    for (let split = 1; split < length; split += 1) {
      expect(parseInChunks(stream, [split])).toEqual(expected);
    }
  });

  test("gives the same result when every byte arrives on its own", () => {
    const length = encoder.encode(stream).length;
    expect(
      parseInChunks(
        stream,
        Array.from({ length: length - 1 }, (_, index) => index + 1),
      ),
    ).toEqual(expected);
  });

  test("leaves a sequence with another nonce in the output, because a program printed it", () => {
    const forged = rexMessage(99n, { type: "child_exited", exit_code: 0 });
    expect(parseInChunks(`a${forged}b`, [])).toEqual([`a${forged}b`]);
  });

  test("leaves other APC sequences and escape sequences in the output", () => {
    const input = "\u001b[31mred\u001b[0m \u001b_Gf=100;AAAA\u001b\\ done";
    expect(parseInChunks(input, [3, 20])).toEqual([input]);
  });

  test("decodes theme messages and keeps unknown message types", () => {
    const input =
      rexMessage(NONCE, { type: "theme", foreground: "ffffff", palette: ["1=ff0000"] }) +
      rexMessage(NONCE, { type: "future", value: 1 });
    expect(parseInChunks(input, [])).toEqual([
      {
        type: "theme",
        foreground: Option.some("ffffff"),
        background: Option.none(),
        cursor: Option.none(),
        palette: ["1=ff0000"],
        scheme: Option.none(),
      },
      { type: "unknown", messageType: "future", message: { type: "future", value: 1 } },
    ]);
  });

  test("returns a trailing partial sequence as output when the stream ends", () => {
    expect(parseInChunks("x\u001b_rex1;123", [])).toEqual(["x\u001b_rex1;123"]);
  });
});

describe("data handshake codec", () => {
  test("encodes a HELLO from a base64url ticket", () => {
    const ticket = Buffer.from(Array.from({ length: 16 }, (_, index) => index)).toString(
      "base64url",
    );
    const hello = Option.getOrThrow(encodeRexDataHello(ticket));
    expect(hello.length).toBe(17);
    expect(hello[0]).toBe(0x01);
    expect(Array.from(hello.slice(1))).toEqual(Array.from({ length: 16 }, (_, index) => index));
  });

  test("rejects a ticket that is not 16 bytes of base64url", () => {
    expect(Option.isNone(encodeRexDataHello("short"))).toBe(true);
    expect(Option.isNone(encodeRexDataHello("!".repeat(22)))).toBe(true);
  });

  test("encodes a RESUME with the token and a little-endian byte count", () => {
    const token = new Uint8Array(16).fill(7);
    const resume = encodeRexDataResume(token, 0x0102030405n);
    expect(resume.length).toBe(25);
    expect(resume[0]).toBe(0x02);
    expect(Array.from(resume.slice(1, 17))).toEqual(Array(16).fill(7));
    expect(Array.from(resume.slice(17))).toEqual([5, 4, 3, 2, 1, 0, 0, 0]);
  });

  test("decodes WELCOME and REJECT, and refuses anything else", () => {
    const welcome = Buffer.alloc(32);
    welcome[0] = 0x81;
    welcome.fill(9, 1, 17);
    welcome.writeUInt32LE(60_000, 20);
    welcome.writeBigUInt64LE(NONCE, 24);
    expect(decodeRexDataHandshakeReply(new Uint8Array(welcome))).toEqual(
      Option.some({
        _tag: "Welcome",
        reconnectToken: new Uint8Array(16).fill(9),
        retentionMillis: 60_000,
        nonce: NONCE,
      }),
    );
    expect(decodeRexDataHandshakeReply(Uint8Array.of(0x82, 0x07))).toEqual(
      Option.some({ _tag: "Reject", reason: 7 }),
    );
    expect(Option.isNone(decodeRexDataHandshakeReply(new Uint8Array(31)))).toBe(true);
    const zeroNonce = Buffer.from(welcome);
    zeroNonce.writeBigUInt64LE(0n, 24);
    expect(Option.isNone(decodeRexDataHandshakeReply(new Uint8Array(zeroNonce)))).toBe(true);
  });
});
