/**
 * The server's wire contract, loaded from the snapshots in `schema/`, for tests that check the SDK
 * against it: every method's request and result JSON Schemas, every event's payload schema, ajv
 * validators for them, and value generators built from them.
 *
 * The generators come from the server's own schemas, not from the SDK's generated codecs, so a
 * mistake in `scripts/generate-wire-schemas.ts` cannot hide itself. They add only what the server
 * guarantees but its schemas leave out, and every such rule is named here:
 *
 * - Fields named for an ID kind (`session_id`, `block_ids`, `anchor_id`, …) carry well-formed IDs
 *   of that kind, such as `session:<text>`. The server's schemas type them as plain strings.
 * - A required ID is never null, and neither is an ID inside an array, though the server's schema
 *   generator marks every ID nullable.
 * - A recursive definition (`$anchor`, such as `view-layout-node`) is null only where the schema
 *   uses it first, such as an empty layer's `layout`; a split's `before` and `after` always hold
 *   a node, though the shared definition marks every use nullable.
 * - Requests never carry `null`: the SDK leaves an unset value out instead. Nor do they carry
 *   fields the schema doesn't name, which only the server's own clients could send.
 *
 * @since 0.1.0
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { Arbitrary, JsonSchema, Schema, SchemaRepresentation } from "effect";

/** A JSON Schema object, as the snapshots hold it. */
export type RexJsonSchemaObject = { readonly [key: string]: Schema.Json };

const JsonSchemaObject = Schema.Record(Schema.String, Schema.Json);

const ApiDocument = Schema.Struct({
  methods: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      input_schema: Schema.optionalKey(JsonSchemaObject),
      output_schema: Schema.optionalKey(JsonSchemaObject),
    }),
  ),
  block_types: Schema.Array(
    Schema.Struct({
      creator: Schema.String,
      methods: Schema.Array(
        Schema.Struct({
          invoke: Schema.Struct({ method: Schema.String }),
          args_schema: JsonSchemaObject,
          output_schema: JsonSchemaObject,
        }),
      ),
    }),
  ),
});

const EventsDocument = Schema.Struct({
  $defs: Schema.Record(Schema.String, JsonSchemaObject),
  server_events: Schema.Record(Schema.String, JsonSchemaObject),
  session_events: Schema.Record(Schema.String, JsonSchemaObject),
});

const CreatorsDocument = Schema.Struct({
  creators: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      flavors: Schema.Array(
        Schema.Struct({
          flavor: Schema.String,
          options_schema: Schema.optionalKey(JsonSchemaObject),
        }),
      ),
      api: Schema.Struct({
        events: Schema.optionalKey(Schema.Record(Schema.String, JsonSchemaObject)),
      }),
    }),
  ),
});

/** One server method: the JSON Schemas of its request payload and its result. */
export interface RexWireServerMethod {
  readonly method: string;
  readonly input: RexJsonSchemaObject | undefined;
  readonly output: RexJsonSchemaObject | undefined;
}

/** One block method: the JSON Schemas of its own arguments and its result. */
export interface RexWireBlockMethod {
  readonly method: string;
  readonly creator: string;
  readonly args: RexJsonSchemaObject;
  readonly output: RexJsonSchemaObject;
}

/** One event a block creator lists, with its payload schema. */
export interface RexWireBlockEvent {
  readonly creator: string;
  readonly name: string;
  readonly payload: RexJsonSchemaObject;
}

/** Everything the snapshots say about the wire. */
export interface RexWireContract {
  readonly serverMethods: ReadonlyArray<RexWireServerMethod>;
  readonly blockMethods: ReadonlyArray<RexWireBlockMethod>;
  /** Server event payload schemas, by event type; they refer to `eventDefinitions`. */
  readonly serverEvents: { readonly [type: string]: RexJsonSchemaObject };
  /** Session event payload schemas, by event type; they refer to `eventDefinitions`. */
  readonly sessionEvents: { readonly [type: string]: RexJsonSchemaObject };
  /** Shared definitions event schemas refer to as `#/$defs/<name>`. */
  readonly eventDefinitions: { readonly [name: string]: RexJsonSchemaObject };
  readonly blockEvents: ReadonlyArray<RexWireBlockEvent>;
  /** Options schemas of block flavors, by flavor. */
  readonly flavorOptions: { readonly [flavor: string]: RexJsonSchemaObject };
}

const schemaDirectory = join(import.meta.dirname, "../../schema");
const readSnapshot = (name: string) => readFileSync(join(schemaDirectory, name), "utf8");

let cachedContract: RexWireContract | undefined;

/**
 * The wire contract from the snapshots, read once per process.
 *
 * @category constructors
 * @since 0.1.0
 */
