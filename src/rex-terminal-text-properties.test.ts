/**
 * Property checks of terminal text, marks, and output queries.
 *
 * Lines and offsets are checked against `referenceRexTerminalTail`, which works from the output's
 * bytes alone. Marks are checked by modelling what happens to a terminal after one is made:
 * output is appended, scrollback is trimmed from the top, or only a window of the end is read.
 * Anchor lines and later output use different words, so a mark's anchor can't recur by chance;
 * a separate property allows recurrence and checks only what must hold anyway.
 */
import { Arbitrary, Option, Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { findRexOutputMatch, rexOutputQueryLines } from "./rex-output-query.ts";
import {
  linesSinceRexMark,
  makeRexTerminalText,
  markRexTerminalText,
  type RexTerminalText,
} from "./rex-terminal-text.ts";
import { assertRexProperty } from "./testing/rex-property.ts";
import { referenceRexTerminalTail } from "./testing/rex-test-terminal.ts";

/** Terminal content with the characters that make offsets hard: multibyte, blanks, CR, tabs. */
const contentArbitrary = Arbitrary.array(
  Arbitrary.schema(
    Schema.Literals(["a", "é", "✓", "😀", " ", "\t", "\r", "\n", "\n", "\u2028", "$ ", "\uFFFD"]),
  ),
  { maxLength: 60 },
).pipe(Arbitrary.map((parts) => parts.join("")));

/** Non-blank lines of words from `words`. */
const linesFrom = (words: ReadonlyArray<string>, maxLength: number) =>
  Arbitrary.array(
    Arbitrary.array(Arbitrary.schema(Schema.Literals(words)), { minLength: 1, maxLength: 3 }).pipe(
      Arbitrary.map((parts) => parts.join(" ")),
    ),
    { maxLength },
  );
/** Earlier lines are numbered, so each is unique and none can reappear in later output. */
const earlierLines = linesFrom(["make", "build", "~/app", "ok"], 14).pipe(
  Arbitrary.map((lines) => lines.map((line, index) => `${line} #${index}`)),
);
const laterLines = linesFrom(["PASS", "FAIL", "test", "✓"], 10);

/** Text read from `content`, as `format` with trim and unwrap returns it: from the start. */
const read = (content: string) => makeRexTerminalText(content);

describe("terminal text", () => {
  test("lines and offsets are exactly what the output's bytes say", () =>
    assertRexProperty(
      "terminal text matches the reference",
      Arbitrary.all([
        contentArbitrary,
        Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 }))),
      ]),
      ([content, start]) => {
        const text = makeRexTerminalText(content, start);
        const reference = referenceRexTerminalTail(content, Number.MAX_SAFE_INTEGER);
        expect(text.lines).toEqual(reference.lines);
        expect(text.lineOffsets).toEqual(reference.lineOffsets.map((offset) => offset + start));
        // Each line's bytes start at its offset; the next line starts after its newline.
        const bytes = Buffer.from(content);
        text.lines.forEach((line, index) => {
          const offset = (text.lineOffsets[index] ?? 0) - start;
          expect(bytes.subarray(offset).toString("utf8").startsWith(line)).toBe(true);
          expect(offset === 0 || bytes[offset - 1] === 0x0a).toBe(true);
        });
      },
      { runs: 300 },
    ));
});

/** The content of a terminal whose cursor line, the last non-blank line, is a prompt. */
const terminalArbitrary = Arbitrary.all({
  before: earlierLines,
  prompt: Arbitrary.schema(Schema.Literals(["$ ", "~/app $ ", "> "])),
  trailing: Arbitrary.schema(Schema.Literals(["", "\n", "\n\n", "  "])),
  typed: Arbitrary.schema(Schema.Literals(["", "make test", "ls -la"])),
  after: laterLines,
});

