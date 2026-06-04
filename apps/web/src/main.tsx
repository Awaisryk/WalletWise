import React from "react";
import ReactDOM from "react-dom/client";

import { initSuperTokens } from "@/auth/init";
import App from "@/App";
import "@/index.css";

// SuperTokens must be initialised before React renders so Session/EmailPassword
// recipe state is available to the app on first paint.
initSuperTokens();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
