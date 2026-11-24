/**
 * Terminal text, activity, watches, and waits, against a scripted terminal on the test server.
 */
import { Effect, Exit, Fiber, Option, Schema, Stream } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { BlockId, SessionId } from "./rex-domain.ts";
import { RexSdk } from "./rex-sdk.ts";
import type { RexTerminalActivity } from "./rex-terminal-activity.ts";
import { makeRexTerminalText } from "./rex-terminal-text.ts";
import type { RexTerminalFrame } from "./rex-terminal-watch.ts";
import { runRexSdkTest } from "./testing/rex-test-runtime.ts";
import { startRexTestTerminal } from "./testing/rex-test-terminal.ts";

const sessionId = SessionId.make("session:01a1aaaa-0000-0000-0000-000000000001");
const blockId = BlockId.make("block:01a1bbbb-0000-0000-0000-000000000001");
const target = { sessionId, blockId };

const decodeBlobReadOffset = Schema.decodeUnknownSync(
  Schema.Struct({ args: Schema.Struct({ offset: Schema.Number }) }),
);

const failureTags = <A, E extends { readonly _tag: string }>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.map((reason) => (reason._tag === "Fail" ? reason.error._tag : reason._tag))
    : ["Success"];

describe("readTail", () => {
  test("reads only the end of long output, with exact offsets, from one snapshot", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        const lines = Array.from({ length: 4_000 }, (_, index) => `line ${index} ✓`);
        const terminal = startRexTestTerminal(server, target, { content: lines.join("\n") });
        const rex = yield* RexSdk;
        const tail = yield* rex.terminals.readTail(target, { maxBytes: 1_000 });
        const full = makeRexTerminalText(terminal.content());
        expect(tail.truncated).toBe(true);
        expect(tail.lines.length).toBeGreaterThan(50);
        expect(tail.lines.at(-1)).toBe("line 3999 ✓");
        // Each line's offset is its offset in the whole output.
        const first = full.lines.length - tail.lines.length;
        expect(tail.lines).toEqual(full.lines.slice(first));
        expect(tail.lineOffsets).toEqual(full.lineOffsets.slice(first));
        // The first part, then one jump to the end: the long middle is never read.
        const blobReads = server.requestsFor("com.superlogical.terminal.blob_read");
        expect(blobReads.length).toBe(1);
      }),
    ));

  test("keeps only the last maxBytes when the first part overlaps the tail", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        // 500 bytes ending with a unique marker line, then exactly 1,000 bytes of tail lines.
        const head = `${"h".repeat(480)}\nMARKER-BEFORE-TAIL\n`;
        const tailLines = Array.from(
          { length: 100 },
          (_, index) => `tail ${String(index).padStart(4, "0")}${index === 0 ? "!" : ""}`,
        );
        const tailContent = tailLines.join("\n");
        expect([Buffer.byteLength(head), Buffer.byteLength(tailContent)]).toEqual([500, 1_000]);
        startRexTestTerminal(server, target, { content: head + tailContent });
        const rex = yield* RexSdk;
        const tail = yield* rex.terminals.readTail(target, { maxBytes: 1_000 });
        expect(tail.lines).not.toContain("MARKER-BEFORE-TAIL");
        expect(tail.truncated).toBe(true);
        // The line that starts exactly at the cutoff is whole, so it stays.
        expect(tail.lines).toEqual(tailLines);
        expect(tail.lineOffsets).toEqual(makeRexTerminalText(tailContent, 500).lineOffsets);
        expect(tail.lineOffsets[0]).toBe(500);
      }),
    ));

  // A window over half the output overlaps the first part; a smaller one jumps to the end.
  for (const [path, rows, line, jumps] of [
    ["an overlapping first part", 60, 10, false],
    ["a jump to the end", 400, 380, true],
  ] as const) {
    test(`drops a line cut inside a multibyte character and keeps one starting at the cutoff, after ${path}`, () =>
      runRexSdkTest((server) =>
        Effect.gen(function* () {
          const content = Array.from({ length: rows }, (_, index) => `✓✓ row ${index} ✓`).join(
            "\n",
          );
          const total = Buffer.byteLength(content);
          const full = makeRexTerminalText(content);
          startRexTestTerminal(server, target, { content });
          const rex = yield* RexSdk;
          const lineStart = full.lineOffsets[line] ?? 0;
          const expectFrom = (first: number) => ({
            lines: full.lines.slice(first),
            lineOffsets: full.lineOffsets.slice(first),
            truncated: true,
          });

          // One byte into the line's first ✓: the line is cut, so it is left out.
          const insideCharacter = yield* rex.terminals.readTail(target, {
            maxBytes: total - (lineStart + 1),
          });
          expect(insideCharacter).toEqual(expectFrom(line + 1));
          // Exactly at the line's start: the whole line is kept.
          const atLineStart = yield* rex.terminals.readTail(target, {
            maxBytes: total - lineStart,
          });
          expect(atLineStart).toEqual(expectFrom(line));

          // A jump reads from one byte before the window; otherwise reading continues past the first part.
          const offsets = server
            .requestsFor("com.superlogical.terminal.blob_read")
            .map((request) => decodeBlobReadOffset(request.payload).args.offset);
          if (jumps) expect(offsets).toEqual([lineStart, lineStart - 1]);
          else expect(offsets.every((offset) => offset > lineStart)).toBe(true);
        }),
      ));
  }

  test("keeps exact offsets across parts when the jump lands inside a character", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        const content = Array.from(
          { length: 25_000 },
          (_, index) => `${"✓".repeat(20)} row ${index}`,
        ).join("\n");
        const total = Buffer.byteLength(content);
        const full = makeRexTerminalText(content);
        startRexTestTerminal(server, target, { content });
        const rex = yield* RexSdk;
        const line = 15_000;
        const lineStart = full.lineOffsets[line] ?? 0;
        // The window starts at the line's second ✓, so the jump lands on the first ✓'s last byte,
        // and the tail is larger than one 512 KiB part.
        const maxBytes = total - (lineStart + 3);
        expect(maxBytes).toBeGreaterThan(524_288);
        const tail = yield* rex.terminals.readTail(target, { maxBytes });
        expect(tail).toEqual({
          lines: full.lines.slice(line + 1),
          lineOffsets: full.lineOffsets.slice(line + 1),
          truncated: true,
        });
        const offsets = server
          .requestsFor("com.superlogical.terminal.blob_read")
          .map((request) => decodeBlobReadOffset(request.payload).args.offset);
        // Two steps back to the ✓'s first byte, then whole parts from there.
        expect(offsets.slice(0, 3)).toEqual([lineStart + 2, lineStart + 1, lineStart]);
        expect(offsets.length).toBeGreaterThan(3);
      }),
    ));

  test("counts trimmed trailing spaces in line offsets", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        const content = Array.from({ length: 200 }, (_, index) => `row ${index}   `).join("\n");
        startRexTestTerminal(server, target, { content });
        const rex = yield* RexSdk;
        const tail = yield* rex.terminals.readTail(target, { maxBytes: 600 });
        const lastStart = Buffer.byteLength(content) - Buffer.byteLength("row 199   ");
        expect(tail.lines.at(-1)).toBe("row 199");
        expect(tail.lineOffsets.at(-1)).toBe(lastStart);
      }),
    ));

  test("returns all of a snapshot that fits in maxBytes, untruncated", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        const content = Array.from(
          { length: 100 },
          (_, index) => `fits ${String(index).padStart(4, "0")}`,
        ).join("\n");
        expect(Buffer.byteLength(content)).toBe(999);
        startRexTestTerminal(server, target, { content });
        const rex = yield* RexSdk;
        expect(yield* rex.terminals.readTail(target, { maxBytes: 999 })).toEqual(
          makeRexTerminalText(content),
        );
        expect(yield* rex.terminals.readTail(target, { maxBytes: 1_000 })).toEqual(
          makeRexTerminalText(content),
        );
      }),
    ));

  test("reads short output in one request", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        startRexTestTerminal(server, target, { content: "$ ls\nREADME.md\n$ " });
        const rex = yield* RexSdk;
        const tail = yield* rex.terminals.readTail(target);
        expect(tail).toEqual(makeRexTerminalText("$ ls\nREADME.md\n$ "));
        expect(server.requestsFor("com.superlogical.terminal.format")[0]?.payload).toMatchObject({
          args: { trim: true, unwrap: true, max_bytes: 65_536 },
        });
        expect(server.requestsFor("com.superlogical.terminal.blob_read")).toEqual([]);
      }),
    ));
});

