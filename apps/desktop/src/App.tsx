import { createTransport } from "@loam-app/ipc-client";
import { useEffect, useState } from "react";
import { Titlebar } from "./Titlebar";
import "./tokens.css";

const transport = createTransport();

// Minimal first paint (LOA-21): no feature bundles, no heavy modules. The real
// app shell (sidebars, tabs, editor) lands in E08+.
export function App() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    transport.ping().then(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <Titlebar vaultName="Loam" />
      <main
        data-testid="app-main"
        data-ready={ready ? "true" : "false"}
        data-transport={transport.kind}
      >
        <h1>Loam</h1>
        {/* First-run entry (§4.4): no wizard, one action. */}
        <button
          type="button"
          className="open-vault"
          data-testid="open-vault"
          onClick={() => {
            void transport.openVaultPicker();
          }}
        >
          Open folder
        </button>
      </main>
    </>
  );
}
