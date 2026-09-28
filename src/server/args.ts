// FastMCP's argument pipeline for the 18 tools: pre_parse_json, then pydantic validation of the arguments model
// (lax fields coerce as pydantic-core does in Python mode; Field(strict=True) fields and the Step and
// PageExpectation models are strict and forbid extra keys), then defaults. Checked against
// tests/server/fixtures/python-arguments.json.
import type { Env } from "./config";
import { Gate } from "./gate";
import { origin } from "./page";
import { parsePythonJson } from "./pyjson";
import { pyLen } from "./pystr";

/**
 * A JSON number literal with a fraction or exponent whose value is integral, such as 100.0. Python keeps it a
 * float, which strict int fields refuse; a JS number cannot, so the stdio transport and pre_parse_json mark it.
 */
export class PyFloat {
  constructor(readonly value: number) {}
}

export interface ErrorDetail { type: string; loc: Array<string | number>; msg: string }

/** pydantic's ValidationError: the tool never runs. Its text approximates pydantic's (D10). */
export class ValidationError extends Error {
  readonly errors: ErrorDetail[];

  constructor(title: string, errors: ErrorDetail[]) {
    const lines = errors.map((error) => `${error.loc.join(".")}\n  ${error.msg} [type=${error.type}]`);
    super(`${errors.length} validation error${errors.length === 1 ? "" : "s"} for ${title}\n${lines.join("\n")}`);
    this.name = "ValidationError";
    this.errors = errors;
  }
}

type Loc = Array<string | number>;
type Errors = ErrorDetail[];
/** A validated value, or NONE when the field failed and its errors were collected. */
const NONE: unique symbol = Symbol("invalid");
type Result<T> = T | typeof NONE;