describe("activity", () => {
  test("is Ready after the snapshot, then counts output and reports the exit", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        const terminal = startRexTestTerminal(server, target);
        const rex = yield* RexSdk;
        const items: RexTerminalActivity[] = [];
        const fiber = yield* Effect.forkChild(
          Stream.runForEach(rex.terminals.activity(target), (item) =>
            Effect.sync(() => items.push(item)),
          ),
        );
        yield* Effect.sleep("100 millis");
        terminal.print("hello\n");
        terminal.exit(0);
        yield* Effect.sleep("100 millis");
        yield* Fiber.interrupt(fiber);
        // The snapshot's bytes are not output.
        expect(items).toEqual([
          { _tag: "Ready" },
          { _tag: "Output", bytes: 6 },
          { _tag: "Exited", exitCode: 0 },
        ]);
      }),
    ));

  test("shares one data connection per block, and closes it after the last subscriber", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        const terminal = startRexTestTerminal(server, target);
        const rex = yield* RexSdk;
        const firstItems: RexTerminalActivity[] = [];
        const secondItems: RexTerminalActivity[] = [];
        const first = yield* Effect.forkChild(
          Stream.runForEach(rex.terminals.activity(target), (item) =>
            Effect.sync(() => firstItems.push(item)),
          ),
        );
        const second = yield* Effect.forkChild(
          Stream.runForEach(rex.terminals.activity(target), (item) =>
            Effect.sync(() => secondItems.push(item)),
          ),
        );
        yield* Effect.sleep("100 millis");
        terminal.print("x");
        yield* Effect.sleep("100 millis");
        expect(firstItems).toEqual([{ _tag: "Ready" }, { _tag: "Output", bytes: 1 }]);
        expect(secondItems).toEqual(firstItems);
        expect(server.requestsFor("data.connect").length).toBe(1);

        yield* Fiber.interrupt(first);
        yield* Fiber.interrupt(second);
        yield* Effect.sleep("50 millis");
        // A new subscriber opens a new connection, which the server accepts: the old one closed.
        const again = yield* Stream.runHead(rex.terminals.activity(target));
        expect(again).toEqual(Option.some({ _tag: "Ready" }));
        expect(server.requestsFor("data.connect").length).toBe(2);
      }),
    ));

  test("a subscriber that joins after the exit hears it right after Ready", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        const terminal = startRexTestTerminal(server, target);
        const rex = yield* RexSdk;
        const first = yield* Effect.forkChild(Stream.runDrain(rex.terminals.activity(target)));
        yield* Effect.sleep("100 millis");
        terminal.exit(4);
        yield* Effect.sleep("50 millis");
        const late = yield* Stream.runCollect(Stream.take(rex.terminals.activity(target), 2));
        expect(late).toEqual([{ _tag: "Ready" }, { _tag: "Exited", exitCode: 4 }]);
        yield* Fiber.interrupt(first);
      }),
    ));
});

