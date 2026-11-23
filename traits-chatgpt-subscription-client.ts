import { OpenAiClient, OpenAiSchema } from "@effect/ai-openai";
import {
  Config,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  type PlatformError,
  Predicate,
  Schema,
} from "effect";
import {
  HttpBody,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

const chatGptCodexResponsesUrl = "https://chatgpt.com/backend-api/codex";
const bufferedCodexStreamAccept = "text/event-stream";
const defaultChatGptCodexInstructions = "Follow the user's instructions exactly.";

const PiChatGptSubscriptionAuth = Schema.fromJsonString(
  Schema.Struct({
    "openai-codex": Schema.Struct({
      access: Schema.NonEmptyString,
      accountId: Schema.NonEmptyString,
    }),
  }),
);
const decodePiChatGptSubscriptionAuth = Schema.decodeEffect(PiChatGptSubscriptionAuth);

const OpenAiCreateResponseJson = Schema.fromJsonString(
  Schema.toEncoded(OpenAiSchema.CreateResponse),
);
const decodeOpenAiCreateResponseJson = Schema.decodeEffect(OpenAiCreateResponseJson);

const ChatGptCodexStreamEventType = Schema.fromJsonString(Schema.Struct({ type: Schema.String }));
const decodeChatGptCodexStreamEventType = Schema.decodeEffect(ChatGptCodexStreamEventType);

const ChatGptCodexCompletedEvent = Schema.fromJsonString(
  Schema.Struct({ type: Schema.Literal("response.completed"), response: Schema.Json }),
);
const decodeChatGptCodexCompletedEvent = Schema.decodeEffect(ChatGptCodexCompletedEvent);

type OpenAiCreateResponseRequest = typeof OpenAiSchema.CreateResponse.Encoded;
type OpenAiResponseInputItem = Exclude<
  OpenAiCreateResponseRequest["input"],
  string | undefined
>[number];

/** Returns the text of a system or developer message, which Codex accepts only as `instructions`. */
const readInstructionText = (item: OpenAiResponseInputItem): Option.Option<string> => {
  if (!("role" in item) || (item.role !== "system" && item.role !== "developer")) {
    return Option.none();
  }
  if (!("content" in item)) return Option.none();
  if (Predicate.isString(item.content)) return Option.some(item.content);
  return Option.some(
    item.content.flatMap((part) => (part.type === "input_text" ? [part.text] : [])).join("\n"),
  );
};

/**
 * Adapts an OpenAI Responses request to the ChatGPT Codex backend, which requires streaming,
 * disabled storage, and top-level instructions instead of system or developer input messages.
 */
const toChatGptCodexRequest = (
  request: OpenAiCreateResponseRequest,
): OpenAiCreateResponseRequest => {
  const input = Predicate.isString(request.input) ? undefined : request.input;
  const instructionTexts = (input ?? []).flatMap((item) =>
    Option.toArray(readInstructionText(item)),
  );
  const conversation = input?.filter((item) => Option.isNone(readInstructionText(item)));
  const instructions = [request.instructions, ...instructionTexts]
    .filter((text): text is string => text !== undefined && text !== null && text.length > 0)
    .join("\n\n");
  const codexRequest: OpenAiCreateResponseRequest = {
    ...request,
    instructions: instructions.length > 0 ? instructions : defaultChatGptCodexInstructions,
    store: false,
    stream: true,
  };
  if (conversation === undefined) return codexRequest;
  return { ...codexRequest, input: conversation };
};

const toTransportError =
  (request: HttpClientRequest.HttpClientRequest, description: string) =>
  (cause?: Schema.SchemaError | PlatformError.PlatformError) =>
    new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({ request, cause, description }),
    });

/** Rebuilds the non-streaming Responses API body from a ChatGPT Codex event stream. */
const readChatGptCodexCompletedResponse = Effect.fn("readChatGptCodexCompletedResponse")(function* (
  request: HttpClientRequest.HttpClientRequest,
  eventStream: string,
) {
  for (const line of eventStream.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice("data:".length).trim();
    if (data.length === 0 || data === "[DONE]") continue;
    const event = yield* decodeChatGptCodexStreamEventType(data);
    if (event.type !== "response.completed") continue;
    return (yield* decodeChatGptCodexCompletedEvent(data)).response;
  }
  return yield* Effect.fail(
    toTransportError(
      request,
      "ChatGPT Codex stream ended without a response.completed event. Retry the request.",
    )(),
  );
});

