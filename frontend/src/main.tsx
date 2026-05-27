import React from "react";
import ReactDOM from "react-dom/client";
import { Eyebrow, Hairline, StepDivider, PillButton, QuetzalLogo, Badge, Dot } from "./components/atoms.js";
import { DecoyVisualizer } from "./components/screens-shared.js";

declare global {
  interface Window {
    lucide?: { createIcons: () => void };
  }
}

function App() {
  const [decoys, setDecoys] = React.useState(2);
  React.useEffect(() => { window.lucide?.createIcons(); });
  return (
    <div style={{ padding: 40, minHeight: "100vh", background: "var(--bg)", color: "var(--fg)" }}>
      <QuetzalLogo size={32} />
      <Eyebrow>Atoms smoke</Eyebrow>
      <h1 style={{ fontFamily: "var(--font-display)", fontSize: 48, fontWeight: 300, letterSpacing: "-0.03em", marginTop: 8 }}>
        Quetzal
      </h1>
      <Hairline />
      <div style={{ display: "flex", gap: 8, marginTop: 24 }}>
        <Badge tone="ok">Atoms OK</Badge>
        <Badge tone="decoy"><Dot kind="decoy" size={6} />Decoys live</Badge>
      </div>
      <StepDivider />
      <div style={{ marginTop: 32, maxWidth: 480 }}>
        <Eyebrow>Decoy visualizer (slots-only, locked)</Eyebrow>
        <div style={{ marginTop: 12 }}>
          <DecoyVisualizer count={decoys} max={4} onChange={setDecoys} />
        </div>
      </div>
      <div style={{ marginTop: 32 }}>
        <PillButton variant="primary" onClick={() => alert("smoke")}>Test button</PillButton>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
