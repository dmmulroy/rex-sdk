/**
 * Generates Effect Schema codecs for the Rex wire contract.
 *
 * Inputs are the server snapshots in `schema/`: `rex-api.json` (`GET /api/help`),
 * `rex-block-creators.json` (`block_creator.list`), and `rex-events.json` (the event
 * reference, transcribed by hand). The output is `src/generated/rex-wire-schemas.ts`.
 *
 * Usage: `node scripts/generate-wire-schemas.ts [--check]`. With `--check`, the script writes
 * nothing and exits non-zero when the checked-in output is stale.
 *
 * Mapping rules:
 * - Wire keys are snake_case; generated codecs expose camelCase keys through `encodeKeys`.
 * - Results and events decode optional or nullable values to `Option`, and arrays that may be
 *   `null` or missing to empty arrays. Enum strings stay plain strings, because the server adds
 *   values and tells clients to tolerate unknown ones.
 * - Inputs (method arguments, block method arguments, flavor options) keep plain optional keys,
 *   strict enum literals, and numeric bounds, accept only finite numbers, and never send `null`.
 * - A result's array of nullable arrays decodes each `null` to an empty array, as Go writes a
 *   nil inner slice as `null`.
 * - Fields named for an ID kind (`session_id`, `block_ids`, …) use the branded ID schemas. A
 *   required ID decodes as the ID itself even when the schema marks it nullable.
 */
import { Console, Effect, FileSystem, Schema } from "effect";
import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { join } from "node:path";

interface JsonSchemaNode {
  readonly type?: string | ReadonlyArray<string>;
  readonly description?: string;
  readonly properties?: { readonly [key: string]: JsonSchemaNode };
  readonly required?: ReadonlyArray<string>;
  readonly items?: JsonSchemaNode;
  readonly additionalProperties?: boolean | JsonSchemaNode;
  readonly enum?: ReadonlyArray<string>;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly $ref?: string;
  readonly $anchor?: string;
  readonly anyOf?: ReadonlyArray<JsonSchemaNode>;
  readonly format?: string;
}

const JsonSchemaNode: Schema.Codec<JsonSchemaNode> = Schema.Struct({
  type: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  description: Schema.optionalKey(Schema.String),
  properties: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.suspend((): Schema.Codec<JsonSchemaNode> => JsonSchemaNode),
    ),
  ),
  required: Schema.optionalKey(Schema.Array(Schema.String)),
  items: Schema.optionalKey(Schema.suspend((): Schema.Codec<JsonSchemaNode> => JsonSchemaNode)),
  additionalProperties: Schema.optionalKey(
    Schema.Union([
      Schema.Boolean,
      Schema.suspend((): Schema.Codec<JsonSchemaNode> => JsonSchemaNode),
    ]),
  ),
  enum: Schema.optionalKey(Schema.Array(Schema.String)),
  minimum: Schema.optionalKey(Schema.Number),
  maximum: Schema.optionalKey(Schema.Number),
  minItems: Schema.optionalKey(Schema.Number),
  maxItems: Schema.optionalKey(Schema.Number),
  $ref: Schema.optionalKey(Schema.String),
  $anchor: Schema.optionalKey(Schema.String),
  anyOf: Schema.optionalKey(
    Schema.Array(Schema.suspend((): Schema.Codec<JsonSchemaNode> => JsonSchemaNode)),
  ),
  format: Schema.optionalKey(Schema.String),
});

const RexApiMethod = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  input_schema: Schema.optionalKey(JsonSchemaNode),
  output_schema: Schema.optionalKey(JsonSchemaNode),
});

const RexApiDocument = Schema.Struct({
  methods: Schema.Array(RexApiMethod),
  block_types: Schema.Array(
    Schema.Struct({
      creator: Schema.String,
      methods: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          description: Schema.String,
          invoke: Schema.Struct({ method: Schema.String }),
          args_schema: JsonSchemaNode,
          output_schema: JsonSchemaNode,
        }),
      ),
    }),
  ),
});

const RexBlockCreatorsDocument = Schema.Struct({
  creators: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      flavors: Schema.Array(
        Schema.Struct({
          flavor: Schema.String,
          options_schema: Schema.optionalKey(JsonSchemaNode),
        }),
      ),
      api: Schema.Struct({
        events: Schema.optionalKey(Schema.Record(Schema.String, JsonSchemaNode)),
      }),
    }),
  ),
});

