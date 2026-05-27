import React from "react";
import ReactDOM from "react-dom/client";

// Tell TypeScript the lucide global exists (loaded via CDN in index.html)
declare global {
  interface Window {
    lucide?: { createIcons: () => void };
  }
}

function App() {
  React.useEffect(() => {
    window.lucide?.createIcons();
  });
  return (
    <div style={{ padding: 32, fontFamily: "var(--font-display)", color: "var(--fg)", background: "var(--bg)", minHeight: "100vh" }}>
      <h1 style={{ fontSize: 48, fontWeight: 300, letterSpacing: "-0.03em" }}>Quetzal</h1>
      <p style={{ fontFamily: "var(--font-body)", color: "var(--fg-muted)", marginTop: 16 }}>
        Frontend bootstrap OK. Atoms + components + screens land in follow-up tasks.
      </p>
      <p style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-subtle)", marginTop: 24 }}>
        Theme tokens live; lucide loaded. Next: port atoms + components.
      </p>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
