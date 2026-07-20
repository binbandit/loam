import "@testing-library/jest-dom/vitest";

// jsdom lacks pointer capture; Base UI sliders and the split resizer use it.
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};
Element.prototype.hasPointerCapture = () => false;
