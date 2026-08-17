import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(cleanup);

// jsdom implements neither of these, and the draft rooms use both: the player
// list positions its popovers off getBoundingClientRect, and several panels
// observe their container. Without stubs the components throw on mount and the
// test fails for a reason that has nothing to do with what it is checking.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

// jsdom DOES define window.alert — it throws "Not implemented" when actually
// called, rather than being absent — so `!window.alert` never catches it.
// Always replace it; a real render test that triggers the failed-pick path
// needs a no-op it can assert against.
window.alert = vi.fn();

if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// jsdom returns all-zero rects; harmless for these tests but it keeps the
// popover positioning maths off NaN.
Element.prototype.getBoundingClientRect = function () {
  return { top: 0, left: 0, bottom: 0, right: 0, width: 100, height: 20, x: 0, y: 0, toJSON: () => ({}) };
};
