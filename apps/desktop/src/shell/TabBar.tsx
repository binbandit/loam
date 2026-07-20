/**
 * Per-pane tab bar (LOA-75/LOA-76, §3.5). Pointer paths dispatch the same
 * store actions as the keyboard commands (AC1); drag reorders within the
 * strip and drags to pane edges to split; the overflow menu lists every tab
 * in the pane (AC5); closing a dirty tab opens a non-destructive decision
 * dialog (AC2) rendered once at the shell level.
 */

import { IconButton, Menu } from "@loam-app/ui";
import { ChevronDown, X } from "lucide-react";
import { type DragEvent, useEffect, useRef, useState } from "react";
import { findPane, type PanesStore } from "../stores/panes";
import type { Tab } from "../stores/tabs";
import "./shell.css";

const TAB_MIME = "application/x-loam-tab";

export interface TabBarProps {
  panesStore: PanesStore;
  paneId: string;
}

export function TabBar({ panesStore, paneId }: TabBarProps) {
  const pane = panesStore((state) => findPane(state.root, paneId));
  const stripRef = useRef<HTMLDivElement>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean } | null>(null);
  const activeTabId = pane?.activeTabId ?? null;

  // AC5: activating a tab keeps it visible inside the scrolling strip.
  useEffect(() => {
    if (!activeTabId) return;
    stripRef.current
      ?.querySelector(`[data-tab-id="${CSS.escape(activeTabId)}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId]);

  if (!pane || pane.tabs.length === 0) return null;
  const store = panesStore.getState();
  const tabs = pane.tabs;

  const onDrop = (event: DragEvent, target: Tab): void => {
    const payload = event.dataTransfer.getData(TAB_MIME);
    setDropTarget(null);
    if (!payload) return;
    event.preventDefault();
    event.stopPropagation();
    const dragged = JSON.parse(payload) as { paneId: string; tabId: string };
    if (dragged.tabId === target.id) return;
    if (dragged.paneId !== paneId) return; // cross-pane moves use edge drops
    const index = tabs.findIndex((tab) => tab.id === target.id);
    const after = dropTarget?.id === target.id ? dropTarget.after : false;
    store.moveTab(paneId, dragged.tabId, after ? index + 1 : index);
  };

  return (
    <div className="tab-bar" data-testid="tab-bar">
      <div ref={stripRef} className="tab-bar__strip" role="tablist" aria-label="Open notes">
        {tabs.map((tab) => (
          // biome-ignore lint/a11y/noStaticElementInteractions: drag reorder is a pointer affordance; the same reorder is keyboard-reachable via the tab.moveLeft/moveRight commands (AC4).
          <div
            key={tab.id}
            data-tab-id={tab.id}
            data-drop={
              dropTarget?.id === tab.id ? (dropTarget.after ? "below" : "above") : undefined
            }
            className="tab-bar__tab"
            data-active={tab.id === activeTabId || undefined}
            data-missing={tab.missing || undefined}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData(TAB_MIME, JSON.stringify({ paneId, tabId: tab.id }));
              event.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes(TAB_MIME)) return;
              event.preventDefault();
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              setDropTarget({ id: tab.id, after: event.clientX > rect.left + rect.width / 2 });
            }}
            onDragLeave={() => setDropTarget(null)}
            onDrop={(event) => onDrop(event, tab)}
          >
            <button
              type="button"
              role="tab"
              aria-selected={tab.id === activeTabId}
              className="tab-bar__label"
              onClick={() => store.activateTab(paneId, tab.id)}
            >
              {tab.dirty ? (
                <span className="tab-bar__dirty" aria-hidden="true" title="Unsaved changes" />
              ) : null}
              <span className="tab-bar__title">
                {tab.title}
                {tab.dirty ? <span className="sr-only"> (unsaved changes)</span> : null}
              </span>
            </button>
            <IconButton
              label={`Close ${tab.title}`}
              className="tab-bar__close"
              onClick={() => store.close(paneId, tab.id)}
            >
              <X size={12} strokeWidth={1.5} />
            </IconButton>
            {dropTarget?.id === tab.id ? <span className="loam-drop-indicator" /> : null}
          </div>
        ))}
      </div>
      <Menu.Root>
        <Menu.Trigger
          render={
            <IconButton label="All tabs" className="tab-bar__overflow">
              <ChevronDown size={14} strokeWidth={1.5} />
            </IconButton>
          }
        />
        <Menu.Content align="end">
          {tabs.map((tab) => (
            <Menu.Item
              key={tab.id}
              shortcut={tab.id === activeTabId ? "✓" : undefined}
              onClick={() => store.activateTab(paneId, tab.id)}
            >
              {tab.title}
            </Menu.Item>
          ))}
        </Menu.Content>
      </Menu.Root>
    </div>
  );
}

/** §3.5 keyboard bindings → pane/tab commands. Full hotkey system is E12. */
export type ShellCommand =
  | "tab.new"
  | "tab.close"
  | "tab.reopen"
  | "tab.next"
  | "tab.previous"
  | "tab.moveLeft"
  | "tab.moveRight"
  | "pane.splitRight"
  | "pane.splitDown"
  | "pane.focusNext"
  | "nav.back"
  | "nav.forward"
  | `tab.activate${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;

export function tabCommandForKey(event: KeyboardEvent): ShellCommand | null {
  const meta = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();
  if (meta && event.key === "\\") return event.shiftKey ? "pane.splitDown" : "pane.splitRight";
  if (meta && !event.shiftKey && key === "t") return "tab.new";
  if (meta && event.shiftKey && key === "t") return "tab.reopen";
  if (meta && key === "w") return "tab.close";
  if (event.ctrlKey && !event.metaKey && key === "tab") {
    return event.shiftKey ? "tab.previous" : "tab.next";
  }
  if (meta && event.altKey && event.key === "ArrowLeft") return "tab.moveLeft";
  if (meta && event.altKey && event.key === "ArrowRight") return "tab.moveRight";
  if (meta && event.altKey && key === "p") return "pane.focusNext";
  if (meta && !event.shiftKey && event.key === "[") return "nav.back";
  if (meta && !event.shiftKey && event.key === "]") return "nav.forward";
  if (meta && /^[1-9]$/.test(event.key)) return `tab.activate${event.key}` as ShellCommand;
  return null;
}

/** Single dispatch point: keyboard and pointer paths converge here (AC1). */
export function runShellCommand(
  store: PanesStore,
  command: ShellCommand,
  validPaths?: ReadonlySet<string>,
): void {
  const state = store.getState();
  if (command === "tab.new") state.newTab();
  else if (command === "tab.close") state.close();
  else if (command === "tab.reopen") state.reopenLast(validPaths);
  else if (command === "tab.next") state.next();
  else if (command === "tab.previous") state.previous();
  else if (command === "tab.moveLeft") state.moveActiveTab(-1);
  else if (command === "tab.moveRight") state.moveActiveTab(1);
  else if (command === "pane.splitRight") state.splitActive("row");
  else if (command === "pane.splitDown") state.splitActive("column");
  else if (command === "pane.focusNext") state.focusNextPane();
  else if (command === "nav.back") state.navigateBack();
  else if (command === "nav.forward") state.navigateForward();
  else {
    const index = Number(command.replace("tab.activate", ""));
    if (index >= 1 && index <= 9) state.activateIndex(index);
  }
}
