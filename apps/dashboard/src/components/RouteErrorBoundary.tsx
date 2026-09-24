import { Component, type ReactNode } from "react";
import { Trans } from "react-i18next";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";

type State = { error?: Error };

/**
 * Catches render errors from the routed page so a crash shows an inline
 * notice instead of unmounting the whole app. Remount with a location key
 * so navigating away (including the browser back button) recovers.
 */
export class RouteErrorBoundary extends Component<
  { children: ReactNode },
  State
> {
  state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    // A class component cannot call useTranslation. Trans reads the same
    // i18next context, so the message still follows language changes. The
    // raw error message is runtime output and stays untranslated.
    if (this.state.error) {
      return (
        <Alert variant="destructive">
          <AlertTitle>
            <Trans i18nKey="error.title" ns="navigation" />
          </AlertTitle>
          <AlertDescription>
            {this.state.error.message || (
              <Trans i18nKey="error.fallback" ns="navigation" />
            )}
          </AlertDescription>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="mt-2"
            onClick={() => this.setState({ error: undefined })}
          >
            <Trans i18nKey="error.retry" ns="navigation" />
          </Button>
        </Alert>
      );
    }
    return this.props.children;
  }
}