const RexEventsDocument = Schema.Struct({
  $defs: Schema.Record(Schema.String, JsonSchemaNode),
  server_events: Schema.Record(Schema.String, JsonSchemaNode),
  session_events: Schema.Record(Schema.String, JsonSchemaNode),
});

const decodeRexApiDocument = Schema.decodeUnknownEffect(Schema.fromJsonString(RexApiDocument));
const decodeRexBlockCreatorsDocument = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RexBlockCreatorsDocument),
);
const decodeRexEventsDocument = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RexEventsDocument),
);

type CodecMode = "result" | "input";

interface GenerationContext {
  readonly mode: CodecMode;
  /** Schema name for each `$anchor` (recursive) or `#/$defs/` reference. */
  readonly references: ReadonlyMap<string, string>;
}

const idBrands: ReadonlyArray<readonly [RegExp, string]> = [
  [/(^|_)session_ids?$/, "SessionId"],
  [/(^|_)window_ids?$/, "WindowId"],
  [/(^|_)block_ids?$/, "BlockId"],
  [/(^|_)split_ids?$/, "SplitId"],
  [/(^|_)layer_ids?$/, "LayerId"],
  [/(^|_)client_ids?$/, "ClientId"],
  [/^anchor_id$/, "AnchorId"],
];

function brandForField(fieldName: string | undefined): string | undefined {
  if (fieldName === undefined) return undefined;
  return idBrands.find(([pattern]) => pattern.test(fieldName))?.[1];
}

function typesOf(node: JsonSchemaNode): ReadonlyArray<string> {
  if (node.type === undefined) return [];
  return typeof node.type === "string" ? [node.type] : node.type;
}

function isNullable(node: JsonSchemaNode): boolean {
  return typesOf(node).includes("null");
}

function isArrayNode(node: JsonSchemaNode): boolean {
  return typesOf(node).includes("array");
}

function camelCase(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());
}

function pascalCase(words: string): string {
  return words
    .split(/[._-]/)
    .filter((word) => word.length > 0)
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join("");
}

function jsDoc(description: string | undefined, indent: string): string {
  if (description === undefined || description.length === 0) return "";
  const text = description.replaceAll("*/", "*\\/");
  return `${indent}/** ${text} */\n`;
}

function quoteKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

function referenceName(node: JsonSchemaNode, context: GenerationContext): string | undefined {
  if (node.$ref === undefined) return undefined;
  const key = node.$ref.startsWith("#/$defs/") ? node.$ref.slice(8) : node.$ref.slice(1);
  const name = context.references.get(key);
  if (name === undefined) throw new Error(`Unresolved schema reference ${node.$ref}`);
  return name;
}

function numberChecks(node: JsonSchemaNode, context: GenerationContext): string {
  if (context.mode === "result") return "";
  const checks: Array<string> = [];
  if (node.minimum !== undefined) checks.push(`Schema.isGreaterThanOrEqualTo(${node.minimum})`);
  if (node.maximum !== undefined) checks.push(`Schema.isLessThanOrEqualTo(${node.maximum})`);
  return checks.length === 0 ? "" : `.check(${checks.join(", ")})`;
}

