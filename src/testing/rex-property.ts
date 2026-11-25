/**
 * Property checks for tests, on Effect's native `Arbitrary` engine.
 *
 * A property body may assert with `expect`, return `false`, or fail its Effect: all three count as
 * a falsification, so the engine shrinks the input to a small counterexample and the test fails
 * with it and a replay token. Defects inside the body count too, because a property that crashes
 * on some input is falsified by it.
 *
 * Budgets scale with the environment, so CI runs a quick pass and a deep run is one variable away:
 *
 * - `REX_PROPERTY_SCALE` multiplies every property's run count (default 1).
 * - `REX_PROPERTY_SEED` fixes the seed of every property; without it each run picks a new one.
 * - `REX_PROPERTY_REPLAY` replays one failure: `<property name>=<replay token>`, as a failure
 *   message prints it.
 *
 * @since 0.1.0
 */
import { Arbitrary, Cause, Effect, Exit } from "effect";

/**
 * Runs for a property: `base` times `REX_PROPERTY_SCALE`, at least 1.
 *
 * @category utils
 * @since 0.1.0
 */
export function rexPropertyRuns(base: number): number {
  const scale = Number(process.env["REX_PROPERTY_SCALE"] ?? "1");
  return Math.max(1, Math.round(base * (Number.isFinite(scale) && scale > 0 ? scale : 1)));
}

/** Options for one property check. */
export interface RexPropertyOptions {
  /** Runs before `REX_PROPERTY_SCALE`; defaults to 100. */
  readonly runs?: number | undefined;
  /** Largest generated size; defaults to the engine's. */
  readonly size?: number | undefined;
  /** Shrink candidates to try after a failure; defaults to the engine's. */
  readonly maxShrinks?: number | undefined;
  /** Rejected candidates allowed before the check is exhausted. */
  readonly maxDiscards?: number | undefined;
  /**
   * Longest one run may take before it counts as a falsification, so a hang shrinks like any
   * other failure; defaults to 10 seconds.
   */
  readonly runTimeoutMillis?: number | undefined;
}

/** Why a property body failed, kept for the failure message. */
class RexPropertyFailure {
  readonly _tag = "RexPropertyFailure";
  readonly reason: string;
  constructor(reason: string) {
    this.reason = reason;
  }
}

function describeThrown(thrown: unknown): string {
  if (thrown instanceof Error) return `${thrown.name}: ${thrown.message}`;
  return String(thrown);
}

function replayFor(name: string): string | undefined {
  const replay = process.env["REX_PROPERTY_REPLAY"];
  if (replay === undefined) return undefined;
  const separator = replay.indexOf("=");
  return separator > 0 && replay.slice(0, separator) === name
    ? replay.slice(separator + 1)
    : undefined;
}

function seedOption(): { readonly seed?: string } {
  const seed = process.env["REX_PROPERTY_SEED"];
  return seed === undefined || seed.length === 0 ? {} : { seed };
}

/**
 * Checks that `property` holds for every value `arbitrary` generates, failing with the shrunk
 * counterexample otherwise.
 *
 * @param name - Names the property in failures and in `REX_PROPERTY_REPLAY`.
 * @returns An Effect that dies with a readable failure when the property is falsified.
 * @category utils
 * @since 0.1.0
 */
export function checkRexProperty<A, E, R>(
  name: string,
  arbitrary: Arbitrary.Arbitrary<A>,
  property: (value: A) => void | boolean | Effect.Effect<unknown, E, R>,
  options: RexPropertyOptions = {},
): Effect.Effect<void, never, R> {
  const body = (value: A): Effect.Effect<boolean, RexPropertyFailure, R> =>
    Effect.suspend((): Effect.Effect<boolean, RexPropertyFailure, R> => {
      const outcome = property(value);
      if (outcome === undefined || typeof outcome === "boolean") {
        return Effect.succeed(outcome !== false);
      }
      return Effect.flatMap(
        Effect.exit(outcome),
        (exit): Effect.Effect<boolean, RexPropertyFailure> => {
          if (Exit.isSuccess(exit)) return Effect.succeed(exit.value !== false);
          if (Cause.hasInterruptsOnly(exit.cause)) return Effect.interrupt;
          return Effect.fail(new RexPropertyFailure(Cause.pretty(exit.cause)));
        },
      );
    }).pipe(
      Effect.catchDefect((defect) => Effect.fail(new RexPropertyFailure(describeThrown(defect)))),
      Effect.timeoutOrElse({
        duration: options.runTimeoutMillis ?? 10_000,
        orElse: () =>
          Effect.fail(
            new RexPropertyFailure(
              `the run took longer than ${options.runTimeoutMillis ?? 10_000} ms`,
            ),
          ),
      }),
    );
  const replay = replayFor(name);
  return Arbitrary.checkEffect(arbitrary, body, {
    runs: rexPropertyRuns(options.runs ?? 100),
    size: options.size,
    maxShrinks: options.maxShrinks,
    maxDiscards: options.maxDiscards,
    ...seedOption(),
    ...(replay === undefined ? {} : { replay }),
  }).pipe(
    Effect.flatMap((result) => {
      if (result._tag === "Passed") return Effect.void;
      if (result._tag === "Falsified") {
        const reason =
          result.failure._tag === "ReturnedFalse" ? "returned false" : result.failure.error.reason;
        return Effect.die(
          new Error(
            [
              `Property "${name}" falsified after ${result.runs} run(s) and ${result.shrinks} shrink(s).`,
              `Shrunk input: ${formatValue(result.shrunkInput)}`,
              `Failure: ${reason}`,
              `Replay: REX_PROPERTY_REPLAY='${name}=${result.replay}'`,
            ].join("\n"),
          ),
        );
      }
      return Effect.die(
        new Error(`Property "${name}": ${Arbitrary.formatCheckFailure(result) ?? result._tag}`),
      );
    }),
  );
}

/**
 * {@link checkRexProperty} for a property without requirements, as a Promise for `test`.
 *
 * @category utils
 * @since 0.1.0
 */
export function assertRexProperty<A, E>(
  name: string,
  arbitrary: Arbitrary.Arbitrary<A>,
  property: (value: A) => void | boolean | Effect.Effect<unknown, E>,
  options: RexPropertyOptions = {},
): Promise<void> {
  return Effect.runPromise(checkRexProperty(name, arbitrary, property, options));
}

/**
 * Waits until `condition` holds, checking every millisecond, and dies after `timeoutMillis`.
 *
 * Stateful properties use it to step only once the system under test has observably caught up,
 * instead of sleeping for a guessed time.
 *
 * @category utils
 * @since 0.1.0
 */
export function waitForRexCondition(
  description: string,
  condition: () => boolean,
  timeoutMillis = 2000,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const deadline = Date.now() + timeoutMillis;
    while (!condition()) {
      if (Date.now() > deadline) {
        return yield* Effect.die(new Error(`Timed out waiting until ${description}`));
      }
      yield* Effect.sleep("1 millis");
    }
  });
}

/** Formats a counterexample: JSON where possible, with bytes and bigints spelled out. */
export function formatValue(value: unknown): string {
  try {
    return JSON.stringify(
      value,
      (_key, inner: unknown) => {
        if (inner instanceof Uint8Array) return `bytes[${Array.from(inner).join(",")}]`;
        if (typeof inner === "bigint") return `${inner}n`;
        return inner;
      },
      2,
    );
  } catch {
    return String(value);
  }
}
