type Observation = { token: string; origin: string; url: string; document: Document; nodes: (HTMLInputElement | HTMLTextAreaElement)[]; selectors: string[] };
type PrivateWorld = typeof globalThis & { __opzeroPrivateInput?: Observation; __opzeroPrivateNodes?: WeakSet<Element>; __opzeroPrivateDocument?: boolean; __opzeroPrivateForms?: Set<HTMLFormElement> };

export function observePrivateFields(expectedOrigin: string, selectors: string[], token: string, allowInsecureLoopback = false, expectedUrl?: string) {
  const world = globalThis as PrivateWorld;
  delete world.__opzeroPrivateInput;
  const secure = location.protocol === "https:" || (allowInsecureLoopback && location.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname));
  const url = location.href;
  if (location.origin !== expectedOrigin || (expectedUrl !== undefined && url !== expectedUrl) || !secure || window !== window.top) return { status: "refused" };
  try {
    const nodes = selectors.map(selector => {
      const matches = document.querySelectorAll(selector);
      const node = matches[0];
      if (matches.length !== 1 || !(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)
        || node.disabled || node.readOnly || node.closest("[inert]") || !node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true })
        || (node instanceof HTMLInputElement && !["text", "email", "password", "tel", "search", "url"].includes(node.type))) throw new Error();
      return node;
    });
    if (new Set(nodes).size !== nodes.length) return { status: "refused" };
    world.__opzeroPrivateInput = { token, origin: location.origin, url, document, nodes, selectors };
    return { status: "observed", origin: location.origin, url };
  } catch { return { status: "refused" }; }
}

export function fillPrivateFields(expectedOrigin: string, token: string, values: string[]) {
  const world = globalThis as PrivateWorld;
  const observed = world.__opzeroPrivateInput;
  delete world.__opzeroPrivateInput;
  const fresh = () => observed && observed.token === token && observed.origin === expectedOrigin
    && location.origin === expectedOrigin && location.href === observed.url && observed.document === document && window === window.top
    && observed.nodes.every((node, i) => node.isConnected && node.ownerDocument === document
      && document.querySelectorAll(observed.selectors[i]).length === 1 && document.querySelector(observed.selectors[i]) === node
      && !node.disabled && !node.readOnly && !node.closest("[inert]") && node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true })
      && (!(node instanceof HTMLInputElement) || ["text", "email", "password", "tel", "search", "url"].includes(node.type)));
  try {
    if (!fresh() || !observed || observed.nodes.length !== values.length) return { status: "refused" };
    world.__opzeroPrivateDocument = true;
    world.__opzeroPrivateNodes ??= new WeakSet();
    world.__opzeroPrivateForms ??= new Set();
    for (const node of observed.nodes) {
      world.__opzeroPrivateNodes.add(node);
      if (node.form) world.__opzeroPrivateForms.add(node.form);
    }
    for (let i = 0; i < values.length; i++) {
      if (!fresh()) return { status: "unknown" };
      const node = observed.nodes[i];
      const prototype = node instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (!setter) return { status: "unknown" };
      setter.call(node, values[i]);
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return { status: fresh() ? "filled" : "unknown" };
  } catch { return { status: "unknown" }; }
}