/**
 * Layer that provides an `OpenAiClient` authenticated with the ChatGPT subscription sign-in pi
 * stores in `~/.pi/agent/auth.json`.
 *
 * **When to use**
 *
 * Use when you want Traits to draft traits with a ChatGPT subscription instead of an OpenAI API key.
 *
 * **Details**
 *
 * Reads the sign-in file on every request, so token refreshes made by pi apply without restarting
 * Traits. Sends requests to the ChatGPT Codex backend identified as `Rex-SDK-Traits`. Converts
 * non-streaming Responses API calls into streaming ones, moves system and developer messages into
 * `instructions`, and rebuilds the JSON body that `createResponse` expects.
 *
 * **Gotchas**
 *
 * Fails every request with `HttpClientError` when pi is not signed in to `openai-codex`, and
 * consumes the subscription's usage limits rather than API credits.
 *
 * @see {@link OpenAiClient.layer} for the API-key client this layer configures.
 */
export const chatGptSubscriptionOpenAiClientLayer = Layer.unwrap(
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* Config.String("HOME");
    const authFile = path.join(home, ".pi", "agent", "auth.json");

    const readSubscriptionAuth = fileSystem
      .readFileString(authFile)
      .pipe(Effect.flatMap(decodePiChatGptSubscriptionAuth));

    const toSubscriptionError =
      (request: HttpClientRequest.HttpClientRequest) =>
      <A>(
        effect: Effect.Effect<
          A,
          HttpClientError.HttpClientError | PlatformError.PlatformError | Schema.SchemaError
        >,
      ): Effect.Effect<A, HttpClientError.HttpClientError> =>
        effect.pipe(
          Effect.catchTags({
            PlatformError: (error: PlatformError.PlatformError) =>
              Effect.fail(
                toTransportError(
                  request,
                  "Could not read pi's ChatGPT sign-in from ~/.pi/agent/auth.json. Sign in to openai-codex in pi and restart Traits.",
                )(error),
              ),
            SchemaError: (error: Schema.SchemaError) =>
              Effect.fail(
                toTransportError(
                  request,
                  "ChatGPT sign-in, Codex request, or Codex stream did not match the expected format. Sign in to openai-codex in pi again and restart Traits; if the error continues, the Codex backend format may have changed.",
                )(error),
              ),
          }),
        );

    /** Authenticates every request and adapts Responses API calls to the Codex backend. */
    const prepareChatGptCodexRequest = (
      request: HttpClientRequest.HttpClientRequest,
    ): Effect.Effect<HttpClientRequest.HttpClientRequest, HttpClientError.HttpClientError> =>
      Effect.gen(function* () {
        const auth = (yield* readSubscriptionAuth)["openai-codex"];
        const authenticated = request.pipe(
          HttpClientRequest.bearerToken(auth.access),
          HttpClientRequest.setHeaders({
            "chatgpt-account-id": auth.accountId,
            originator: "rex-sdk-traits",
            "user-agent": "Rex-SDK-Traits/1.0",
          }),
        );
        const body = request.body;
        if (
          request.method !== "POST" ||
          !request.url.endsWith("/responses") ||
          !(body instanceof HttpBody.Uint8Array)
        ) {
          return authenticated;
        }
        const responseRequest = yield* decodeOpenAiCreateResponseJson(
          new TextDecoder().decode(body.body),
        );
        const codexRequest = HttpClientRequest.bodyJsonUnsafe(
          authenticated,
          toChatGptCodexRequest(responseRequest),
        );
        if (responseRequest.stream === true) return codexRequest;
        return HttpClientRequest.setHeader(codexRequest, "accept", bufferedCodexStreamAccept);
      }).pipe(toSubscriptionError(request));

    /** Converts a buffered Codex event stream back into the JSON body `createResponse` expects. */
    const finishChatGptCodexResponse = (
      response: HttpClientResponse.HttpClientResponse,
    ): Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError> => {
      if (response.request.headers["accept"] !== bufferedCodexStreamAccept) {
        return Effect.succeed(response);
      }
      return response.text.pipe(
        Effect.flatMap((eventStream) =>
          readChatGptCodexCompletedResponse(response.request, eventStream),
        ),
        Effect.map((completed) =>
          HttpClientResponse.fromWeb(
            response.request,
            new Response(JSON.stringify(completed), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          ),
        ),
        toSubscriptionError(response.request),
      );
    };

    return OpenAiClient.layer({
      apiUrl: chatGptCodexResponsesUrl,
      transformClient: (client) =>
        client.pipe(
          HttpClient.mapRequestEffect(prepareChatGptCodexRequest),
          HttpClient.transformResponse(Effect.flatMap(finishChatGptCodexResponse)),
        ),
    });
  }),
);
