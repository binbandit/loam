import { createRoot } from "react-dom/client";
import { App } from "./App";

const container = document.querySelector("#root");
if (container instanceof HTMLElement) {
  createRoot(container).render(<App />);
}
