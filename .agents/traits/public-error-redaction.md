---
name: public-error-redaction
subject: Public error responses produced by public adapters.
requirement: Public error responses contain a stable `code`, an
  operation-specific `message`, variant-specific safe `details`, a correlation
  `requestId`, and a truthful `retryable` value, and contain only data that is
  safe for the caller. Redaction keeps useful safe context such as the operation
  and the requested domain identifier.
applicability: Credentials, access assertions, JWT claims, raw request bodies,
  SQL, stack traces, private causes, and vendor response bodies are never safe
  for public output.
purpose: Gives callers a useful, correlatable error while protecting secrets and
  internals.
---
