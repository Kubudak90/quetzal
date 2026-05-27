import ReactDOM from "react-dom/client";
import App from "./App.js";

declare global {
  interface Window {
    lucide?: { createIcons: () => void };
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