/** Effect Schema expression for a value, without field-level optionality. */
function valueSchema(
  node: JsonSchemaNode,
  context: GenerationContext,
  fieldName: string | undefined,
  indent: string,
): string {
  const reference = referenceName(node, context);
  if (reference !== undefined) {
    return node.$ref?.startsWith("#/$defs/") === true
      ? reference
      : `Schema.suspend((): Schema.Codec<${reference}, ${reference}Encoded> => ${reference})`;
  }
  if (node.anyOf !== undefined) {
    const members = node.anyOf.map((member) => valueSchema(member, context, fieldName, indent));
    return `Schema.Union([${members.join(", ")}])`;
  }
  const types = typesOf(node).filter((type) => type !== "null");
  const [type] = types;
  if (types.length !== 1 || type === undefined) return "Schema.Json";
  switch (type) {
    case "string": {
      const brand = brandForField(fieldName);
      if (brand !== undefined) return brand;
      if (node.enum !== undefined && context.mode === "input") {
        return `Schema.Literals([${node.enum.map((value) => JSON.stringify(value)).join(", ")}])`;
      }
      return "Schema.String";
    }
    case "integer":
      return `Schema.Int${numberChecks(node, context)}`;
    case "number":
      // JSON has no NaN or infinity: `JSON.stringify` would send them as null.
      return context.mode === "input"
        ? `Schema.Finite${numberChecks(node, context)}`
        : `Schema.Number${numberChecks(node, context)}`;
    case "boolean":
      return "Schema.Boolean";
    case "array": {
      const item = arrayItemSchema(node, context, fieldName, indent);
      if (
        node.minItems !== undefined &&
        node.minItems === node.maxItems &&
        node.minItems > 0 &&
        node.minItems <= 8
      ) {
        return `Schema.Tuple([${Array.from({ length: node.minItems }, () => item).join(", ")}])`;
      }
      return `Schema.Array(${item})`;
    }
    case "object":
      return objectSchema(node, context, indent);
    default:
      throw new Error(`Unsupported JSON Schema type ${type}`);
  }
}

function singularField(fieldName: string | undefined): string | undefined {
  return fieldName?.endsWith("_ids") === true ? fieldName.slice(0, -1) : fieldName;
}

function arrayItemSchema(
  node: JsonSchemaNode,
  context: GenerationContext,
  fieldName: string | undefined,
  indent: string,
): string {
  const items = node.items;
  if (items === undefined) return "Schema.Json";
  const singular = singularField(fieldName);
  // Go writes a nil inner slice as null, so a result's nested array may hold nulls.
  if (
    context.mode === "result" &&
    isNullable(items) &&
    isArrayNode(items) &&
    items.$ref === undefined
  ) {
    return `arrayFromNullOr(${arrayItemSchema(items, context, singular, indent)})`;
  }
  return valueSchema(items, context, singular, indent);
}

/**
 * A required ID field is always present: the server's schema generator marks every ID field
 * nullable, but a required ID is never null. Decoding such a null fails as a contract error.
 */
function isRequiredId(key: string, required: boolean): boolean {
  return required && brandForField(key) !== undefined;
}

function fieldSchema(
  key: string,
  node: JsonSchemaNode,
  required: boolean,
  context: GenerationContext,
  indent: string,
): string {
  const untyped = node.type === undefined && node.$ref === undefined && node.anyOf === undefined;
  if (context.mode === "input") {
    const base = valueSchema(node, context, key, indent);
    return required ? base : `Schema.optionalKey(${base})`;
  }
  const isFixedTuple =
    node.minItems !== undefined && node.minItems === node.maxItems && node.minItems > 0;
  if (isArrayNode(node) && !isFixedTuple) {
    const item = arrayItemSchema(node, context, key, indent);
    if (!required) return `optionalArrayFromNullOr(${item})`;
    return isNullable(node) ? `arrayFromNullOr(${item})` : `Schema.Array(${item})`;
  }
  const base = valueSchema(node, context, key, indent);
  if (untyped) return required ? base : `Schema.OptionFromOptionalKey(${base})`;
  if (required)
    return isNullable(node) && !isRequiredId(key, required)
      ? `Schema.OptionFromNullOr(${base})`
      : base;
  return isNullable(node)
    ? `Schema.OptionFromOptionalNullOr(${base}, { onNoneEncoding: "omit" })`
    : `Schema.OptionFromOptionalKey(${base})`;
}

function objectSchema(node: JsonSchemaNode, context: GenerationContext, indent: string): string {
  const properties = node.properties;
  if (properties === undefined || Object.keys(properties).length === 0) {
    if (typeof node.additionalProperties === "object") {
      return `Schema.Record(Schema.String, ${valueSchema(node.additionalProperties, context, undefined, indent)})`;
    }
    if (node.additionalProperties === false) return "Schema.Struct({})";
    return "Schema.Record(Schema.String, Schema.Json)";
  }
  const required = new Set(node.required ?? []);
  const inner = `${indent}  `;
  const renames: Array<string> = [];
  const fields = Object.entries(properties).map(([key, property]) => {
    const camel = camelCase(key);
    if (camel !== key) renames.push(`${quoteKey(camel)}: ${JSON.stringify(key)}`);
    const schema = fieldSchema(key, property, required.has(key), context, inner);
    return `${jsDoc(property.description, inner)}${inner}${quoteKey(camel)}: ${schema},`;
  });
  const struct = `Schema.Struct({\n${fields.join("\n")}\n${indent}})`;
  return renames.length === 0
    ? struct
    : `${struct}.pipe(Schema.encodeKeys({ ${renames.join(", ")} }))`;
}

