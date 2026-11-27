import { useRouteError } from "react-router";

/**
 * An errorElement for test routers: a failure reaches the test as the thrown
 * error instead of React Router's default error screen.
 */
export function RethrowRouteError(): never {
  throw useRouteError();
}
