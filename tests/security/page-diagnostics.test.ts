import { afterEach, expect, it, vi } from "vitest";
import { pageControl } from "../../src/extension/page-control";

afterEach(() => vi.unstubAllGlobals());

it("allows embedded surfaces while preserving fixed private diagnostics", () => {
  class Input { value = "synthetic-secret"; type = "password"; autocomplete = ""; }
  let inputs: Input[] = [], embedded = false;
  vi.stubGlobal("window", { top: undefined });
  window.top = window;
  vi.stubGlobal("location", { origin: "https://synthetic.invalid" });
  vi.stubGlobal("HTMLInputElement", Input);
  vi.stubGlobal("HTMLTextAreaElement", class {});
  vi.stubGlobal("HTMLElement", class {});
  vi.stubGlobal("chrome", { dom: { openOrClosedShadowRoot: () => null } });
  vi.stubGlobal("document", {
    childNodes: [],
    querySelectorAll: (selector: string) => {
      if (selector === "[") throw new Error("synthetic-secret");
      return inputs;
    },
    querySelector: () => embedded ? {} : null,
  });
  const check = (text = "[]") => pageControl("capture-check", location.origin, "", "", text);
  expect(check()).toEqual({ status: "checked", allowed: true });
  embedded = true;
  expect(check()).toEqual({ status: "checked", allowed: true });
  inputs = [new Input()];
  expect(check().reason).toBe("populated-private-input");
  inputs[0].type = "text";
  inputs[0].autocomplete = "one-time-code";
  expect(check().reason).toBe("populated-private-input");
  inputs[0].autocomplete = "";
  vi.stubGlobal("__opzeroPrivateNodes", new WeakSet(inputs));
  expect(check().reason).toBe("populated-private-input");
  vi.stubGlobal("__opzeroPrivateNodes", new WeakSet());
  expect(check('["#synthetic-private"]').reason).toBe("restored-private-selector");
  for (const malformed of ["{", "{}", "[1]", '["["]']) {
    expect(check(malformed)).toEqual({ status: "checked", allowed: false, reason: "invalid-private-selectors" });
  }
  vi.stubGlobal("__opzeroPrivateDocument", true);
  expect(check().reason).toBe("private-quarantine");
  expect(check("{").reason).toBe("private-quarantine");
});
