// The D19 renames, for comparing captured Python output with the port. Captured fixtures stay verbatim.

/** Python error-code prefix and its replacement. */
export const PYTHON_CODE_PREFIX = "opchrome-";
export const CODE_PREFIX = "browser-control-";

/** The fifteen error codes Python raised under the retired prefix. */
export const RENAMED_CODES = [
  "opchrome-outcome-unknown", "opchrome-private-page", "opchrome-unavailable", "opchrome-page-not-ready",
  "opchrome-operation-refused", "opchrome-invalid-request", "opchrome-protocol-mismatch",
  "opchrome-private-fields-unavailable", "opchrome-private-quarantine", "opchrome-unsupported-page",
  "opchrome-unsupported-shadow-root", "opchrome-restored-private-selector", "opchrome-populated-private-input",
  "opchrome-invalid-private-selectors", "opchrome-embedded-surface"
] as const;

/** A Python error code as the port raises it. */
export function code(python: string): string {
  return python.startsWith(PYTHON_CODE_PREFIX) ? CODE_PREFIX + python.slice(PYTHON_CODE_PREFIX.length) : python;
}

/** Text replacements in tool descriptions, instructions and the status backend value. */
export const TEXT_RENAMES: ReadonlyArray<readonly [string, string]> = [
  ["Control Chrome through op-chrome observed DOM actions.", "Control Chrome through Browser Control observed DOM actions."],
  ["its op-chrome endpoint", "its Browser Control endpoint"],
  ["Load chrome-control", "Load browser-control"],
  ["\"backend\": \"op-chrome\"", "\"backend\": \"browser-control\""]
];

/** Apply every D19 rename to captured Python text (tool text, result text, error text). */
export function renamePython(text: string): string {
  let result = text.replaceAll(/opchrome-([a-z-]+)/g, `${CODE_PREFIX}$1`);
  for (const [from, to] of TEXT_RENAMES) result = result.replaceAll(from, to);
  return result;
}
