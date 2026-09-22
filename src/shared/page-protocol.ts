export type PageAction = { id: string; kind: "fill" | "click"; label: string; role: string; disabled: boolean };
export type Observation = {
  status: "observed"; pageProtocolVersion: 2; snapshot: string; url: string; title: string; text: string; actions: PageAction[];
  mode: "full" | "controls-only"; partial: boolean;
  opaqueSurfaces: { id: string; kind: "iframe" | "frame" | "object" | "embed" | "closed-shadow-root" }[];
  truncation: { text: boolean; actions: boolean; opaqueSurfaces: boolean; labels: boolean; title: boolean };
};

export function parseObservation(value: unknown): Observation {
  const fail = (): never => { throw new Error("Invalid page protocol v2 observation"); };
  const object = (v: unknown): Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : fail();
  const string = (v: unknown, limit: number): string => typeof v === "string" && v.length <= limit ? v : fail();
  const bool = (v: unknown): boolean => typeof v === "boolean" ? v : fail();
  const raw = object(value), truncation = object(raw.truncation);
  if (raw.status !== "observed" || raw.pageProtocolVersion !== 2 || raw.mode !== "full" && raw.mode !== "controls-only"
    || !Array.isArray(raw.actions) || raw.actions.length > 100 || !Array.isArray(raw.opaqueSurfaces) || raw.opaqueSurfaces.length > 100) fail();
  const actions = (raw.actions as unknown[]).map((value): PageAction => {
    const a = object(value);
    if (a.kind !== "fill" && a.kind !== "click") return fail();
    return { id: string(a.id, 100), kind: a.kind, label: string(a.label, 160), role: string(a.role, 80), disabled: bool(a.disabled) };
  });
  const opaqueSurfaces = (raw.opaqueSurfaces as unknown[]).map((value, index) => {
    const o = object(value);
    if (Object.keys(o).length !== 2 || o.id !== `opaque-${index}` || typeof o.kind !== "string" || !["iframe", "frame", "object", "embed", "closed-shadow-root"].includes(o.kind)) return fail();
    return { id: string(o.id, 100), kind: o.kind as Observation["opaqueSurfaces"][number]["kind"] };
  });
  const flags = { text: bool(truncation.text), actions: bool(truncation.actions), opaqueSurfaces: bool(truncation.opaqueSurfaces), labels: bool(truncation.labels), title: bool(truncation.title) };
  const text = string(raw.text, 12000), snapshot = string(raw.snapshot, 200), partial = bool(raw.partial);
  if (!snapshot || actions.some(a => !a.id) || new Set(actions.map(a => a.id)).size !== actions.length
    || partial !== (opaqueSurfaces.length > 0) || flags.opaqueSurfaces && opaqueSurfaces.length !== 100
    || raw.mode === "controls-only" && (text !== "" || flags.text)) fail();
  return { status: "observed", pageProtocolVersion: 2, snapshot, url: string(raw.url, 8192), title: string(raw.title, 200), text, actions,
    mode: raw.mode as Observation["mode"], partial, opaqueSurfaces, truncation: flags };
}