export function rexWireContract(): RexWireContract {
  if (cachedContract !== undefined) return cachedContract;
  const api = Schema.decodeUnknownSync(Schema.fromJsonString(ApiDocument))(
    readSnapshot("rex-api.json"),
  );
  const events = Schema.decodeUnknownSync(Schema.fromJsonString(EventsDocument))(
    readSnapshot("rex-events.json"),
  );
  const creators = Schema.decodeUnknownSync(Schema.fromJsonString(CreatorsDocument))(
    readSnapshot("rex-block-creators.json"),
  );
  cachedContract = {
    serverMethods: api.methods.map((method) => ({
      method: method.name,
      input: method.input_schema,
      output: method.output_schema,
    })),
    blockMethods: api.block_types.flatMap((blockType) =>
      blockType.methods.map((method) => ({
        method: method.invoke.method,
        creator: blockType.creator,
        args: method.args_schema,
        output: method.output_schema,
      })),
    ),
    serverEvents: events.server_events,
    sessionEvents: events.session_events,
    eventDefinitions: events.$defs,
    blockEvents: creators.creators.flatMap((creator) =>
      Object.entries(creator.api.events ?? {}).map(([name, payload]) => ({
        creator: creator.name,
        name,
        payload,
      })),
    ),
    flavorOptions: Object.fromEntries(
      creators.creators.flatMap((creator) =>
        creator.flavors.flatMap((flavor) =>
          flavor.options_schema === undefined ? [] : [[flavor.flavor, flavor.options_schema]],
        ),
      ),
    ),
  };
  return cachedContract;
}

/**
 * The full request payload schema of a block method: the block it targets and its arguments.
 * The arguments are required when the method has a required argument.
 *
 * @category constructors
 * @since 0.1.0
 */
export function rexBlockRequestSchema(args: RexJsonSchemaObject): RexJsonSchemaObject {
  const required = args["required"];
  const argsRequired = Array.isArray(required) && required.length > 0;
  return {
    type: "object",
    properties: {
      session_id: { type: "string" },
      block_id: { type: "string" },
      args,
    },
    required: argsRequired ? ["session_id", "block_id", "args"] : ["session_id", "block_id"],
    additionalProperties: false,
  };
}

/**
 * Gives a schema its own `$id` and keeps only the first of identical repeated `$anchor`s.
 *
 * The server inlines the same anchored definition (such as `view-layout-node`) at several
 * places in one schema; JSON Schema requires an anchor to be unique within its resource.
 */
function standaloneJsonSchema(id: string, schema: RexJsonSchemaObject): RexJsonSchemaObject {
  const seen = new Set<string>();
  const strip = (value: Schema.Json): Schema.Json => {
    if (Array.isArray(value)) return value.map(strip);
    if (value === null || typeof value !== "object") return value;
    const entries = Object.entries(value).flatMap(([key, child]): Array<[string, Schema.Json]> => {
      if (key === "$anchor" && typeof child === "string") {
        if (seen.has(child)) return [];
        seen.add(child);
      }
      return [[key, strip(child)]];
    });
    return Object.fromEntries(entries);
  };
  return {
    ...Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, strip(value)])),
    $id: id,
  };
}

/** Request and result validators for one method. */
export interface RexWireMethodValidators {
  readonly input: ValidateFunction | undefined;
  readonly output: ValidateFunction | undefined;
}

let cachedValidators: ReadonlyMap<string, RexWireMethodValidators> | undefined;

/**
 * ajv validators for every server and block method's request payload and result, by method.
 *
 * @category constructors
 * @since 0.1.0
 */
export function rexWireValidators(): ReadonlyMap<string, RexWireMethodValidators> {
  if (cachedValidators !== undefined) return cachedValidators;
  const contract = rexWireContract();
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  ajv.addFormat("date-time", true);
  const validators = new Map<string, RexWireMethodValidators>();
  for (const method of contract.serverMethods) {
    validators.set(method.method, {
      input:
        method.input === undefined
          ? undefined
          : ajv.compile(standaloneJsonSchema(`rex:${method.method}:input`, method.input)),
      output:
        method.output === undefined
          ? undefined
          : ajv.compile(standaloneJsonSchema(`rex:${method.method}:output`, method.output)),
    });
  }
  for (const method of contract.blockMethods) {
    validators.set(method.method, {
      input: ajv.compile({
        ...rexBlockRequestSchema(method.args),
        $id: `rex:${method.method}:input`,
      }),
      output: ajv.compile(standaloneJsonSchema(`rex:${method.method}:output`, method.output)),
    });
  }
  cachedValidators = validators;
  return validators;
}

/**
 * Checks a value against one method's request or result schema.
 *
 * @returns A description of the violation, or `undefined` when the value conforms or the method
 * has no schema for that side.
 * @category utils
 * @since 0.1.0
 */