function isDict(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || value instanceof PyFloat) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function has(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function fail(errors: Errors, type: string, loc: Loc, msg: string): typeof NONE {
  errors.push({ type, loc, msg });
  return NONE;
}

/** A JSON number as Python sees it: an int, or a float (a PyFloat or a non-integral JS number). */
function numberOf(value: unknown): { value: number; float: boolean } | null {
  if (value instanceof PyFloat) return { value: value.value, float: true };
  if (typeof value === "number") return { value, float: !Number.isInteger(value) };
  return null;
}

// ---------------------------------------------------------------------------------------------- field kinds

interface StrOptions { min?: number; max?: number }

function validateStr(value: unknown, loc: Loc, errors: Errors, options: StrOptions = {}): Result<string> {
  if (typeof value !== "string") return fail(errors, "string_type", loc, "Input should be a valid string");
  const length = pyLen(value);
  if (options.min !== undefined && length < options.min) {
    return fail(errors, "string_too_short", loc, `String should have at least ${options.min} character${options.min === 1 ? "" : "s"}`);
  }
  if (options.max !== undefined && length > options.max) {
    return fail(errors, "string_too_long", loc, `String should have at most ${options.max} character${options.max === 1 ? "" : "s"}`);
  }
  return value;
}

const FALSE_WORDS = new Set(["f", "n", "no", "off", "false"]);
const TRUE_WORDS = new Set(["t", "y", "on", "yes", "true"]);

/** pydantic-core validate_bool in lax Python mode. */
function validateBool(value: unknown, loc: Loc, errors: Errors): Result<boolean> {
  if (typeof value === "boolean") return value;
  const parsing = (): typeof NONE => fail(errors, "bool_parsing", loc, "Input should be a valid boolean, unable to interpret input");
  if (typeof value === "string") {
    const lower = value.replace(/[A-Z]/g, (c) => c.toLowerCase());
    if (value === "0" || FALSE_WORDS.has(lower)) return false;
    if (value === "1" || TRUE_WORDS.has(lower)) return true;
    return parsing();
  }
  const number = numberOf(value);
  if (number !== null && Number.isFinite(number.value) && Number.isInteger(number.value)) {
    if (number.value === 0) return false;
    if (number.value === 1) return true;
    return parsing();
  }
  return fail(errors, "bool_type", loc, "Input should be a valid boolean");
}

/** Rust's str::trim: Unicode White_Space at both ends. */
function rustTrim(text: string): string {
  return text.replace(/^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g, "");
}

function stringInt(text: string): number | null {
  const trimmed = rustTrim(text);
  const parse = (candidate: string) => (/^[+-]?[0-9]+$/.test(candidate) ? Number(candidate) : null);
  const direct = parse(trimmed);
  if (direct !== null) return direct;
  const point = trimmed.indexOf(".");
  if (point >= 0 && /^0*$/.test(trimmed.slice(point + 1))) return parse(trimmed.slice(0, point));
  return null;
}

interface IntOptions { strict: boolean; ge?: number; le?: number }

function validateInt(value: unknown, loc: Loc, errors: Errors, options: IntOptions): Result<number> {
  const intType = (): typeof NONE => fail(errors, "int_type", loc, "Input should be a valid integer");
  let result: number;
  const number = numberOf(value);
  if (options.strict) {
    if (number === null || number.float) return intType();
    result = number.value;
  } else if (typeof value === "boolean") {
    result = value ? 1 : 0;
  } else if (typeof value === "string") {
    if (rustTrim(value).length > 4300) return fail(errors, "int_parsing_size", loc, "Unable to parse input string as an integer, exceeded maximum size");
    const parsed = stringInt(value);
    if (parsed === null) return fail(errors, "int_parsing", loc, "Input should be a valid integer, unable to parse string as an integer");
    result = parsed;
  } else if (number !== null) {
    if (!Number.isFinite(number.value)) return fail(errors, "finite_number", loc, "Input should be a finite number");
    if (!Number.isInteger(number.value)) return fail(errors, "int_from_float", loc, "Input should be a valid integer, got a number with a fractional part");
    result = number.value;
  } else {
    return intType();
  }
  if (options.ge !== undefined && !(result >= options.ge)) return fail(errors, "greater_than_equal", loc, `Input should be greater than or equal to ${options.ge}`);
  if (options.le !== undefined && !(result <= options.le)) return fail(errors, "less_than_equal", loc, `Input should be less than or equal to ${options.le}`);
  return result;
}

/** Field(strict=True) float with gt and le. */
function validateStrictFloat(value: unknown, loc: Loc, errors: Errors, options: { gt: number; le: number }): Result<number> {
  const number = numberOf(value);
  if (number === null) return fail(errors, "float_type", loc, "Input should be a valid number");
  if (!(number.value > options.gt)) return fail(errors, "greater_than", loc, `Input should be greater than ${options.gt}`);
  if (!(number.value <= options.le)) return fail(errors, "less_than_equal", loc, `Input should be less than or equal to ${options.le}`);
  return number.value;
}

function validateLiteral<T extends string>(value: unknown, loc: Loc, errors: Errors, values: readonly T[]): Result<T> {
  if (typeof value === "string" && (values as readonly string[]).includes(value)) return value as T;
  const quoted = values.map((item) => `'${item}'`);
  const text = quoted.length > 1 ? `${quoted.slice(0, -1).join(", ")} or ${quoted[quoted.length - 1]}` : quoted[0];
  return fail(errors, "literal_error", loc, `Input should be ${text}`);
}

function nullable<T>(value: unknown, inner: (value: unknown) => Result<T>): Result<T | null> {
  return value === null ? null : inner(value);
}

// ---------------------------------------------------------------------------------------------- models

type FieldValidator = (value: unknown, loc: Loc, errors: Errors, env: Env) => unknown;
interface ModelField { name: string; validate: FieldValidator; required?: boolean; fallback?: unknown }

/** A strict pydantic model with extra="forbid": fields in order, then extra keys, then the model validator. */
function validateModel(title: string, fields: readonly ModelField[], input: unknown, loc: Loc, errors: Errors, env: Env): Result<Record<string, unknown>> {
  if (!isDict(input)) return fail(errors, "model_type", loc, `Input should be a valid dictionary or instance of ${title}`);
  const before = errors.length;
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    if (!has(input, field.name)) {
      if (field.required) fail(errors, "missing", [...loc, field.name], "Field required");
      else values[field.name] = field.fallback ?? null;
      continue;
    }
    values[field.name] = field.validate(input[field.name], [...loc, field.name], errors, env);
  }
  for (const key of Object.keys(input)) {
    if (!fields.some((field) => field.name === key)) fail(errors, "extra_forbidden", [...loc, key], "Extra inputs are not permitted");
  }
  return errors.length > before ? NONE : values;
}