describe("marks", () => {
  test("after output is appended, exactly the new lines are since the mark, found by offset", () =>
    assertRexProperty(
      "mark after appended output",
      terminalArbitrary,
      ({ before, prompt, typed, after }) => {
        const history = [...before, prompt].join("\n");
        const mark = markRexTerminalText(read(history));
        const later = read(`${history}${typed}\n${after.join("\n")}`);
        const since = linesSinceRexMark(later, mark);
        expect(since.alignment).toBe("offset");
        // Everything after the cursor line, which holds the typed command.
        const cursor = read(history).lines.length - 1;
        expect(since.lines).toEqual(later.lines.slice(cursor + 1));
      },
      { runs: 300 },
    ));

  test("after scrollback is trimmed, the mark finds its anchor lines", () =>
    assertRexProperty(
      "mark after trimmed scrollback",
      Arbitrary.all([
        terminalArbitrary,
        Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
      ]),
      ([{ before, prompt, typed, after }, trimmed]) => {
        const history = [...before, prompt].join("\n");
        const original = read(history);
        const mark = markRexTerminalText(original);
        const fullLater = `${history}${typed}\n${after.join("\n")}`;
        const keptFrom = Math.min(trimmed, before.length);
        const laterLines = fullLater.split("\n").slice(keptFrom);
        const later = read(laterLines.join("\n"));
        const since = linesSinceRexMark(later, mark);
        const cursor = original.lines.length - 1 - keptFrom;
        // Enough anchor lines must survive the trim to recognize the place: three, or all of them.
        const surviving = Math.min(mark.anchor.length, cursor);
        const recognizable = surviving >= Math.min(mark.anchor.length, 3);
        if (recognizable && mark.anchor.length > 0) {
          expect(since.alignment).not.toBe("unaligned");
          expect(since.lines).toEqual(later.lines.slice(cursor + 1));
        } else {
          // Nothing proves where the mark was: either it is found exactly, or every line counts.
          expect(
            since.alignment === "unaligned"
              ? since.lines
              : since.lines.length <= later.lines.length,
          ).toBeTruthy();
        }
      },
      { runs: 300 },
    ));

  test("a window of the end finds the mark exactly when the window holds the cursor line", () =>
    assertRexProperty(
      "mark in a truncated window",
      Arbitrary.all([
        terminalArbitrary,
        Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 400 }))),
      ]),
      ([{ before, prompt, typed, after }, maxBytes]) => {
        const history = [...before, prompt].join("\n");
        const original = read(history);
        const mark = markRexTerminalText(original);
        const fullLater = `${history}${typed}\n${after.join("\n")}`;
        const window = referenceRexTerminalTail(fullLater, maxBytes);
        const since = linesSinceRexMark(window, mark);
        const cursorIndex = window.lineOffsets.indexOf(mark.offset);
        if (cursorIndex >= 0) {
          expect(since).toEqual({
            lines: window.lines.slice(cursorIndex + 1),
            alignment: "offset",
          });
        } else if (window.lineOffsets.every((offset) => offset > mark.offset)) {
          // The window starts after the cursor line: all of it is new output.
          expect(since.lines).toEqual(window.lines);
        }
      },
      { runs: 300 },
    ));

  test("whatever happened to the text, the lines since a mark are a suffix of it", () =>
    assertRexProperty(
      "lines since a mark are a suffix",
      Arbitrary.all([contentArbitrary, contentArbitrary, Arbitrary.schema(Schema.Boolean)]),
      ([first, second, truncated]) => {
        const mark = markRexTerminalText(read(first));
        const text = makeRexTerminalText(second, 0, truncated);
        const since = linesSinceRexMark(text, mark);
        expect(since.lines).toEqual(text.lines.slice(text.lines.length - since.lines.length));
        if (since.alignment === "unaligned") expect(since.lines).toEqual(text.lines);
      },
      { runs: 300 },
    ));
});

const patternArbitrary = Arbitrary.schema(Schema.Literals(["PASS", "FAIL", "✓", "test", " ", "x"]));

function bottomMost(lines: ReadonlyArray<string>, matches: (line: string) => boolean) {
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (line !== undefined && matches(line)) return Option.some(line);
  }
  return Option.none();
}

describe("output queries", () => {
  test("a substring query finds the bottom-most line containing it, among the query's lines", () =>
    assertRexProperty(
      "substring query",
      Arbitrary.all([
        laterLines,
        patternArbitrary,
        Arbitrary.schema(
          Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 12 }))),
        ),
      ]),
      ([lines, pattern, count]) => {
        const text: RexTerminalText = read(lines.join("\n"));
        const query = { pattern, lines: count };
        const searched = rexOutputQueryLines(text, query).lines;
        expect(searched).toEqual(
          count === undefined
            ? text.lines
            : text.lines.slice(Math.max(0, text.lines.length - count)),
        );
        expect(Option.map(findRexOutputMatch(text, query), (match) => match.line)).toEqual(
          bottomMost(searched, (line) => line.includes(pattern)),
        );
      },
      { runs: 300 },
    ));

  test("a regular expression matches line by line, the same on every call, whatever its flags", () =>
    assertRexProperty(
      "regex query",
      Arbitrary.all([
        laterLines,
        patternArbitrary,
        Arbitrary.schema(Schema.Literals(["", "g", "y", "gy", "i", "gi"])),
      ]),
      ([lines, word, flags]) => {
        const text = read(lines.join("\n"));
        const pattern = new RegExp(`(${word})$`, flags);
        const first = findRexOutputMatch(text, pattern);
        const second = findRexOutputMatch(text, pattern);
        expect(second).toEqual(first);
        const plain = new RegExp(`(${word})$`, flags.replace(/[gy]/g, ""));
        expect(Option.map(first, (match) => match.line)).toEqual(
          bottomMost(text.lines, (line) => plain.test(line)),
        );
        if (Option.isSome(first)) {
          expect(first.value.groups).toEqual([first.value.text]);
          expect(first.value.line.endsWith(first.value.text)).toBe(true);
        }
      },
      { runs: 300 },
    ));
});