/** TypeScript type text for a recursive named schema's decoded or encoded side. */
function typeText(
  node: JsonSchemaNode,
  context: GenerationContext,
  side: "Type" | "Encoded",
  fieldName: string | undefined,
): string {
  const reference = referenceName(node, context);
  if (reference !== undefined) return side === "Type" ? reference : `${reference}Encoded`;
  const types = typesOf(node).filter((type) => type !== "null");
  const [type] = types;
  if (types.length !== 1 || type === undefined) return "Schema.Json";
  switch (type) {
    case "string": {
      const brand = brandForField(fieldName);
      return brand !== undefined && side === "Type" ? brand : "string";
    }
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "array": {
      const item =
        node.items === undefined
          ? "Schema.Json"
          : typeText(node.items, context, side, singularField(fieldName));
      return `ReadonlyArray<${item}>`;
    }
    case "object": {
      const required = new Set(node.required ?? []);
      const fields = Object.entries(node.properties ?? {}).map(([key, property]) => {
        const name = side === "Type" ? camelCase(key) : key;
        const value = typeText(property, context, side, key);
        const isRequired = required.has(key);
        if (side === "Encoded") {
          const nullable = isNullable(property) && !isRequiredId(key, isRequired) ? " | null" : "";
          return `readonly ${quoteKey(name)}${isRequired ? "" : "?"}: ${value}${nullable}${isRequired ? "" : " | undefined"}`;
        }
        if (isArrayNode(property)) return `readonly ${quoteKey(name)}: ${value}`;
        const optional = !isRequired || (isNullable(property) && !isRequiredId(key, isRequired));
        return `readonly ${quoteKey(name)}: ${optional ? `Option.Option<${value}>` : value}`;
      });
      return `{ ${fields.join("; ")} }`;
    }
    default:
      throw new Error(`Unsupported JSON Schema type ${type}`);
  }
}

function collectAnchors(node: JsonSchemaNode, anchors: Map<string, JsonSchemaNode>): void {
  if (node.$anchor !== undefined && !anchors.has(node.$anchor)) anchors.set(node.$anchor, node);
  for (const property of Object.values(node.properties ?? {})) collectAnchors(property, anchors);
  if (node.items !== undefined) collectAnchors(node.items, anchors);
  if (typeof node.additionalProperties === "object") {
    collectAnchors(node.additionalProperties, anchors);
  }
  for (const member of node.anyOf ?? []) collectAnchors(member, anchors);
}

function emitConstant(name: string, description: string | undefined, schema: string): string {
  return `${jsDoc(description, "")}export const ${name} = ${schema};\n${jsDoc(description, "")}export type ${name} = typeof ${name}.Type;\n`;
}

function methodBaseName(method: string): string {
  return pascalCase(method);
}

function blockMethodBaseName(creator: string, method: string): string {
  const creatorName = creator.split(".").at(-1) ?? creator;
  return pascalCase(`${creatorName}.${method}`);
}