const EXPECTATION_FIELDS: readonly ModelField[] = [
  { name: "url", validate: (value, loc, errors) => nullable(value, (item) => validateStr(item, loc, errors, { min: 1, max: 8192 })) },
  { name: "text", validate: (value, loc, errors) => nullable(value, (item) => validateStr(item, loc, errors, { min: 1, max: 2000 })) },
  { name: "action_label", validate: (value, loc, errors) => nullable(value, (item) => validateStr(item, loc, errors, { min: 1, max: 2000 })) }
];

/** One public postcondition: URL, text and a unique enabled action label must match in one observation. */
export class PageExpectation {
  readonly url: string | null;
  readonly text: string | null;
  readonly action_label: string | null;

  /** PageExpectation(**fields): strict, extra keys forbidden; a bad URL raises its Gate from the validator. */
  constructor(input: unknown, env: Env = process.env) {
    const errors: Errors = [];
    const values = expectation(input, [], errors, env);
    if (values === NONE) throw new ValidationError("PageExpectation", errors);
    ({ url: this.url, text: this.text, action_label: this.action_label } = values);
  }

  /** model_copy(update={"url": ...}): no validation. */
  withUrl(url: string): PageExpectation {
    const copy = Object.create(PageExpectation.prototype) as { -readonly [K in keyof PageExpectation]: PageExpectation[K] };
    copy.url = url;
    copy.text = this.text;
    copy.action_label = this.action_label;
    return copy as PageExpectation;
  }

  toJSON(): Record<string, unknown> {
    return { url: this.url, text: this.text, action_label: this.action_label };
  }
}

function expectation(input: unknown, loc: Loc, errors: Errors, env: Env): Result<{ url: string | null; text: string | null; action_label: string | null }> {
  if (input instanceof PageExpectation) return input;
  const values = validateModel("PageExpectation", EXPECTATION_FIELDS, input, loc, errors, env);
  if (values === NONE) return NONE;
  const { url, text, action_label } = values as { url: string | null; text: string | null; action_label: string | null };
  if (!url && !text && !action_label) {
    return fail(errors, "value_error", loc, "Value error, At least one public expectation is required");
  }
  if (url !== null) {
    if (url.startsWith("/")) {
      if (url.startsWith("//") || /[\x00-\x20\x7f\\]/.test(url)) throw new Gate("fast-chrome-approved-web-url-required");
    } else {
      origin(url, env);
    }
  }
  return { url, text, action_label };
}

function expectationField(value: unknown, loc: Loc, errors: Errors, env: Env): Result<PageExpectation> {
  if (value instanceof PageExpectation) return value;
  const values = expectation(value, loc, errors, env);
  if (values === NONE) return NONE;
  const result = Object.create(PageExpectation.prototype) as Record<string, unknown>;
  Object.assign(result, values);
  return result as unknown as PageExpectation;
}

const STEP_FIELDS: readonly ModelField[] = [
  { name: "label", required: true, validate: (value, loc, errors) => validateStr(value, loc, errors, { min: 1, max: 160 }) },
  { name: "kind", validate: (value, loc, errors) => nullable(value, (item) => validateLiteral(item, loc, errors, ["fill", "click"] as const)) },
  { name: "role", validate: (value, loc, errors) => nullable(value, (item) => validateStr(item, loc, errors, { min: 1, max: 80 })) },
  { name: "text", validate: (value, loc, errors) => nullable(value, (item) => validateStr(item, loc, errors, { max: 2000 })) },
  { name: "expect", validate: (value, loc, errors, env) => nullable(value, (item) => expectationField(item, loc, errors, env)) },
  { name: "timeout_ms", validate: (value, loc, errors) => nullable(value, (item) => validateInt(item, loc, errors, { strict: true, ge: 1, le: 15000 })) }
];

