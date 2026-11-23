---
name: effect-service-module-layout
subject: Modules that declare new Effect services.
requirement: "Each new Effect service lives in a file named for its capability
  and declares, in order: the service interface `I<CapabilityName>`, the
  contextual service class, the constructor `make<CapabilityName>`,
  `<capabilityName>LayerWithoutDependencies`, the production
  `<capabilityName>Layer`, and `<capabilityName>TestLayer`. Every exported
  symbol includes the capability name, and the same capability name is used
  consistently across all of them."
applicability: Export both Layer names even when the service has no production
  dependencies. The test Layer crosses the same service interface as production
  with complete, behaviorally honest implementations. Symbol names use the
  natural capability name, which need not end in `Service`, and avoid `Tag`.
purpose: Makes every service discoverable by name and wired the same way.
---
```ts
export interface IIssueService { readonly findIssue: (id: IssueId) => Effect.Effect<Issue, IssueNotFound> }
export class IssueService extends Context.Service<IssueService, IIssueService>()("@app/IssueService") {}
export const makeIssueService = Effect.gen(function* () { /* ... */ });
export const issueServiceLayerWithoutDependencies = Layer.effect(IssueService, makeIssueService);
export const issueServiceLayer = issueServiceLayerWithoutDependencies.pipe(Layer.provide(issueStoreLayer));
export const issueServiceTestLayer = issueServiceLayerWithoutDependencies.pipe(Layer.provide(issueStoreTestLayer));
```