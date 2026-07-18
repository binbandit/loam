// Minimal web entry so the browser test harness has a real target (LOA-8).
// The React app shell replaces this in E08.
const root = document.querySelector("#root");
if (root instanceof HTMLElement) {
  root.textContent = "Loam";
  root.dataset.ready = "true";
}
