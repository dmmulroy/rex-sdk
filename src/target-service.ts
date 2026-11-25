/**
 * Looks up sessions, windows, blocks, and clients by ID, label, position, or short ID.
 *
 * @since 0.1.0
 */
import { Context, Effect, Layer, Option } from "effect";
import { RexAttachments } from "./rex-attachments.ts";
import { RexControl, type RexRequestOptions } from "./rex-control.ts";
import { rexCoreLayer } from "./rex-core.ts";
import type { BlockId, SessionId } from "./rex-domain.ts";
import type { RexConfigurationError, RexOperationError } from "./rex-errors.ts";
import { rexMethodOperation, type RexMethodOperation } from "./rex-operation.ts";

/**
 * Target lookup and completion.
 *
 * @category services
 * @since 0.1.0
 */
export interface ITargetService {
  /** `target.resolve`: looks up each query; each result says whether it matched one thing, nothing, or several. */
  readonly resolve: RexMethodOperation<"target.resolve">;
  /** `target.complete`: lists labels, window positions, and short IDs that start with a prefix. */
  readonly complete: RexMethodOperation<"target.complete">;
  /** The session that holds a block, or none when the block no longer exists. */
  readonly sessionForBlock: (
    blockId: BlockId,
    options?: RexRequestOptions,
  ) => Effect.Effect<Option.Option<SessionId>, RexOperationError>;
}

/**
 * Yieldable target service.
 *
 * @category services
 * @since 0.1.0
 */
export class TargetService extends Context.Service<TargetService, ITargetService>()(
  "rex-sdk/TargetService",
) {}

/**
 * Constructs target operations over the shared control connection.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeTargetService = Effect.gen(function* () {
  const control = yield* RexControl;
  const attachments = yield* RexAttachments;
  const resolve = rexMethodOperation(control, attachments, "target.resolve");
  const sessionForBlock = Effect.fn("TargetService.sessionForBlock")(function* (
    blockId: BlockId,
    options?: RexRequestOptions,
  ) {
    const { results } = yield* resolve({ kinds: ["block"], queries: [blockId] }, options);
    const result = results[0];
    if (result?.status !== "resolved") return Option.none<SessionId>();
    return Option.flatMap(result.target, (target) => target.sessionId);
  });
  return TargetService.of({
    resolve,
    complete: rexMethodOperation(control, attachments, "target.complete"),
    sessionForBlock,
  });
});

/**
 * Target operations, leaving the control connection requirements visible.
 *
 * @category layers
 * @since 0.1.0
 */
export const targetServiceLayerWithoutDependencies: Layer.Layer<
  TargetService,
  never,
  RexControl | RexAttachments
> = Layer.effect(TargetService, makeTargetService);

/**
 * Target operations over a control connection configured from the environment.
 *
 * @category layers
 * @since 0.1.0
 */
export const targetServiceLayer: Layer.Layer<TargetService, RexConfigurationError> =
  targetServiceLayerWithoutDependencies.pipe(Layer.provide(rexCoreLayer));
