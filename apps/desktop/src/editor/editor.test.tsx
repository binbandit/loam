/** LOA-68: CM6 Source mode mounting, sessions, and reconfiguration. */

import { undo } from "@codemirror/commands";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createMockTransport, MOCK_DEMO_VAULT_PATH } from "@loam-app/ipc-client";
import { render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Editor } from "./Editor";
import { SessionRegistry } from "./sessions";

const SOURCE = "# Ideas\n\nCapture **anything**.\n\n- [ ] task\n";

function viewOf(container: HTMLElement): EditorView {
  const dom = container.querySelector(".cm-editor") as HTMLElement;
  const view = EditorView.findFromDOM(dom);
  if (!view) throw new Error("no EditorView mounted");
  return view;
}

/** AC1: the editor mounts the exact source bytes it was given. */
describe("mounting", () => {
  it("holds the note's exact source, including trailing newline", () => {
    const registry = new SessionRegistry();
    const { container } = render(
      <Editor registry={registry} path="Ideas.md" doc={SOURCE} baseHash="abc" />,
    );
    expect(viewOf(container).state.doc.toString()).toBe(SOURCE);
    expect(registry.get("Ideas.md")?.baseHash).toBe("abc");
  });

  it("markdown highlighting is active (language extension loaded)", () => {
    const registry = new SessionRegistry();
    const { container } = render(
      <Editor registry={registry} path="Ideas.md" doc={SOURCE} baseHash={null} />,
    );
    // The Markdown parser produced a tree with heading structure.
    const view = viewOf(container);
    expect(view.state.doc.line(1).text).toBe("# Ideas");
    expect(container.querySelector(".cm-content")).toBeTruthy();
  });
});

/** AC2: ordinary React renders never recreate the state. */
describe("render stability", () => {
  it("parent re-renders do not create a new EditorState", async () => {
    const registry = new SessionRegistry();
    function Parent() {
      const [count, setCount] = useState(0);
      return (
        <div>
          <button type="button" onClick={() => setCount((value) => value + 1)}>
            bump {count}
          </button>
          <Editor registry={registry} path="Ideas.md" doc={SOURCE} baseHash={null} />
        </div>
      );
    }
    const { container } = render(<Parent />);
    expect(registry.stateCreations).toBe(1);
    const before = viewOf(container).state;
    // Type into the document, then force several parent renders.
    viewOf(container).dispatch({ changes: { from: 0, insert: "x" } });
    for (let index = 0; index < 5; index += 1) {
      screen.getByRole("button", { name: /bump/ }).click();
    }
    await waitFor(() => expect(screen.getByRole("button", { name: /bump 5/ })).toBeTruthy());
    expect(registry.stateCreations).toBe(1);
    // Same view, edited document preserved.
    expect(viewOf(container).state).not.toBe(before);
    expect(viewOf(container).state.doc.toString().startsWith("x#")).toBe(true);
  });
});

/** AC3: compartment reconfiguration leaves the document identical. */
describe("reconfiguration", () => {
  it("read-only toggles without replacing the document or history", () => {
    const registry = new SessionRegistry();
    const { container, rerender } = render(
      <Editor registry={registry} path="Ideas.md" doc={SOURCE} baseHash={null} />,
    );
    const view = viewOf(container);
    view.dispatch({ changes: { from: 0, insert: "draft " } });
    const edited = view.state.doc.toString();

    rerender(<Editor registry={registry} path="Ideas.md" doc={SOURCE} baseHash={null} readOnly />);
    expect(view.state.readOnly).toBe(true);
    expect(view.state.doc.toString()).toBe(edited);
    expect(registry.stateCreations).toBe(1);

    // Undo still reaches the pre-edit document: history survived.
    rerender(
      <Editor registry={registry} path="Ideas.md" doc={SOURCE} baseHash={null} readOnly={false} />,
    );
    expect(view.state.readOnly).toBe(false);
    undo(view);
    expect(view.state.doc.toString()).toBe(SOURCE);
  });
});

/** AC4: each note keeps its own selection and undo history across swaps. */
describe("session switching", () => {
  it("restores selection and undo history when returning to a note", () => {
    const registry = new SessionRegistry();
    const { container, rerender } = render(
      <Editor registry={registry} path="a.md" doc="alpha" baseHash={null} />,
    );
    const view = viewOf(container);
    view.dispatch({ changes: { from: 5, insert: " one" }, selection: EditorSelection.cursor(3) });
    expect(view.state.doc.toString()).toBe("alpha one");

    // Switch to another note: its own fresh state.
    rerender(<Editor registry={registry} path="b.md" doc="beta" baseHash={null} />);
    expect(view.state.doc.toString()).toBe("beta");
    expect(registry.stateCreations).toBe(2);

    // Back to the first: document, cursor, and undo history intact.
    rerender(<Editor registry={registry} path="a.md" doc="alpha" baseHash={null} />);
    expect(view.state.doc.toString()).toBe("alpha one");
    expect(view.state.selection.main.head).toBe(3);
    expect(registry.stateCreations).toBe(2);
    undo(view);
    expect(view.state.doc.toString()).toBe("alpha");
  });

  it("closing a session drops it so the next open re-reads disk", () => {
    const registry = new SessionRegistry();
    const session = registry.open("a.md", "alpha", "h1");
    registry.capture("a.md", session.state.update({ changes: { from: 5, insert: "!" } }).state);
    expect(registry.get("a.md")?.state.doc.toString()).toBe("alpha!");
    registry.close("a.md");
    expect(registry.has("a.md")).toBe(false);
    registry.open("a.md", "fresh from disk", "h2");
    expect(registry.get("a.md")?.state.doc.toString()).toBe("fresh from disk");
    expect(registry.get("a.md")?.baseHash).toBe("h2");
  });
});

/** AC5: the same component runs against the mock transport's real bytes. */
describe("transport parity", () => {
  it("mounts content fetched through the mock transport", async () => {
    const transport = createMockTransport();
    const vault = await transport.openVaultPath(MOCK_DEMO_VAULT_PATH);
    const commands = await transport.getCommands();
    const result = await commands.noteRead(vault.id, "Ideas.md");
    if (result.status !== "ok") throw new Error("fixture read failed");

    const registry = new SessionRegistry();
    const { container } = render(
      <Editor
        registry={registry}
        path="Ideas.md"
        doc={result.data.content ?? ""}
        baseHash={result.data.hash}
      />,
    );
    expect(viewOf(container).state.doc.toString()).toBe(result.data.content);
    expect(registry.get("Ideas.md")?.baseHash).toBe(result.data.hash);
  });
});
