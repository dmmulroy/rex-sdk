---
name: cohesive-extraction
subject: Refactors that extract functions, modules, or helpers to reduce complexity.
requirement: Each extraction moves one cohesive responsibility, a group of steps
  that change together and can be named for what they accomplish, into a unit
  named for that responsibility. The extracted unit keeps the precise domain
  types of its inputs and outputs, its expected error types, its Effect
  requirements, any transaction boundaries, and the order in which its effects
  run.
applicability: An extraction does not simplify a design when it only lowers a
  branch or line count, adds a helper that forwards its arguments unchanged to
  another function, adds a generic type parameter or options object for callers
  that do not exist yet, replaces a readable conditional with a lookup table, or
  adds a lint suppression. Remove an option, parameter, or export only after
  finding every caller and confirming none relies on it.
purpose: Makes code genuinely simpler instead of only moving complexity around.
---
Cohesive: one named responsibility with its real types.

```ts
const renewSubscription = Effect.fn("renewSubscription")(function* (subscription: ActiveSubscription) {
  const invoice = yield* chargeRenewal(subscription);
  return yield* recordRenewal(subscription, invoice);
});
```

Not cohesive: a forwarding helper and an options object added only to shorten the caller.

```ts
const run = (input: unknown, options: { readonly mode?: string } = {}) => process(input, options);
```