describe("watch", () => {
  test("reads at the start, again after output, not while quiet, and last after the exit", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        const terminal = startRexTestTerminal(server, target, { content: "$ " });
        const rex = yield* RexSdk;
        const frames: RexTerminalFrame[] = [];
        const fiber = yield* Effect.forkChild(
          Stream.runForEach(rex.terminals.watch(target, { settle: "20 millis" }), (frame) =>
            Effect.sync(() => frames.push(frame)),
          ),
        );
        yield* Effect.sleep("150 millis");
        expect(frames.map((frame) => frame.text.lines)).toEqual([["$"]]);
        const readsWhileQuiet = terminal.reads();
        yield* Effect.sleep("200 millis");
        expect(terminal.reads()).toBe(readsWhileQuiet);

        terminal.print("one\n");
        terminal.print("two\n");
        yield* Effect.sleep("150 millis");
        // The burst settles into one read.
        expect(frames.at(-1)?.text.lines).toEqual(["$ one", "two"]);
        expect(terminal.reads()).toBe(readsWhileQuiet + 1);

        terminal.print("done\n");
        terminal.exit(0);
        yield* Fiber.join(fiber);
        expect(frames.at(-1)).toMatchObject({
          text: { lines: ["$ one", "two", "done"] },
          exit: Option.some(0),
        });
      }),
    ));

  test("a program that already exited gives one frame with its exit", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        startRexTestTerminal(server, target, { content: "done", exitedWith: 2 });
        const rex = yield* RexSdk;
        const frames = yield* Stream.runCollect(rex.terminals.watch(target));
        expect(frames).toEqual([{ text: makeRexTerminalText("done"), exit: Option.some(2) }]);
      }),
    ));
});

