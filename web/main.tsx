/** Point d'entrée de l'UI React (monté par Vite). */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/globals.css";
import App from "./App";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Élément #root introuvable");

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
