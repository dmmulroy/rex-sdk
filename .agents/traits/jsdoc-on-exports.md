---
name: jsdoc-on-exports
subject: JSDoc coverage of JavaScript and TypeScript declarations.
requirement: Every exported symbol, and every public method and property of an
  exported class, has a `/** ... */` JSDoc comment attached to its original
  declaration. Exported object fields whose meaning goes beyond their names and
  types have their own field JSDoc.
applicability: Re-exports rely on the original declaration's documentation; each
  declaration is documented once, with explicit text rather than inheritance
  tags such as `@inheritDoc`. Private and internal code is documented when safe
  maintenance depends on a non-obvious purpose, invariant, domain rule, side
  effect, trade-off, or safety justification.
purpose: Puts the caller-visible facts where a search for the symbol lands.
---
