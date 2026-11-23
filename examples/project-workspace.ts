/**
 * Opens a project session with an editor beside a shell, runs the tests in a background tab,
 * and reports their exit code. Run with `node examples/project-workspace.ts <project-dir>`.
 */
import { Effect } from "effect";
import { RexSdk, rexLayout, rexSdkLayer } from "../src/index.ts";

const projectDirectory = process.argv[2] ?? process.cwd();

const program = Effect.gen(function* () {
  const rex = yield* RexSdk;

  const session = yield* rex.sessions.create({
    label: "my-project",
    initialWindows: [
      {
        windowLabel: "Code",
        layout: rexLayout.horizontal(
          rexLayout.terminal({ cwd: projectDirectory, command: ["nvim"], label: "editor" }),
          rexLayout.terminal({ cwd: projectDirectory, label: "shell" }),
          0.7,
        ),
      },
    ],
  });

  const tests = yield* rex.windows.create({
    sessionId: session.sessionId,
    windowLabel: "Tests",
    focus: false,
    layout: rexLayout.terminal({
      cwd: projectDirectory,
      command: ["npm", "test"],
      exit: { onCompletion: false },
    }),
  });
  const [testBlockId] = tests.blockIds;
  if (testBlockId === undefined) return;

  const target = { sessionId: session.sessionId, blockId: testBlockId };
  const exit = yield* rex.terminals.waitForExit(target, { timeout: "5 minutes" });
  const output = yield* rex.terminals.read(target, { trim: true });
  yield* Effect.log(`Tests exited with ${exit.exitCode}`, output.split("\n").slice(-5).join("\n"));
});

Effect.runPromise(program.pipe(Effect.provide(rexSdkLayer))).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
