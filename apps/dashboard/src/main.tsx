import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createBrowserRouter } from "react-router";
import "@tilecast/design-tokens/tokens.css";
import { App } from "./App";
import { AuthProvider } from "./auth/AuthProvider";
import { initI18n } from "./i18n";
import "./styles.css";
import "./styles/layout-fonts.css";
import "./styles/signal.css";
// Page-specific refinements intentionally load after shared Signal styles.
import "./styles/screens.css";
import "./styles/data-sources.css";
import "./styles/forms.css";
import "./styles/player-updates.css";
import "./styles/context-menu.css";
import "./styles/popover.css";
import "./styles/playlist-editor.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false } },
});

// A data router is used (instead of the <BrowserRouter> component) so descendant routes can use
// navigation blocking (useBlocker) for unsaved-change protection. The whole app remains a single
// splat route rendering <App/>, which continues to resolve studioRoutes via useRoutes.
const router = createBrowserRouter([{ path: "*", element: <App /> }]);

function render() {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <RouterProvider router={router} />
        </AuthProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}

// A translation chunk that fails to load leaves English in place rather than
// a blank page; i18next falls back to the bundled English strings.
void initI18n().then(render, render);
