/**
 * Runs SDK tests against a fresh {@link startRexTestServer} with the full production Layer graph.
 *
 * Every test gets its own server and connection, and fails if the server recorded a contract
 * violation in either direction.
 *
 * @since 0.1.0
 */
import { Effect, Layer, Scope } from "effect";
import { expect } from "vite-plus/test";
import type { RexConfigOptions } from "../rex-config.ts";
import { RexSdk, rexSdkLayerFromOptions } from "../rex-sdk.ts";
import { RexControl } from "../rex-control.ts";
import {
  startRexTestServer,
  type IRexTestServer,
  type RexTestServerOptions,
} from "./rex-test-server.ts";

/** Options for {@link runRexSdkTest}. */
export interface RexSdkTestOptions {
  /** Options for the test server's welcome. */
  readonly server?: RexTestServerOptions | undefined;
  /** SDK options other than the server address. */
  readonly config?: Omit<RexConfigOptions, "server"> | undefined;
}

/**
 * Starts a test server, builds the SDK against it, runs `body`, and checks for violations.
 *
 * @category constructors
 * @since 0.1.0
 */
export function runRexSdkTest<A, E>(
  body: (server: IRexTestServer) => Effect.Effect<A, E, RexSdk | RexControl | Scope.Scope>,
  options: RexSdkTestOptions = {},
): Promise<A> {
  return Effect.runPromise(rexSdkTest(body, options));
}

/**
 * {@link runRexSdkTest} as an Effect, for property checks that start a server per run.
 *
 * @category constructors
 * @since 0.1.0
 */
export function rexSdkTest<A, E>(
  body: (server: IRexTestServer) => Effect.Effect<A, E, RexSdk | RexControl | Scope.Scope>,
  options: RexSdkTestOptions = {},
): Effect.Effect<A, unknown> {
  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* startRexTestServer(options.server);
      const layer: Layer.Layer<RexSdk | RexControl, unknown> = rexSdkLayerFromOptions({
        server: server.socketPath,
        client: { kind: "agent", name: "rex-sdk-test", version: "0.0.0" },
        ...options.config,
      });
      const result = yield* body(server).pipe(Effect.provide(layer));
      expect(server.violations()).toEqual([]);
      return result;
    }),
  );
}
