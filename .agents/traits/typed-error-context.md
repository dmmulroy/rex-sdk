---
name: typed-error-context
subject: Typed error classes and the values they carry.
requirement: "Typed errors carry diagnostic context as structured fields: a
  stable machine-readable code or tagged-error discriminant, the operation that
  failed, safe domain identifiers when known, a classified reason, field
  violations and accepted constraints for caller-correctable input, retryability
  or recovery guidance, and a request identifier at public boundaries. Internal
  errors also preserve an underlying cause when it adds diagnostic value and can
  be retained safely."
applicability: Include each field when it applies to the error; a field that
  cannot be known for that failure may be omitted.
purpose: Lets traces, logs, and recovery logic use typed data instead of parsing prose.
---
