---
name: faithful-verification
subject: Tests and other verification of application behavior.
requirement: Tests exercise behavior through public interfaces with real or
  behaviorally faithful implementations, such as SQLite for SQLite behavior and
  controlled providers for external effects, and each check states exactly which
  behavior it proves.
applicability: "Dependencies are exercised through their service or runtime
  interface rather than by mocking their module. Parser API tests assert the
  complete public function type: input, arity, success, error, and Effect
  requirements."
purpose: Gives tests that catch real regressions rather than confirming mocks.
---
Cover valid migrations plus malformed-current and precedence failures, and construct independent cross-field corruption cases so the schema under test cannot manufacture its own evidence. Preserve interruption and uncertain outcomes, and prefer native restart evidence over reconstructed in-memory state.