/** One act_steps step: an exact enabled action label, optional exact kind/role, and public fill text. */
export class Step {
  readonly label: string;
  readonly kind: "fill" | "click" | null;
  readonly role: string | null;
  readonly text: string | null;
  readonly expect: PageExpectation | null;
  readonly timeout_ms: number | null;

  constructor(input: unknown, env: Env = process.env) {
    const errors: Errors = [];
    const values = step(input, [], errors, env);
    if (values === NONE) throw new ValidationError("Step", errors);
    ({ label: this.label, kind: this.kind, role: this.role, text: this.text, expect: this.expect, timeout_ms: this.timeout_ms } = values);
  }

  toJSON(): Record<string, unknown> {
    return { label: this.label, kind: this.kind, role: this.role, text: this.text, expect: this.expect?.toJSON() ?? null, timeout_ms: this.timeout_ms };
  }
}

function step(input: unknown, loc: Loc, errors: Errors, env: Env): Result<Step> {
  if (input instanceof Step) return input;
  const values = validateModel("Step", STEP_FIELDS, input, loc, errors, env);
  if (values === NONE) return NONE;
  const result = Object.create(Step.prototype) as Record<string, unknown>;
  Object.assign(result, values);
  return result as unknown as Step;
}

/** Annotated[list[Step], Field(min_length=1, max_length=10)]: the length cap stops at the eleventh item. */
function validateSteps(value: unknown, loc: Loc, errors: Errors, env: Env): Result<Step[]> {
  if (!Array.isArray(value)) return fail(errors, "list_type", loc, "Input should be a valid list");
  const local: Errors = [];
  const output: Step[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = step(value[index], [...loc, index], local, env);
    if (index + 1 > 10) return fail(errors, "too_long", loc, `List should have at most 10 items after validation, not ${value.length}`);
    if (item !== NONE) output.push(item);
  }
  if (local.length) {
    errors.push(...local);
    return NONE;
  }
  if (output.length < 1) return fail(errors, "too_short", loc, `List should have at least 1 item after validation, not ${output.length}`);
  return output;
}

// ---------------------------------------------------------------------------------------------- tools

interface ArgField { name: string; validate: FieldValidator; required?: boolean; fallback?: unknown; plainStr?: boolean }

const str = (name: string): ArgField => ({ name, required: true, plainStr: true, validate: (value, loc, errors) => validateStr(value, loc, errors) });
const optionalStr = (name: string): ArgField => ({ name, fallback: null, validate: (value, loc, errors) => nullable(value, (item) => validateStr(item, loc, errors)) });
const bool = (name: string, fallback: boolean): ArgField => ({ name, fallback, validate: (value, loc, errors) => validateBool(value, loc, errors) });
const laxInt = (name: string, fallback: number): ArgField => ({ name, fallback, validate: (value, loc, errors) => validateInt(value, loc, errors, { strict: false }) });
const strictInt = (name: string, fallback: number, le: number): ArgField => ({ name, fallback, validate: (value, loc, errors) => validateInt(value, loc, errors, { strict: true, ge: 1, le }) });