describe("waitForOutput", () => {
  test("with a mark, matches only output the command printed, not earlier output or its echo", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        const terminal = startRexTestTerminal(server, target, {
          content: "$ make test\nPASS\n$ ",
        });
        const rex = yield* RexSdk;
        const mark = yield* rex.terminals.mark(target);
        yield* rex.terminals.writeLine(target, "make test PASS");
        const wait = yield* Effect.forkChild(
          rex.terminals.waitForOutput(
            target,
            { pattern: /PASS/, since: mark },
            { settle: "10 millis", timeout: "2 seconds" },
          ),
        );
        yield* Effect.sleep("200 millis");
        // Neither the earlier PASS nor the typed command counts.
        expect(Option.isNone(yield* Fiber.await(wait).pipe(Effect.timeoutOption("1 millis")))).toBe(
          true,
        );
        terminal.print("ok 1\nPASS 1/1\n$ ");
        expect(yield* Fiber.join(wait)).toEqual({
          line: "PASS 1/1",
          text: "PASS",
          groups: [],
          alignment: Option.some("offset"),
        });
      }),
    ));

  test("without a mark, output already on screen matches at once", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        startRexTestTerminal(server, target, { content: "ready on :3000\n" });
        const rex = yield* RexSdk;
        const found = yield* rex.terminals.waitForOutput(target, /on :(\d+)/);
        expect(found.groups).toEqual(["3000"]);
      }),
    ));

  test("fails with RexTerminalExited when the program exits without a match", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        const terminal = startRexTestTerminal(server, target, { content: "" });
        const rex = yield* RexSdk;
        const wait = yield* Effect.forkChild(
          Effect.exit(rex.terminals.waitForOutput(target, "never", { settle: "10 millis" })),
        );
        yield* Effect.sleep("100 millis");
        terminal.print("error: no such file\n");
        terminal.exit(1);
        const exit = yield* Fiber.join(wait);
        expect(failureTags(exit)).toEqual(["RexTerminalExited"]);
      }),
    ));

  test("fails with RexRequestTimeout when the timeout passes first", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        startRexTestTerminal(server, target);
        const rex = yield* RexSdk;
        const exit = yield* Effect.exit(
          rex.terminals.waitForOutput(target, "never", { timeout: "150 millis" }),
        );
        expect(failureTags(exit)).toEqual(["RexRequestTimeout"]);
      }),
    ));

  test("concurrent waits on one block share its data connection", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        const terminal = startRexTestTerminal(server, target, { content: "" });
        const rex = yield* RexSdk;
        const waits = yield* Effect.forkChild(
          Effect.all(
            [
              rex.terminals.waitForOutput(target, "alpha", { settle: "10 millis" }),
              rex.terminals.waitForOutput(target, "beta", { settle: "10 millis" }),
              rex.terminals.waitForQuiet(target, { quietFor: "300 millis" }),
            ],
            { concurrency: "unbounded" },
          ),
        );
        yield* Effect.sleep("100 millis");
        terminal.print("alpha\nbeta\n");
        const [alpha, beta] = yield* Fiber.join(waits);
        expect([alpha.line, beta.line]).toEqual(["alpha", "beta"]);
        expect(server.requestsFor("data.connect").length).toBe(1);
      }),
    ));
});

describe("waitForQuiet", () => {
  test("returns once the program writes nothing for quietFor", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        const terminal = startRexTestTerminal(server, target);
        const rex = yield* RexSdk;
        const started = Date.now();
        const wait = yield* Effect.forkChild(
          rex.terminals.waitForQuiet(target, { quietFor: "150 millis" }),
        );
        for (let tick = 0; tick < 4; tick++) {
          yield* Effect.sleep("80 millis");
          terminal.print(".");
        }
        yield* Fiber.join(wait);
        // Still busy for 320 ms, then quiet for 150 ms.
        expect(Date.now() - started).toBeGreaterThanOrEqual(450);
      }),
    ));

  test("fails with RexRequestTimeout when output never stops", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        const terminal = startRexTestTerminal(server, target);
        const rex = yield* RexSdk;
        const printer = yield* Effect.forkChild(
          Effect.forever(
            Effect.andThen(
              Effect.sleep("20 millis"),
              Effect.sync(() => terminal.print(".")),
            ),
          ),
        );
        const exit = yield* Effect.exit(
          rex.terminals.waitForQuiet(target, { quietFor: "100 millis", timeout: "300 millis" }),
        );
        yield* Fiber.interrupt(printer);
        expect(failureTags(exit)).toEqual(["RexRequestTimeout"]);
      }),
    ));
});
