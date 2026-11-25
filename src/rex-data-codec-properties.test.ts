/**
 * Property checks of the data handshake byte layouts: HELLO and RESUME encode exactly the
 * documented layout for every input, and decoding WELCOME and REJECT is total over every byte
 * string, accepting exactly the documented shapes.
 */
import { Arbitrary, Option, Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";
import {
  decodeRexDataHandshakeReply,
  encodeRexDataHello,
  encodeRexDataResume,
} from "./rex-data-codec.ts";
import { assertRexProperty } from "./testing/rex-property.ts";

const byte = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }));
const bytesOf = (length: number) =>
  Arbitrary.schema(Schema.Array(byte).check(Schema.isBetweenLength(length, length))).pipe(
    Arbitrary.map((values) => Uint8Array.from(values)),
  );
const anyBytes = Arbitrary.schema(Schema.Array(byte).check(Schema.isMaxLength(48))).pipe(
  Arbitrary.map((values) => Uint8Array.from(values)),
);
const u64 = Arbitrary.schema(
  Schema.BigInt.check(Schema.isBetweenBigInt({ minimum: 0n, maximum: 2n ** 64n - 1n })),
);
const u32 = Arbitrary.schema(
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 ** 32 - 1 })),
);

const ticketPattern = /^[A-Za-z0-9_-]{22}$/;

describe("HELLO", () => {
  test("a ticket of 16 bytes becomes 0x01 and those bytes", () =>
    assertRexProperty("HELLO carries the ticket's bytes", bytesOf(16), (ticket) => {
      const hello = encodeRexDataHello(Buffer.from(ticket).toString("base64url"));
      expect(hello).toEqual(Option.some(Uint8Array.from([0x01, ...ticket])));
    }));

  test("any other string is refused, and nothing longer or shorter is ever sent", () =>
    assertRexProperty(
      "HELLO refuses malformed tickets",
      Arbitrary.schema(Schema.String),
      (ticket) => {
        const hello = encodeRexDataHello(ticket);
        expect(Option.isSome(hello)).toBe(ticketPattern.test(ticket));
        if (Option.isSome(hello)) {
          expect(hello.value.length).toBe(17);
          expect(hello.value[0]).toBe(0x01);
        }
      },
      { runs: 300 },
    ));
});

describe("RESUME", () => {
  test("is 0x02, the token, and the byte count in little-endian, for every count", () =>
    assertRexProperty("RESUME layout", Arbitrary.all([bytesOf(16), u64]), ([token, count]) => {
      const resume = Buffer.from(encodeRexDataResume(token, count));
      expect(resume.length).toBe(25);
      expect(resume[0]).toBe(0x02);
      expect(Array.from(resume.subarray(1, 17))).toEqual(Array.from(token));
      expect(resume.readBigUInt64LE(17)).toBe(count);
    }));
});

/** A WELCOME as the server writes it. */
function welcome(token: Uint8Array, retention: number, nonce: bigint, padding: Uint8Array) {
  const message = Buffer.alloc(32);
  message[0] = 0x81;
  Buffer.from(token).copy(message, 1);
  Buffer.from(padding).copy(message, 17);
  message.writeUInt32LE(retention, 20);
  message.writeBigUInt64LE(nonce, 24);
  return new Uint8Array(message);
}

describe("WELCOME and REJECT", () => {
  test("a WELCOME decodes to its token, retention, and nonce", () =>
    assertRexProperty(
      "WELCOME decodes",
      Arbitrary.all([bytesOf(16), u32, u64, bytesOf(3)]),
      ([token, retention, nonce, padding]) => {
        const reply = decodeRexDataHandshakeReply(welcome(token, retention, nonce, padding));
        // A zero nonce would make every program's sequence look like Rex's, so it is refused.
        expect(reply).toEqual(
          nonce === 0n
            ? Option.none()
            : Option.some({
                _tag: "Welcome",
                reconnectToken: token,
                retentionMillis: retention,
                nonce,
              }),
        );
      },
    ));

  test("a REJECT decodes to its reason byte, whatever follows it", () =>
    assertRexProperty(
      "REJECT decodes",
      Arbitrary.all([Arbitrary.schema(byte), anyBytes]),
      ([reason, rest]) => {
        expect(decodeRexDataHandshakeReply(Uint8Array.from([0x82, reason, ...rest]))).toEqual(
          Option.some({ _tag: "Reject", reason }),
        );
      },
    ));

  test("decoding never throws, and accepts only the documented shapes", () =>
    assertRexProperty(
      "handshake reply decoding is total",
      anyBytes,
      (message) => {
        const reply = decodeRexDataHandshakeReply(message);
        const isReject = message[0] === 0x82 && message.length >= 2;
        const isWelcome =
          message[0] === 0x81 &&
          message.length === 32 &&
          Buffer.from(message).readBigUInt64LE(24) !== 0n;
        expect(Option.map(reply, (value) => value._tag)).toEqual(
          isReject ? Option.some("Reject") : isWelcome ? Option.some("Welcome") : Option.none(),
        );
      },
      { runs: 500 },
    ));
});