const ARGUMENTS: Readonly<Record<string, readonly ArgField[]>> = {
  status: [],
  tabs: [],
  claim_browser: [
    optionalStr("site"), bool("exclusive", false),
    { name: "timeout_seconds", fallback: 30, validate: (value, loc, errors) => validateStrictFloat(value, loc, errors, { gt: 0, le: 120 }) }
  ],
  release_browser: [str("lease_id")],
  open_tab: [str("url"), optionalStr("group_title")],
  claim_tab: [str("tab_id"), optionalStr("group_title")],
  name_group: [str("tab_id"), str("title")],
  observe: [str("tab_id"), bool("controls_only", false)],
  wait_for: [str("tab_id"), { name: "expect", required: true, validate: expectationField }, strictInt("timeout_ms", 10000, 15000)],
  navigate: [str("tab_id"), str("url")],
  act: [
    str("tab_id"), str("snapshot_id"), str("action_id"), optionalStr("text"),
    { name: "expect", fallback: null, validate: (value, loc, errors, env) => nullable(value, (item) => expectationField(item, loc, errors, env)) },
    strictInt("timeout_ms", 10000, 15000)
  ],
  act_steps: [
    str("tab_id"), { name: "steps", required: true, validate: validateSteps }, optionalStr("snapshot_id"), bool("include_text", false),
    strictInt("timeout_ms", 30000, 60000)
  ],
  upload_file: [str("tab_id"), str("snapshot_id"), str("action_id"), str("path")],
  paste_1password_field: [
    str("tab_id"), str("expected_url"), str("expected_email"),
    { name: "field", required: true, validate: (value, loc, errors) => validateLiteral(value, loc, errors, ["password", "one-time password"] as const) },
    str("selector"), optionalStr("username_selector"), optionalStr("snapshot_id"), optionalStr("submit_action_id"),
    bool("allow_foreground_search", false)
  ],
  screenshot: [str("tab_id")],
  start_recording: [str("tab_id"), laxInt("fps", 5), laxInt("max_seconds", 30)],
  stop_recording: [str("tab_id")],
  release: [str("tab_id"), bool("keep_open", false)]
};

export const TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(ARGUMENTS));

/**
 * FastMCP pre_parse_json: a string for a field whose annotation is not exactly str is replaced by its JSON value
 * when that value is not a str, int or float (a bool counts as an int). Other strings stay as they are.
 */
function preParse(field: ArgField, value: unknown): unknown {
  if (field.plainStr || typeof value !== "string") return value;
  let parsed: unknown;
  try {
    parsed = parsePythonJson(value);
  } catch {
    return value;
  }
  if (typeof parsed === "string" || typeof parsed === "number" || typeof parsed === "boolean") return value;
  return markFloats(parsed, value);
}

/** Re-read JSON that parsed as a list or object with source-text access, so integral float literals stay floats. */
function markFloats(parsed: unknown, text: string): unknown {
  try {
    return JSON.parse(text, reviveFloats);
  } catch {
    return parsed;
  }
}

/** A JSON.parse reviver that marks integral float literals (Node 24 passes the source text). */
export function reviveFloats(this: unknown, _key: string, value: unknown, context?: { source?: string }): unknown {
  if (typeof value === "number" && Number.isInteger(value) && context?.source !== undefined && /[.eE]/.test(context.source)) {
    return new PyFloat(value);
  }
  return value;
}

/** Validate one tool's arguments like FastMCP; unknown keys are ignored. Throws ValidationError or a Gate. */
export function validateArguments(tool: string, args: unknown, env: Env = process.env): Record<string, unknown> {
  const fields = ARGUMENTS[tool];
  if (!fields) throw new Error(`unknown tool ${tool}`);
  const input = isDict(args) ? args : {};
  const errors: Errors = [];
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    if (!has(input, field.name)) {
      if (field.required) fail(errors, "missing", [field.name], "Field required");
      else values[field.name] = field.fallback;
      continue;
    }
    const value = field.validate(preParse(field, input[field.name]), [field.name], errors, env);
    values[field.name] = value instanceof PyFloat ? value.value : value;
  }
  if (errors.length) throw new ValidationError(`${tool}Arguments`, errors);
  return values;
}

/** model_dump(mode="json") of validated arguments, for comparison with the captured Python values. */
export function dumpArguments(values: Record<string, unknown>): unknown {
  return JSON.parse(JSON.stringify(values));
}
