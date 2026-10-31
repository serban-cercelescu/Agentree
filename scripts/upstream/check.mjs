// The upstream watch's judgements, apart from its network and vendor calls so
// they can be tested on controlled inputs (test/upstream.test.ts).
//
// A lookup has three outcomes, not two: current, new, or could not determine.
// "Nothing new" must never be what a failed lookup looks like.
import { Ajv } from "ajv";

// ------------------------------------------------------------------ Codex

/**
 * A copy in which an object with named properties takes only those. JSON
 * Schema leaves objects open by default, so a field Codex dropped would still
 * validate; what `additionalProperties` says is not evidence it was kept.
 * Free-form objects, which name nothing, stay open. `required` keeps only the
 * fields it says to, for a response whose other fields Agentree never reads.
 */
function closed(schema, required) {
  if (Array.isArray(schema)) return schema.map((s) => closed(s, required));
  if (!schema || typeof schema !== "object") return schema;
  const out = Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, closed(v, required)]));
  if (schema.properties) out.additionalProperties = false;
  if (required && Array.isArray(schema.required)) out.required = schema.required.filter(required);
  return out;
}

// Formats like int64 are Rust's, and the ids Agentree sends are plain numbers.
const validator = (schema, required) => new Ajv({ strict: false, validateFormats: false, allErrors: true }).compile(closed(schema, required));
const said = (e) =>`${e.instancePath || "message"} ${e.message}${e.params?.additionalProperty ? `: \`${e.params.additionalProperty}\`` : ""}`;

/** Why `union`, a generated `oneOf` with one branch per method, wouldn't take this message. */
function wireProblems(union, message) {
  const branch = union.oneOf?.find((b) => b.properties?.method?.enum?.includes(message.method));
  if (!branch) return [`no \`${message.method}\` in the stable schema`];
  const valid = validator({ ...branch, definitions: union.definitions });
  return valid(message) ? [] : valid.errors.map((e) => `\`${message.method}\` ${said(e)}`);
}

/**
 * A schema's types and nothing else: references, composition and the fields
 * of objects stay, and every constraint on a value goes. One value of a type
 * then stands for the whole type, which a `minimum` or a `minItems` would
 * prevent. Constraints only narrow, so this allows at least what the original
 * does. `oneOf` counts matches, which takes the constraints, so it becomes
 * "any of".
 */
function typesOnly(schema) {
  if (!schema || typeof schema !== "object") return schema;
  const each = (list) => list.map(typesOnly);
  const fields = (map) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, typesOnly(v)]));
  const { $ref, type, anyOf, allOf = [], oneOf, properties, definitions } = schema;
  const all = [...each(allOf), ...(oneOf ? [{ anyOf: each(oneOf) }] : [])];
  return {
    ...($ref && { $ref }),
    ...(type && { type }),
    ...(anyOf && { anyOf: each(anyOf) }),
    ...(all.length && { allOf: all }),
    ...(properties && { properties: fields(properties) }),
    ...(definitions && { definitions: fields(definitions) }),
  };
}

/** A value of each JSON type, to ask `typesOnly` what a schema allows. */
const OF_TYPE = { string: "x", integer: 1, number: 1.5, boolean: true, null: null, object: {}, array: [] };

/**
 * What a fork's response guarantees for the fields Agentree reads. A request
 * is the other way round: there, the schema accepting a sample is enough,
 * because Agentree chooses the value. Here Codex chooses, so each field must
 * refuse every type the client can't use, and whatever is in `least`, the
 * smallest answer the client can work with, must be required. Codex's other
 * required fields are its own affair, and a field with a fallback may go.
 */
function responseProblems(schema, { least, reads }) {
  const paths = Object.keys(reads).map((p) => p.split("."));
  const inLeast = (path) => path.reduce((o, k) => o?.[k], least) !== undefined;
  const needed = paths.filter(inLeast);
  const valid = validator(schema, (name) => needed.some((p) => p.at(-1) === name));
  const allows = validator(typesOnly(schema));
  const answer = (path, value) => {
    const out = structuredClone(least);
    const holder = path.slice(0, -1).reduce((o, k) => o[k], out);
    if (value === undefined) delete holder[path.at(-1)];
    else holder[path.at(-1)] = value;
    return out;
  };

  const problems = valid(least) ? [] : valid.errors.map((e) => `thread/fork's response ${said(e)}`);
  for (const path of needed) if (valid(answer(path))) problems.push(`thread/fork's response no longer promises \`${path.join(".")}\``);
  for (const path of paths) {
    const usable = reads[path.join(".")];
    for (const [type, value] of Object.entries(OF_TYPE)) {
      if (!usable.includes(type) && allows(answer(path, value))) problems.push(`thread/fork's response allows \`${path.join(".")}\` to be ${type}`);
    }
  }
  return problems;
}

/**
 * Whether the schema Codex generates takes the messages Agentree sends
 * (`sent`: baseline.json's `codex`, which test/appserver.test.ts holds equal to
 * the client) and answers a fork with what Agentree reads.
 */
export function codexProblems({ request, notification, forkResponse }, sent) {
  if (!request || !notification || !forkResponse) return ["no ClientRequest, ClientNotification or ThreadForkResponse schema"];
  const problems = [];
  for (const [method, params] of Object.entries(sent.requests)) problems.push(...wireProblems(request, { id: 1, method, params }));
  for (const method of sent.notifications) problems.push(...wireProblems(notification, { method }));
  problems.push(...responseProblems(forkResponse, sent.forkResponse));
  return problems;
}

/**
 * One contract, at a version actually resolved: no version, no check, so the
 * evidence always names what was inspected. A failure on the way is "could
 * not determine", which is not a break.
 */
export async function contractResult(resolve, check) {
  try {
    return check(await resolve());
  } catch (e) {
    return { evidence: "the check could not run", problems: [], unknown: [String(e.stderr || e.message).trim().split("\n").slice(-3).join(" ")], notes: [] };
  }
}

// ------------------------------------------------------------------ releases

/**
 * The newest stable version of a Marketplace extension (versions come newest
 * first), or null. Prereleases are numbered apart from stable builds, higher
 * in Codex's case, so one must never stand in for a stable release.
 */
export function latestStable(extension) {
  const pre = (v) => v.properties?.some((p) => p.key === "Microsoft.VisualStudio.Code.PreRelease" && p.value === "true");
  const v = extension.versions.find((x) => !pre(x));
  return v ? { latest: v.version, published: v.lastUpdated } : null;
}

/**
 * One row of the releases table. `lookup` resolves to { latest, published,
 * since, isNew }; `since` is null when `reviewed` is: nothing was read, so
 * there's nothing to count from, and a package nobody tracks yet (Copilot,
 * until the provider is revisited) doesn't ask for attention every week.
 */
export async function releaseRow(label, info, lookup) {
  try {
    const found = await lookup();
    return { label, info, ...found, state: found.isNew ? "new" : "current" };
  } catch (e) {
    return { label, info, state: "unknown", error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The run's outcome. `contracts` are the checks' results: `problems` are
 * breaks, `unknown` what couldn't be determined. Either fails the run: a
 * report that can't be trusted shouldn't look like a quiet week.
 */
export function verdict(rows, contracts) {
  const broken = contracts.some((c) => c.problems.length > 0);
  const incomplete = rows.some((r) => r.state === "unknown") || contracts.some((c) => c.unknown?.length > 0);
  const attention = broken || incomplete || rows.some((r) => r.state === "new") || contracts.some((c) => c.attention);
  return { attention, broken, incomplete, exitCode: broken || incomplete ? 1 : 0 };
}
