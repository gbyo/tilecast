import { screenTabs } from "../navigation/WorkspaceTabs";
import { WorkspaceNav } from "./studio/WorkspaceNav";

export function ScreenManagementTabs({
  className = "",
}: {
  className?: string;
}) {
  return (
    <WorkspaceNav label="Screens" tabs={screenTabs} className={className} />
  );
}
