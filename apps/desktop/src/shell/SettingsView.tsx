/**
 * Settings surface (LOA-86, §3.12): full-height modal with section
 * navigation and the P0 controls. Every control carries its stable
 * `data-setting-id` and a scope badge ("Vault" = shared, "This device" =
 * local) that is also announced to screen readers.
 */

import { Badge, Modal, Segment, SegmentedControl, Slider, Switch } from "@loam-app/ui";
import { useState } from "react";
import {
  SETTING_SECTIONS,
  SETTINGS,
  type SettingDefinition,
  type SettingValue,
} from "../settings/registry";
import type { SettingsStore } from "../stores/settings";
import "./shell.css";

function ScopeBadge({ scope }: { scope: SettingDefinition["scope"] }) {
  return scope === "shared" ? (
    <Badge variant="accent" aria-label="Stored in the vault, shared across devices">
      Vault
    </Badge>
  ) : (
    <Badge aria-label="Stored on this device only">This device</Badge>
  );
}

function SettingControl({
  setting,
  value,
  onChange,
}: {
  setting: SettingDefinition;
  value: SettingValue;
  onChange: (value: SettingValue) => void;
}) {
  const control = setting.control;
  if (control.kind === "switch") {
    return (
      <Switch
        checked={value === true}
        onCheckedChange={(checked) => onChange(checked === true)}
        aria-label={setting.label}
      />
    );
  }
  if (control.kind === "segmented") {
    return (
      <SegmentedControl
        aria-label={setting.label}
        value={[String(value)]}
        onValueChange={(next: string[]) => {
          if (next[0]) onChange(next[0]);
        }}
      >
        {control.options.map((option) => (
          <Segment key={option.value} value={option.value}>
            {option.label}
          </Segment>
        ))}
      </SegmentedControl>
    );
  }
  return (
    <div className="settings__slider">
      <Slider
        label={setting.label}
        value={Number(value)}
        min={control.min}
        max={control.max}
        step={control.step}
        onValueChange={(next: number | readonly number[]) =>
          onChange(Array.isArray(next) ? (next[0] as number) : (next as number))
        }
        showValue
      />
    </div>
  );
}

export interface SettingsViewProps {
  settingsStore: SettingsStore;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsView({ settingsStore, open, onOpenChange }: SettingsViewProps) {
  const [section, setSection] = useState("general");
  const values = settingsStore((state) => state.values);
  const error = settingsStore((state) => state.error);
  const sectionSettings = SETTINGS.filter((setting) => setting.section === section);

  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content className="settings" initialFocus={undefined}>
        <Modal.Title className="sr-only">Settings</Modal.Title>
        <div className="settings__layout">
          <nav className="settings__nav" aria-label="Settings sections">
            {SETTING_SECTIONS.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                className="settings__nav-item"
                data-active={candidate.id === section || undefined}
                aria-current={candidate.id === section ? "true" : undefined}
                onClick={() => setSection(candidate.id)}
              >
                {candidate.title}
              </button>
            ))}
          </nav>
          <div className="settings__content" data-testid="settings-content">
            <h2 className="settings__heading">
              {SETTING_SECTIONS.find((candidate) => candidate.id === section)?.title}
            </h2>
            {sectionSettings.length === 0 ? (
              <p className="shell__placeholder">
                {section === "about"
                  ? "Loam — a local-first Markdown knowledge base."
                  : "Settings for this section arrive with a later milestone."}
              </p>
            ) : (
              sectionSettings.map((setting) => (
                <div key={setting.id} className="settings__row" data-setting-id={setting.id}>
                  <div className="settings__meta">
                    <span className="settings__label">
                      {setting.label} <ScopeBadge scope={setting.scope} />
                    </span>
                    <span className="settings__description">{setting.description}</span>
                  </div>
                  <SettingControl
                    setting={setting}
                    value={values[setting.id] as SettingValue}
                    onChange={(value) => void settingsStore.getState().set(setting.id, value)}
                  />
                </div>
              ))
            )}
            {error ? (
              <p className="file-tree__error" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        </div>
      </Modal.Content>
    </Modal.Root>
  );
}
