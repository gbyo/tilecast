import type { User } from "@/api/types";
import { studioRoutes } from "@/App";
import { SidebarProvider } from "@/components/ui/sidebar";
import { StudioNavigationProvider } from "@/navigation/studioNavigation";
import { StudioRoutesProvider } from "@/navigation/studioRoutes";
import { AppSidebar } from "./AppSidebar";

/**
 * The browser sidebar over Studio's real route tree, for navigation tests.
 * Render it inside a router and a QueryClientProvider.
 */
export function SidebarNavigation() {
  const user: User = {
    id: "navigation-test-user",
    name: "Tilecast User",
    username: "tilecast",
    role: "owner",
    active: true,
    createdAt: "",
  };
  return (
    <StudioRoutesProvider routes={studioRoutes}>
      <StudioNavigationProvider>
        <SidebarProvider>
          <AppSidebar user={user} onSignOut={() => undefined} />
        </SidebarProvider>
      </StudioNavigationProvider>
    </StudioRoutesProvider>
  );
}
