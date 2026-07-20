/** Stories for tabs & compact controls (LOA-45). Rendered per theme by the LOA-53 host. */

import { Badge, Chip } from "./badge";
import { Breadcrumb, BreadcrumbItem } from "./breadcrumb";
import { Kbd } from "./kbd";
import { Segment, SegmentedControl } from "./segmented";
import { Slider } from "./slider";
import { Tabs } from "./tabs";

export default { title: "Primitives / Compact" };

export function AppTabs() {
  return (
    <Tabs.Root defaultValue="ideas">
      <Tabs.List variant="app" aria-label="Open notes">
        <Tabs.Tab value="ideas">Ideas.md</Tabs.Tab>
        <Tabs.Tab value="daily">Daily note.md</Tabs.Tab>
        <Tabs.Tab value="long">A very long note title that truncates.md</Tabs.Tab>
      </Tabs.List>
    </Tabs.Root>
  );
}

export function PanelTabs() {
  return (
    <Tabs.Root defaultValue="backlinks">
      <Tabs.List variant="panel" aria-label="Note panels">
        <Tabs.Tab value="backlinks">Backlinks</Tabs.Tab>
        <Tabs.Tab value="outline">Outline</Tabs.Tab>
        <Tabs.Tab value="tags">Tags</Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="backlinks" style={{ paddingTop: "var(--loam-space-12)" }}>
        No linked mentions yet.
      </Tabs.Panel>
      <Tabs.Panel value="outline">Outline</Tabs.Panel>
      <Tabs.Panel value="tags">Tags</Tabs.Panel>
    </Tabs.Root>
  );
}

export function BreadcrumbStory() {
  return (
    <Breadcrumb>
      <BreadcrumbItem href="#vault">Vault</BreadcrumbItem>
      <BreadcrumbItem href="#projects">A very long folder name that truncates</BreadcrumbItem>
      <BreadcrumbItem current>Ideas.md</BreadcrumbItem>
    </Breadcrumb>
  );
}

export function BadgesAndChips() {
  return (
    <div
      style={{
        display: "flex",
        gap: "var(--loam-space-8)",
        alignItems: "center",
        flexWrap: "wrap",
      }}
    >
      <Badge>12</Badge>
      <Badge variant="accent">draft</Badge>
      <Badge variant="success">synced</Badge>
      <Badge variant="warning">conflict</Badge>
      <Badge variant="danger">3 errors</Badge>
      <Chip>reading</Chip>
      <Chip onRemove={() => {}}>project-loam</Chip>
    </div>
  );
}

export function SegmentedStory() {
  return (
    <SegmentedControl defaultValue={["edit"]} aria-label="Editor mode">
      <Segment value="edit">Edit</Segment>
      <Segment value="read">Read</Segment>
      <Segment value="split">Split</Segment>
    </SegmentedControl>
  );
}

export function SliderStory() {
  return (
    <div style={{ maxWidth: 280 }}>
      <Slider label="Editor font size" defaultValue={16} min={12} max={24} step={1} showValue />
    </div>
  );
}

export function KbdStory() {
  return (
    <div style={{ display: "flex", gap: "var(--loam-space-8)", alignItems: "center" }}>
      <Kbd keys="Mod+K" platform="mac" />
      <Kbd keys="Mod+Shift+P" platform="mac" />
      <Kbd keys="Mod+K" platform="other" />
      <Kbd keys="Escape" platform="mac" />
      <Kbd keys="Enter" platform="mac" />
    </div>
  );
}
