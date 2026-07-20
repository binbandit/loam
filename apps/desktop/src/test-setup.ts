import "@testing-library/jest-dom/vitest";

// jsdom lacks pointer capture; the @loam-app/ui split resizer uses it.
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};
Element.prototype.hasPointerCapture = () => false;

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
