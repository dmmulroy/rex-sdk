---
name: jsdoc-effect-layout
subject: Structure, sections, examples, and tags of JSDoc comments.
requirement: "After the summary paragraph, JSDoc uses only these optional
  sections, in this order and only when they have useful content: `**When to
  use**` (starting with `Use when`, `Use to`, `Use as`, or `Use with`),
  `**Details**` (behavior, options, side effects, ownership, invariants,
  expected typed failures), `**Gotchas**` (concrete edge cases, preconditions,
  surprising behavior), and `**Example** (Title)` sections with exactly one `ts`
  code fence each and a short action-phrase title. Tags come last in the order
  `@deprecated`, `@template`, `@param`, `@returns`, `@throws`, `@default`,
  `@see`. Every function or method that can throw has `@throws` naming what it
  throws and when."
applicability: Add `@param`, `@returns`, and `@template` when they say something
  the names and types do not. `@see {@link symbol} for ...` points only to
  semantically related APIs. Examples use `**Example** (Title)` rather than
  `@example` or loose code fences. `@since`, `@stability`, and `@category` are
  omitted because the workspaces are private and unversioned. Sections are
  separated by single blank lines.
purpose: Gives every comment the same predictable shape, following Effect's own
  documentation style.
---
````ts
/**
 * Parses an email address received at an external input boundary.
 *
 * **When to use**
 *
 * Use when you hold raw form or request input and need an `EmailAddress` for inner modules.
 *
 * **Details**
 *
 * Trims surrounding whitespace before validating. Fails with `InvalidEmailAddress` when the
 * input is not a single address.
 *
 * **Example** (Parsing a submitted email address)
 *
 * ```ts
 * parseEmailAddress(" coach@example.com ") // => Result.succeed("coach@example.com")
 * ```
 *
 * @param input - Raw input received from outside the application.
 * @returns A validated email address, or `InvalidEmailAddress` when validation fails.
 * @see {@link formatEmailAddress} for encoding the address back for display.
 */
````