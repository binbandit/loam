# The Loam IPC contract (§5.4)

The webview and the Rust shell communicate only through the typed surface
described here. This boundary is what keeps a future Electron port and the
mobile shells feasible: everything below it is `loam-core` (pure Rust),
everything above it consumes generated TypeScript.

The machine-readable inventory lives in
[`ipc-contract-manifest.json`](./ipc-contract-manifest.json) — every M0
command (name, args, result), event channel, error variant, and exported
type, deterministically ordered and snapshot-checked in CI (the
`contract_manifest` test fails with a line diff on any divergence).

## Trust boundary

- The webview holds **no** filesystem, shell, or process permissions
  (capability ACL, verified by the LOA-36 invoke-denial tests). Its only
  power is invoking the registered typed commands.
- Every command resolves its vault id against the shell's capability
  registry first; unknown ids fail with `unknown-vault` before any
  filesystem access. Paths are vault-relative; core's `resolve_in_vault`
  rejects escapes.
- Absolute OS paths never cross the boundary in either direction; errors
  carry vault-relative paths and stable kind strings only (no backtraces).
- Payloads are JSON. MessagePack/raw IPC remains a **measured** future
  optimization for `graph_snapshot`/`search`, not a default.

## The chain that prevents drift

```
Rust commands (#[specta::specta], specta_builder! macro)
  │  cargo test -p loam-desktop --test bindings_drift       (byte compare)
  ▼
packages/ipc-client/src/generated/bindings.ts               (committed)
  │  cargo test -p loam-desktop --test contract_manifest    (line-diff compare)
  ▼
docs/ipc-contract-manifest.json                             (committed)
```

`configure()` takes its invoke handler from the same `specta_builder!`
macro that exports the bindings, so the registered surface and the
generated client are one definition. On the TypeScript side,
`src/contract-checks.ts` (`@ts-expect-error` tripwires) and the mock's
`MockCommands = typeof commands` fail `pnpm typecheck` when the contract
moves.

## Transports

**Native** (inside the Tauri webview) — the generated client invokes
directly; events arrive per vault window:

```ts
import { commands, onFileChanged } from "@loam-app/ipc-client";

const opened = await commands.vaultOpen(path);
if (opened.status === "ok") {
  const note = await commands.noteRead(opened.data.id, "notes/idea.md");
  const unsubscribe = await onFileChanged(({ seq, vaultId, payload }) => {
    // seq is monotonic per vault; a gap or regression is a bug.
  });
}
```

**Browser mock** (tests, plain-browser dev) — the complete in-memory
implementation of the same surface:

```ts
import { createMockIpc } from "@loam-app/ipc-client";

const mock = createMockIpc({
  vaults: { "/demo": { files: { "welcome.md": "# Hi\n" } } },
  latencyMs: 20, // optional: keep latency tests honest
});
const opened = await mock.commands.vaultOpen("/demo"); // same types, same shapes
mock.emitExternalChange(vaultId, "synced.md", "# From sync\n");
```

`createTransport()` in `@loam-app/ipc-client` picks native inside the shell
and the mock seam in any plain browser; UI code never touches Tauri globals.

## Changing the contract

Every change regenerates both snapshots
(`LOAM_UPDATE_FIXTURES=1 cargo test -p loam-desktop --test bindings_drift
--test contract_manifest`) and commits the diffs — CI rejects silent drift.

**Compatible (allowed within a milestone):**
- Adding a command, event channel, error variant, or optional field.
- Widening a result with new fields.

**Breaking (needs a documented migration in the PR + a major contract
note):**
- Renaming or removing a command, event, field, or error tag.
- Changing a field's type or an argument's meaning/order.
- Tightening nullability.

The stable error enum's kebab-case tags (`"error": "conflict"`, …) are the
compatibility keel: frontends may match on them forever.