export function rexWireViolation(
  method: string,
  side: "input" | "output",
  value: unknown,
): string | undefined {
  const validator = rexWireValidators().get(method)?.[side];
  if (validator === undefined || validator(value)) return undefined;
  return `${method} ${side}: ${JSON.stringify(validator.errors)}`;
}

let cachedEventValidator: ((type: string, value: unknown) => string | undefined) | undefined;

/**
 * Checks an event payload against its schema in `rex-events.json` or `rex-block-creators.json`.
 *
 * `kind` names the table: `server`, `session`, or a block creator's name.
 *
 * @category utils
 * @since 0.1.0
 */
export function rexEventViolation(kind: string, type: string, value: unknown): string | undefined {
  if (cachedEventValidator === undefined) {
    const contract = rexWireContract();
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    ajv.addFormat("date-time", true);
    const compiled = new Map<string, ValidateFunction>();
    const compile = (key: string, schema: RexJsonSchemaObject) =>
      compiled.set(
        key,
        ajv.compile({ ...schema, $id: `rex:event:${key}`, $defs: contract.eventDefinitions }),
      );
    for (const [name, schema] of Object.entries(contract.serverEvents))
      compile(`server/${name}`, schema);
    for (const [name, schema] of Object.entries(contract.sessionEvents))
      compile(`session/${name}`, schema);
    for (const event of contract.blockEvents)
      compile(`${event.creator}/${event.name}`, event.payload);
    cachedEventValidator = (key, value) => {
      const validator = compiled.get(key);
      if (validator === undefined) return `no schema for event ${key}`;
      return validator(value) ? undefined : `${key}: ${JSON.stringify(validator.errors)}`;
    };
  }
  return cachedEventValidator(`${kind}/${type}`, value);
}

/** Field names that hold an ID, and the pattern a well-formed ID of that kind matches. */
const idFields: ReadonlyArray<readonly [RegExp, string]> = [
  [/(^|_)session_ids?$/, "^session:\\S+$"],
  [/(^|_)window_ids?$/, "^window:\\S+$"],
  [/(^|_)block_ids?$/, "^block:\\S+$"],
  [/(^|_)split_ids?$/, "^split:\\S+$"],
  [/(^|_)layer_ids?$/, "^layer:\\S+$"],
  [/(^|_)client_ids?$/, "^client:\\S+$"],
  [/^anchor_id$/, "^(block|split):\\S+$"],
];

function idPattern(field: string | undefined): string | undefined {
  if (field === undefined) return undefined;
  return idFields.find(([name]) => name.test(field))?.[1];
}

function isJsonObject(
  value: Schema.Json | undefined,
): value is { readonly [key: string]: Schema.Json } {
  return (
    value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)
  );
}

function typesOf(node: RexJsonSchemaObject): ReadonlyArray<string> {
  const type = node["type"];
  if (typeof type === "string") return [type];
  if (Array.isArray(type)) return type.filter((value) => typeof value === "string");
  return [];
}

function withTypes(node: RexJsonSchemaObject, types: ReadonlyArray<string>): RexJsonSchemaObject {
  if (types.length === 0) return node;
  const [only] = types;
  return { ...node, type: types.length === 1 && only !== undefined ? only : [...types] };
}

/** Which side of the wire a generated value stands for. */
export type RexWireSide = "request" | "result";

/** How {@link rexWireArbitrary} shapes generated values beyond the schema itself. */
export interface RexWireArbitraryOptions {
  /** Requests never carry `null`; results may wherever the schema allows it. */
  readonly side: RexWireSide;
  /**
   * Forward-compatible results: enum strings become any string, as newer servers add values.
   * Defaults to false.
   */
  readonly openEnums?: boolean | undefined;
  /**
   * Forward-compatible results: every object also carries {@link rexFutureField}, with any JSON
   * value, as a field a newer server added. Defaults to false.
   */
  readonly futureFields?: boolean | undefined;
  /** Definitions `#/$defs/<name>` references resolve to. */
  readonly definitions?: { readonly [name: string]: RexJsonSchemaObject } | undefined;
}

/**
 * The field {@link RexWireArbitraryOptions.futureFields} adds to every object.
 *
 * @category constants
 * @since 0.1.0
 */
export const rexFutureField = "rex_sdk_future_field";

/**
 * Rewrites a server schema so that its values are what the server actually sends or accepts:
 * the documented rules in this module's description, plus `$anchor` recursion turned into
 * `$defs` so Effect can import it.
 */
