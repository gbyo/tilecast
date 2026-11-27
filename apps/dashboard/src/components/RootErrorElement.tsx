import { useRouteError } from "react-router";
import { Trans } from "react-i18next";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";

/**
 * The router's last resort: a failure outside every routed page (the shell,
 * the router itself) shows this notice with a reload instead of React
 * Router's generic default screen. Failures inside a routed page are caught
 * by RouteErrorBoundary first.
 */
export function RootErrorElement() {
  const error = useRouteError();
  // Keep the cause in DevTools: the notice itself stays generic.
  console.error("Studio failed to render", error);
  return (
    <div className="mx-auto grid min-h-svh max-w-lg content-center p-4">
      <Alert variant="destructive">
        <AlertTitle>
          <Trans i18nKey="error.title" ns="navigation" />
        </AlertTitle>
        <AlertDescription>
          <Trans i18nKey="error.fallback" ns="navigation" />
        </AlertDescription>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="mt-2"
          onClick={() => window.location.reload()}
        >
          <Trans i18nKey="error.retry" ns="navigation" />
        </Button>
      </Alert>
    </div>
  );
}