function generate(
  api: typeof RexApiDocument.Type,
  creators: typeof RexBlockCreatorsDocument.Type,
  events: typeof RexEventsDocument.Type,
): string {
  const anchors = new Map<string, JsonSchemaNode>();
  for (const method of api.methods) {
    if (method.output_schema !== undefined) collectAnchors(method.output_schema, anchors);
  }
  const references = new Map<string, string>();
  for (const anchor of anchors.keys()) references.set(anchor, pascalCase(anchor));
  for (const definition of Object.keys(events.$defs)) {
    references.set(definition, `Rex${pascalCase(definition)}`);
  }
  const result: GenerationContext = { mode: "result", references };
  const input: GenerationContext = { mode: "input", references };

  const sections: Array<string> = [
    `// Generated by scripts/generate-wire-schemas.ts from schema/*.json. Do not edit.
// Regenerate with \`vp run generate\` after refreshing the server snapshots.
/* oxlint-disable */
import { Option, Schema } from "effect";
import { AnchorId, BlockId, ClientId, LayerId, SessionId, SplitId, WindowId } from "../rex-domain.ts";
import { arrayFromNullOr, optionalArrayFromNullOr } from "../rex-schema-helpers.ts";

// Keep every import referenced even when a snapshot stops using one.
void [Option.none, AnchorId, BlockId, ClientId, LayerId, SessionId, SplitId, WindowId, arrayFromNullOr, optionalArrayFromNullOr];
`,
  ];

  sections.push("// Recursive shapes shared by several results.\n");
  for (const [anchor, node] of anchors) {
    const name = pascalCase(anchor);
    const { $anchor: _ignored, ...withoutAnchor } = node;
    sections.push(
      `${jsDoc(node.description, "")}export interface ${name} ${typeText(withoutAnchor, result, "Type", undefined)}\n` +
        `/** Wire form of {@link ${name}}. */\nexport interface ${name}Encoded ${typeText(withoutAnchor, result, "Encoded", undefined)}\n` +
        `${jsDoc(node.description, "")}export const ${name}: Schema.Codec<${name}, ${name}Encoded> = ${valueSchema(withoutAnchor, result, undefined, "")};\n`,
    );
  }

  sections.push("// Shared event shapes.\n");
  for (const [definition, node] of Object.entries(events.$defs)) {
    sections.push(
      emitConstant(
        `Rex${pascalCase(definition)}`,
        node.description,
        valueSchema(node, result, undefined, ""),
      ),
    );
  }

  sections.push("// Server methods.\n");
  const methodEntries: Array<string> = [];
  for (const method of api.methods) {
    const base = methodBaseName(method.name);
    const inputSchema =
      method.input_schema === undefined
        ? "Schema.Struct({})"
        : valueSchema(method.input_schema, input, undefined, "");
    const resultSchema =
      method.output_schema === undefined
        ? "Schema.Json"
        : valueSchema(method.output_schema, result, undefined, "");
    sections.push(
      emitConstant(
        `${base}Input`,
        `Arguments of \`${method.name}\`: ${method.description}`,
        inputSchema,
      ),
    );
    sections.push(emitConstant(`${base}Result`, `Result of \`${method.name}\`.`, resultSchema));
    methodEntries.push(
      `  ${JSON.stringify(method.name)}: { input: ${base}Input, result: ${base}Result },`,
    );
  }
  sections.push(
    `/** Every server method with its argument and result codecs. */\nexport const rexWireMethods = {\n${methodEntries.join("\n")}\n} as const;\n\n/** Name of a server method. */\nexport type RexWireMethod = keyof typeof rexWireMethods;\n`,
  );

  sections.push("// Block methods.\n");
  const blockMethodEntries: Array<string> = [];
  for (const blockType of api.block_types) {
    for (const method of blockType.methods) {
      const base = blockMethodBaseName(blockType.creator, method.name);
      sections.push(
        emitConstant(
          `${base}Args`,
          `Arguments of \`${method.invoke.method}\`: ${method.description}`,
          valueSchema(method.args_schema, input, undefined, ""),
        ),
      );
      sections.push(
        emitConstant(
          `${base}Result`,
          `Result of \`${method.invoke.method}\`.`,
          valueSchema(method.output_schema, result, undefined, ""),
        ),
      );
      blockMethodEntries.push(
        `  ${JSON.stringify(method.invoke.method)}: { args: ${base}Args, result: ${base}Result },`,
      );
    }
  }
  sections.push(
    `/** Every block method with its argument and result codecs. */\nexport const rexBlockMethods = {\n${blockMethodEntries.join("\n")}\n} as const;\n\n/** Full name of a block method, such as \`com.superlogical.terminal.write\`. */\nexport type RexBlockMethod = keyof typeof rexBlockMethods;\n`,
  );

  sections.push("// Block flavors and block events.\n");
  const blockEventEntries: Array<string> = [];
  for (const creator of creators.creators) {
    const creatorName = creator.name.split(".").at(-1) ?? creator.name;
    for (const flavor of creator.flavors) {
      if (flavor.options_schema === undefined) continue;
      const flavorName = flavor.flavor.split(".").at(-1) ?? flavor.flavor;
      sections.push(
        emitConstant(
          `${pascalCase(`${creatorName}.${flavorName}`)}Options`,
          `Options for the \`${flavor.flavor}\` block flavor.`,
          valueSchema(flavor.options_schema, input, undefined, ""),
        ),
      );
    }
    const eventNames: Array<string> = [];
    const frames: Array<string> = [];
    for (const [eventName, node] of Object.entries(creator.api.events ?? {})) {
      const name = `${pascalCase(`${creatorName}.${eventName}`)}Event`;
      sections.push(
        emitConstant(
          name,
          node.description ?? `The \`${eventName}\` block event.`,
          valueSchema(node, result, undefined, ""),
        ),
      );
      eventNames.push(`    ${JSON.stringify(eventName)}: ${name},`);
      frames.push(
        `  Schema.Struct({ name: Schema.Literal(${JSON.stringify(eventName)}), payload: ${name} }),`,
      );
    }
    blockEventEntries.push(`  ${JSON.stringify(creator.name)}: {\n${eventNames.join("\n")}\n  },`);
    if (frames.length > 0) {
      sections.push(
        emitConstant(
          `Rex${pascalCase(creatorName)}EventFrame`,
          `Any event from a \`${creator.name}\` block: its name and its decoded fields.`,
          `Schema.Union([\n${frames.join("\n")}\n])`,
        ),
      );
    }
  }
  sections.push(
    `/** Payload codecs for the events each block creator sends, keyed by creator and event name. */\nexport const rexBlockEvents = {\n${blockEventEntries.join("\n")}\n} as const;\n`,
  );

  sections.push("// Server and session events.\n");
  for (const [group, record] of [
    ["Server", events.server_events],
    ["Session", events.session_events],
  ] as const) {
    const entries: Array<string> = [];
    const frames: Array<string> = [];
    for (const [eventName, node] of Object.entries(record)) {
      const name = `Rex${pascalCase(eventName)}Event`;
      sections.push(emitConstant(name, node.description, valueSchema(node, result, undefined, "")));
      entries.push(`  ${JSON.stringify(eventName)}: ${name},`);
      if (eventName !== "block_event") {
        frames.push(
          `  Schema.Struct({ type: Schema.Literal(${JSON.stringify(eventName)}), payload: ${name} }),`,
        );
      }
    }
    sections.push(
      emitConstant(
        `Rex${group}EventFrame`,
        `Any ${group.toLowerCase()} event${group === "Session" ? " other than block_event" : ""}: its type and its decoded fields.`,
        `Schema.Union([\n${frames.join("\n")}\n])`,
      ),
    );
    sections.push(
      `/** Payload codecs for ${group.toLowerCase()} events, keyed by event type. */\nexport const rex${group}Events = {\n${entries.join("\n")}\n} as const;\n`,
    );
  }

  return sections.join("\n");
}

