/**
 * Find/replace panel (LOA-74, §3.2/§4.3). Loam's own panel over CM6's
 * search extension: E07 controls on §4.2 tokens, live match count,
 * highlight-all, regex/case/whole-word toggles, and Escape that returns
 * focus and the selection the user came from.
 */

import type { Command } from "@codemirror/view";
import { IconButton, Input, Segment, SegmentedControl } from "@loam-app/ui";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  applyQuery,
  countMatches,
  findNextMatch,
  findPreviousMatch,
  regexError,
  replaceCurrent,
  replaceEvery,
} from "../editor/search";
import type { SessionRegistry } from "../editor/sessions";
import "./shell.css";

export interface FindPanelProps {
  registry: SessionRegistry;
  path: string;
  /** Replace row visible (⌘⌥F opens straight into it). */
  withReplace: boolean;
  onClose: () => void;
  /** Bumps when the document changes so the count stays live (AC2). */
  revision: number;
}

type Toggle = "case" | "word" | "regex";

export function FindPanel({ registry, path, withReplace, onClose, revision }: FindPanelProps) {
  const [search, setSearch] = useState("");
  const [replace, setReplace] = useState("");
  const [toggles, setToggles] = useState<Toggle[]>([]);
  const [count, setCount] = useState({ current: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const restoreTo = useRef<{ from: number; to: number } | null>(null);

  const view = registry.viewOf(path);
  const regexOn = toggles.includes("regex");

  // AC1: opening seeds the query from a single-line selection and focuses.
  useEffect(() => {
    if (!view) return;
    restoreTo.current = {
      from: view.state.selection.main.from,
      to: view.state.selection.main.to,
    };
    const selected = view.state.sliceDoc(
      view.state.selection.main.from,
      view.state.selection.main.to,
    );
    if (selected && !selected.includes("\n")) setSearch(selected);
    searchInput.current?.focus();
    searchInput.current?.select();
  }, [view]);

  // Apply the query and refresh the count whenever inputs or the doc change.
  useEffect(() => {
    if (!view) return;
    // `revision` bumps on every document change: the count follows edits (AC2).
    void revision;
    const applied = applyQuery(view, {
      search,
      replace,
      caseSensitive: toggles.includes("case"),
      wholeWord: toggles.includes("word"),
      regexp: toggles.includes("regex"),
    });
    setError(applied);
    setCount(applied ? { current: 0, total: 0 } : countMatches(view.state));
  }, [view, search, replace, toggles, revision]);

  const run = (command: Command): void => {
    if (!view || error) return;
    command(view);
    setCount(countMatches(view.state));
  };

  const close = (): void => {
    // AC5: focus and the pre-search selection both come back.
    const target = restoreTo.current;
    if (view && target) {
      view.dispatch({ selection: { anchor: target.from, head: target.to } });
      view.focus();
    }
    onClose();
  };

  return (
    <search
      className="find-panel"
      data-testid="find-panel"
      aria-label="Find in note"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          close();
        }
      }}
    >
      <div className="find-panel__row">
        <Input
          ref={searchInput}
          className="find-panel__input"
          aria-label="Find"
          placeholder="Find"
          value={search}
          invalid={error !== null}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              run(event.shiftKey ? findPreviousMatch : findNextMatch);
            }
          }}
        />
        <span className="find-panel__count" data-testid="find-count" aria-live="polite">
          {search === ""
            ? ""
            : count.total === 0
              ? "No results"
              : `${count.current}/${count.total}`}
        </span>
        <IconButton label="Previous match" onClick={() => run(findPreviousMatch)}>
          <ChevronUp size={14} strokeWidth={1.5} />
        </IconButton>
        <IconButton label="Next match" onClick={() => run(findNextMatch)}>
          <ChevronDown size={14} strokeWidth={1.5} />
        </IconButton>
        <SegmentedControl
          aria-label="Match options"
          value={toggles}
          onValueChange={(next: string[]) => setToggles(next as Toggle[])}
        >
          <Segment value="case">Aa</Segment>
          <Segment value="word">Word</Segment>
          <Segment value="regex">.*</Segment>
        </SegmentedControl>
        <IconButton label="Close find" onClick={close}>
          <X size={14} strokeWidth={1.5} />
        </IconButton>
      </div>
      {withReplace ? (
        <div className="find-panel__row">
          <Input
            className="find-panel__input"
            aria-label="Replace with"
            placeholder="Replace with"
            value={replace}
            onChange={(event) => setReplace(event.target.value)}
          />
          <button type="button" className="loam-button" onClick={() => run(replaceCurrent)}>
            Replace
          </button>
          <button type="button" className="loam-button" onClick={() => run(replaceEvery)}>
            Replace all
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="find-panel__error" role="alert" data-testid="find-error">
          {regexError(search, regexOn) ?? error}
        </p>
      ) : null}
    </search>
  );
}