function prepareSchema(
  schema: RexJsonSchemaObject,
  options: RexWireArbitraryOptions,
): {
  readonly schema: RexJsonSchemaObject;
  readonly definitions: Record<string, RexJsonSchemaObject>;
} {
  const definitions: Record<string, RexJsonSchemaObject> = {};
  const anchors = new Set<string>();

  const visit = (
    node: RexJsonSchemaObject,
    field: string | undefined,
    required: boolean,
    inArray: boolean,
  ): RexJsonSchemaObject => {
    const anchor = node["$anchor"];
    if (typeof anchor === "string") {
      const nullable = typesOf(node).includes("null");
      if (!anchors.has(anchor)) {
        anchors.add(anchor);
        const { $anchor: _anchor, ...rest } = node;
        const definition = visit(rest, field, required, inArray);
        definitions[anchor] = withTypes(
          definition,
          typesOf(definition).filter((type) => type !== "null"),
        );
      }
      const reference = { $ref: `#/$defs/${anchor}` };
      return nullable && options.side === "result"
        ? { anyOf: [{ type: "null" }, reference] }
        : reference;
    }
    const reference = node["$ref"];
    if (typeof reference === "string") {
      return { $ref: reference.startsWith("#/") ? reference : `#/$defs/${reference.slice(1)}` };
    }
    const result: Record<string, Schema.Json> = { ...node };
    let types = typesOf(node);
    const pattern = idPattern(field);
    if (options.side === "request" || (pattern !== undefined && (required || inArray))) {
      types = types.filter((type) => type !== "null");
    }
    if (pattern !== undefined && types.includes("string")) result["pattern"] = pattern;
    if (options.openEnums === true && options.side === "result") delete result["enum"];
    const properties = node["properties"];
    // A request carries only the fields the SDK models; a result may carry more, from a newer
    // server, so result objects stay open where the schema leaves them open.
    if (
      options.side === "request" &&
      isJsonObject(properties) &&
      node["additionalProperties"] === undefined
    ) {
      result["additionalProperties"] = false;
    }
    if (isJsonObject(properties) && options.futureFields === true && options.side === "result") {
      result["required"] = [
        ...(Array.isArray(node["required"]) ? node["required"] : []),
        rexFutureField,
      ];
    }
    if (isJsonObject(properties)) {
      const requiredKeys = new Set(
        Array.isArray(node["required"])
          ? node["required"].filter((key) => typeof key === "string")
          : [],
      );
      result["properties"] = {
        ...Object.fromEntries(
          Object.entries(properties).map(([key, child]) => [
            key,
            isJsonObject(child) ? visit(child, key, requiredKeys.has(key), false) : child,
          ]),
        ),
        ...(options.futureFields === true && options.side === "result"
          ? { [rexFutureField]: {} }
          : {}),
      };
    }
    const items = node["items"];
    if (isJsonObject(items)) {
      const itemField = field?.endsWith("_ids") === true ? field.slice(0, -1) : field;
      result["items"] = visit(items, itemField, false, true);
    }
    const additional = node["additionalProperties"];
    if (isJsonObject(additional))
      result["additionalProperties"] = visit(additional, undefined, false, false);
    const anyOf = node["anyOf"];
    if (Array.isArray(anyOf)) {
      result["anyOf"] = anyOf.map((member) =>
        isJsonObject(member) ? visit(member, field, required, inArray) : member,
      );
    }
    return withTypes(result, types);
  };

  for (const [name, definition] of Object.entries(options.definitions ?? {})) {
    definitions[name] = visit(definition, undefined, false, false);
  }
  return { schema: visit(schema, undefined, true, false), definitions };
}

const arbitraryCache = new Map<string, Arbitrary.Arbitrary<Schema.Json>>();

const decodeJson = Schema.decodeUnknownSync(Schema.Json);

/**
 * Generates values the server's schema accepts, shaped by the rules in this module's
 * description. Values are plain JSON, as they cross the wire.
 *
 * @category constructors
 * @since 0.1.0
 */
export function rexWireArbitrary(
  key: string,
  schema: RexJsonSchemaObject,
  options: RexWireArbitraryOptions,
): Arbitrary.Arbitrary<Schema.Json> {
  const cacheKey = `${key}|${options.side}|${options.openEnums === true}|${options.futureFields === true}`;
  const cached = arbitraryCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const prepared = prepareSchema(schema, options);
  const document = JsonSchema.fromSchemaDraft2020_12({
    ...prepared.schema,
    $defs: prepared.definitions,
  });
  const imported = SchemaRepresentation.fromJsonSchemaDocument(document, { patterns: "apply" });
  // A JSON round trip drops `undefined` members, so values are exactly what crosses the wire.
  const arbitrary = Arbitrary.schema(Schema.toType(imported)).pipe(
    Arbitrary.map((value) => decodeJson(JSON.parse(JSON.stringify(value ?? null)))),
  );
  arbitraryCache.set(cacheKey, arbitrary);
  return arbitrary;
}