const generateWireSchemas = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const root = join(import.meta.dirname, "..");
  const api = yield* decodeRexApiDocument(
    yield* fileSystem.readFileString(join(root, "schema/rex-api.json")),
  );
  const creators = yield* decodeRexBlockCreatorsDocument(
    yield* fileSystem.readFileString(join(root, "schema/rex-block-creators.json")),
  );
  const events = yield* decodeRexEventsDocument(
    yield* fileSystem.readFileString(join(root, "schema/rex-events.json")),
  );
  const output = generate(api, creators, events);
  const target = join(root, "src/generated/rex-wire-schemas.ts");
  if (process.argv.includes("--check")) {
    const existing = yield* fileSystem.readFileString(target).pipe(Effect.orElseSucceed(() => ""));
    if (existing !== output) {
      return yield* Effect.fail(
        new Error(
          "src/generated/rex-wire-schemas.ts is stale. Run `vp run generate` and commit the result.",
        ),
      );
    }
    yield* Console.log("Generated wire schemas are up to date.");
    return;
  }
  yield* fileSystem.makeDirectory(join(root, "src/generated"), { recursive: true });
  yield* fileSystem.writeFileString(target, output);
  yield* Console.log(`Wrote ${target}`);
});

NodeRuntime.runMain(generateWireSchemas.pipe(Effect.provide(NodeFileSystem.layer)));
