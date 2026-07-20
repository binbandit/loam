/** Stories for choice controls (LOA-33). Rendered per theme by the LOA-53 host. */

import { Checkbox, Radio, RadioGroup, Switch } from "./choice";

export default { title: "Primitives / Choice" };

const column = { display: "flex", flexDirection: "column", gap: "var(--loam-space-12)" } as const;

export function Checkboxes() {
  return (
    <div style={column}>
      <Checkbox>Show hidden files</Checkbox>
      <Checkbox defaultChecked>Readable line length</Checkbox>
      <Checkbox disabled>Sync attachments</Checkbox>
      <Checkbox defaultChecked disabled>
        Index vault
      </Checkbox>
    </div>
  );
}

export function Switches() {
  return (
    <div style={column}>
      <Switch>Spell check</Switch>
      <Switch defaultChecked>Auto-pair brackets</Switch>
      <Switch disabled>Vim mode</Switch>
    </div>
  );
}

export function Radios() {
  return (
    <RadioGroup defaultValue="dark" aria-label="Theme">
      <Radio value="dark">Loam Dark</Radio>
      <Radio value="light">Loam Light</Radio>
      <Radio value="system">Match system</Radio>
    </RadioGroup>
  );
}
