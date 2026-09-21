import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createBrowserRouter } from "react-router";
import "@tilecast/design-tokens/tokens.css";
import "./theme";
import "./styles/shadcn.css";
import { App } from "./App";
import { AuthProvider } from "./auth/AuthProvider";
import { installCommandPaletteFocus } from "./commandPaletteFocus";
import "./styles.css";
import "./styles/layout-fonts.css";
import "./styles/signal.css";
import "./styles/topbar.css";
import "./styles/topbar-width-fixes.css";
// Page-specific refinements intentionally load after shared Signal styles.
import "./styles/reliability.css";
import "./styles/screens.css";
import "./styles/sync-groups.css";
import "./styles/account-menu.css";
import "./styles/issue-fixes.css";
import "./styles/issues-37-45.css";
import "./styles/issues-48-49.css";
import "./styles/data-sources.css";
import "./styles/forms.css";
import "./styles/player-updates.css";
import "./styles/context-menu.css";
import "./styles/popover.css";
import "./styles/screens-media-fixes.css";
import "./styles/playlist-editor.css";

installCommandPaletteFocus();

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false } },
});

// A data router is used (instead of the <BrowserRouter> component) so descendant routes can use
// navigation blocking (useBlocker) for unsaved-change protection. The whole app remains a single
// splat route rendering <App/>, which continues to resolve studioRoutes via useRoutes.
const router = createBrowserRouter([{ path: "*", element: <App /> }]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
