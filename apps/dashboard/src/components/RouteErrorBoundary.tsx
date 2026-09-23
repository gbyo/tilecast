import { Component, type ReactNode } from "react";
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
    if (this.state.error) {
      return (
        <Alert variant="destructive">
          <AlertTitle>This page could not be displayed.</AlertTitle>
          <AlertDescription>
            {this.state.error.message ||
              "An unexpected error occurred while rendering this page."}
          </AlertDescription>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="mt-2"
            onClick={() => this.setState({ error: undefined })}
          >
            Try again
          </Button>
        </Alert>
      );
    }
    return this.props.children;
  }
}
