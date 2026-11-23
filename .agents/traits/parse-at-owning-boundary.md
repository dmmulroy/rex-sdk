---
name: parse-at-owning-boundary
subject: Handling of external or persisted input such as request payloads,
  database rows, environment strings, files, queue messages, and vendor records.
requirement: The adapter that owns the boundary decodes untrusted input once,
  with a schema, into the strongest meaningful domain or application type, and
  owns the resulting parse errors. Domain modules and application services
  accept only parsed values, and data leaving the application is encoded back
  into the exact external representation the boundary requires.
purpose: Establishes runtime integrity at one place and keeps boundary
  representations out of inner modules.
---
TypeScript declarations and SQL generic annotations describe expected shapes; they do not prove them at runtime. Parsing produces a validated value, not a boolean followed by the original record.

```ts
const decodeCreateIssueCommand = Schema.decodeUnknownEffect(CreateIssueCommand);

const command = yield* decodeCreateIssueCommand(requestBody);
return yield* issueService.createIssue(command);
```