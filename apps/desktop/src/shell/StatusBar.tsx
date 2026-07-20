/**
 * Status bar (LOA-84, §3.5): minimal line — index status (glyph + text),
 * word/char count (click toggles), Source cursor position when applicable,
 * and the reserved right-aligned plugin region.
 */

import { Circle, CircleCheck, LoaderCircle } from "lucide-react";
import { indexStatusText, type StatusStore } from "../stores/status";
import "./shell.css";

export interface StatusBarProps {
  statusStore: StatusStore;
  vaultName: string;
}

export function StatusBar({ statusStore, vaultName }: StatusBarProps) {
  const indexStatus = statusStore((state) => state.indexStatus);
  const indexProgress = statusStore((state) => state.indexProgress);
  const counts = statusStore((state) => state.counts);
  const cursor = statusStore((state) => state.cursor);
  const countDisplay = statusStore((state) => state.countDisplay);
  const pluginItems = statusStore((state) => state.pluginItems);
  const hidden = statusStore((state) => state.hidden);

  if (hidden) return null;
  const statusText = indexStatusText(indexStatus, indexProgress);
  const Glyph =
    indexStatus === "ready" ? CircleCheck : indexStatus === "indexing" ? LoaderCircle : Circle;

  return (
    <footer className="shell__status" data-testid="status-bar">
      <span data-testid="status-vault">{vaultName}</span>
      {/* AC4: the glyph always carries visible text. */}
      <span className="status__index" data-testid="status-index" data-status={indexStatus}>
        <Glyph size={11} strokeWidth={1.5} aria-hidden="true" />
        {statusText}
      </span>
      {counts ? (
        <button
          type="button"
          className="status__item"
          data-testid="status-counts"
          aria-label={`${counts.words} words, ${counts.characters} characters. Toggle count display`}
          onClick={() => statusStore.getState().toggleCountDisplay()}
        >
          {countDisplay === "words" ? `${counts.words} words` : `${counts.characters} characters`}
        </button>
      ) : null}
      {/* AC3: cursor position only when an editor reports one (E09). */}
      {cursor ? (
        <span data-testid="status-cursor">
          Ln {cursor.line}, Col {cursor.ch}
        </span>
      ) : null}
      <span className="status__spacer" />
      {/* Reserved right-aligned plugin region (§3.11). */}
      <span className="status__plugins" data-testid="status-plugins">
        {pluginItems.map((item) => (
          <span key={item.id}>{item.render()}</span>
        ))}
      </span>
    </footer>
  );
}
