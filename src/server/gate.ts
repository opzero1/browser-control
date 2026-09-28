/** A fixed refusal. The message is the code, so nothing caller- or page-controlled reaches an error text. */
export class Gate extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "Gate";
  }
}

export function isGate(error: unknown, code?: string): error is Gate {
  return error instanceof Gate && (code === undefined || error.code === code);
}

/** The MCP result for a refused call, as FastMCP rendered a raised Gate. */
export function gateResult(tool: string, code: string): { isError: true; content: [{ type: "text"; text: string }] } {
  return { isError: true, content: [{ type: "text", text: `Error executing tool ${tool}: ${code}` }] };
}
