import "@testing-library/jest-dom/vitest";

// jsdom lacks pointer capture; the @loam-app/ui split resizer uses it.
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};
Element.prototype.hasPointerCapture = () => false;

// jsdom's Range has no layout; CM6 measures text with it whenever a gutter
// is present. Zero rects are the right answer in a zero-size document.
if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => Object.assign([], { item: () => null }) as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
}

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
