/**
 * In-page benchmark seam (LOA-90, §5.9). `scripts/editor-bench.mjs` drives
 * these from a real browser so the numbers come from the extension stack the
 * app actually ships — `extensionLayers()` is the same list `sourceExtensions()`
 * is built from, so the profile can never drift from the editor.
 *
 * Exposed only when the mock transport is in use (browser/demo builds),
 * exactly like the existing `__LOAM_MOCK__` e2e seam.
 */

import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { type ExtensionLayer, extensionLayers } from "./sessions";
import { loamAppearance } from "./theme";

export interface BenchStats {
  samples: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface LayerCost {
  layer: string;
  description: string;
  /** Mean keystroke cost of the stack up to and including this layer. */
  cumulativeMeanMs: number;
  /**
   * What this layer adds per keystroke. Means, not p95s: the browser clamps
   * `performance.now()` to 100 µs, and most layers cost less than one tick
   * of that — averaging is the only way to resolve them at all.
   */
  marginalMeanMs: number;
  cumulativeP95Ms: number;
}

function percentile(sorted: number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

function summarize(samples: number[]): BenchStats {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    meanMs: sorted.reduce((total, value) => total + value, 0) / Math.max(1, sorted.length),
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted.at(-1) ?? 0,
  };
}

/** A deterministic ~10k-word Markdown document (§5.9 reference shape). */
export function benchDocument(words = 10_000): string {
  const vocabulary = [
    "atlas",
    "brook",
    "cedar",
    "delta",
    "ember",
    "fjord",
    "grove",
    "harbor",
    "island",
    "juniper",
  ];
  const lines: string[] = ["# Bench note", ""];
  let produced = 0;
  let index = 0;
  while (produced < words) {
    if (index % 40 === 0) lines.push(`## Section ${index / 40 + 1}`, "");
    const sentence: string[] = [];
    for (let word = 0; word < 12 && produced < words; word += 1) {
      sentence.push(vocabulary[(index * 7 + word * 3) % vocabulary.length] as string);
      produced += 1;
    }
    lines.push(index % 6 === 5 ? `- ${sentence.join(" ")}` : sentence.join(" "));
    if (index % 6 === 5) lines.push("");
    index += 1;
  }
  return `${lines.join("\n")}\n`;
}

interface Harness {
  view: EditorView;
  dispose(): void;
}

function mount(doc: string, extensions: Extension[]): Harness {
  const parent = document.createElement("div");
  // Real layout, off to the side: CM6 must measure like it does in the app.
  parent.style.cssText = "position:fixed;left:0;top:0;width:900px;height:600px;";
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [...extensions, loamAppearance()] }),
    parent,
  });
  return {
    view,
    dispose() {
      view.destroy();
      parent.remove();
    },
  };
}

/**
 * Per-keystroke editor cost: one character inserted mid-document, plus the
 * synchronous DOM write and the layout it forces. Browser paint and vsync are
 * outside this number — everything the editor itself does is inside it.
 */
function typingSamples(view: EditorView, keystrokes: number, warmup: number): number[] {
  const samples: number[] = [];
  let at = Math.floor(view.state.doc.length / 2);
  for (let index = 0; index < warmup + keystrokes; index += 1) {
    const letter = "abcdefghij"[index % 10] as string;
    const started = performance.now();
    view.dispatch({
      changes: { from: at, insert: letter },
      selection: EditorSelection.cursor(at + 1),
      userEvent: "input.type",
      scrollIntoView: true,
    });
    // Force the layout the browser would otherwise defer, so the sample
    // includes CM6's DOM write *and* the style/layout it costs.
    void view.contentDOM.offsetHeight;
    const elapsed = performance.now() - started;
    at += 1;
    if (index >= warmup) samples.push(elapsed);
  }
  return samples;
}

export interface BenchOptions {
  words?: number;
  keystrokes?: number;
  warmup?: number;
}

/** AC1: keystroke latency in a 10k-word document with the full stack. */
export function benchTyping(options: BenchOptions = {}): BenchStats {
  const { words = 10_000, keystrokes = 300, warmup = 100 } = options;
  const layers = extensionLayers();
  const harness = mount(
    benchDocument(words),
    layers.flatMap((layer) => layer.extensions),
  );
  try {
    return summarize(typingSamples(harness.view, keystrokes, warmup));
  } finally {
    harness.dispose();
  }
}

/** AC5: what each extension layer costs per keystroke, cumulatively. */
export function benchLayers(options: BenchOptions = {}): LayerCost[] {
  const { words = 10_000, keystrokes = 150, warmup = 50 } = options;
  const doc = benchDocument(words);
  const layers: ExtensionLayer[] = extensionLayers();
  const costs: LayerCost[] = [];
  const stack: Extension[] = [];
  let previous = 0;
  for (const layer of layers) {
    stack.push(...layer.extensions);
    const harness = mount(doc, [...stack]);
    try {
      const stats = summarize(typingSamples(harness.view, keystrokes, warmup));
      costs.push({
        layer: layer.name,
        description: layer.description,
        cumulativeMeanMs: stats.meanMs,
        marginalMeanMs: stats.meanMs - previous,
        cumulativeP95Ms: stats.p95Ms,
      });
      previous = stats.meanMs;
    } finally {
      harness.dispose();
    }
  }
  return costs;
}

export interface ScalingPoint {
  words: number;
  meanMs: number;
  p95Ms: number;
}

/**
 * LOA-119 AC3: a local edit must cost the same in a long note as in a short
 * one. Decoration is viewport-only, so text the reader cannot see must not
 * enter the keystroke path — this measures the same edit at several document
 * sizes and the gate compares the ends.
 */
export function benchScaling(sizes: readonly number[] = [2_000, 10_000, 40_000]): ScalingPoint[] {
  const layers = extensionLayers();
  const extensions = layers.flatMap((layer) => layer.extensions);
  return sizes.map((words) => {
    const harness = mount(benchDocument(words), extensions);
    try {
      const stats = summarize(typingSamples(harness.view, 120, 40));
      return { words, meanMs: stats.meanMs, p95Ms: stats.p95Ms };
    } finally {
      harness.dispose();
    }
  });
}

export const editorBench = { benchTyping, benchLayers, benchDocument, benchScaling };
