// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import "../../i18n";
import type { PluginWebhookReview } from "../../api/types";
import type { PluginDetailViewModel } from "./detailView";
import { WebhookReviewSection } from "./WebhookReviewSection";

afterEach(cleanup);

const view = (webhooks?: PluginWebhookReview[]) =>
  ({ plugin: { webhooks } }) as unknown as PluginDetailViewModel;

describe("webhook review", () => {
  it("shows each endpoint, its authentication, and what it needs", () => {
    render(
      <WebhookReviewSection
        view={view([
          {
            id: "changes",
            title: "Plan changes",
            authentication: "signature",
            scheme: "hmac-sha256",
            ackStatus: 200,
            path: "/api/v1/hooks/planning_center/changes",
            requiresPublicHttps: true,
            signingSecretKey: "webhookSecret",
          },
          {
            id: "doors",
            title: "Doors",
            authentication: "token",
            ackStatus: 202,
            path: "/api/v1/hooks/planning_center/doors",
            requiresPublicHttps: false,
          },
          {
            id: "graph",
            title: "Calendar changes",
            authentication: "fetch-back",
            ackStatus: 202,
            handshake: "echo-query",
            path: "/api/v1/hooks/planning_center/graph",
            requiresPublicHttps: true,
          },
        ])}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Webhooks" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("/api/v1/hooks/planning_center/changes"),
    ).toBeInTheDocument();
    expect(screen.getByText("Signed")).toBeInTheDocument();
    expect(screen.getByText("Token")).toBeInTheDocument();
    expect(screen.getByText("Fetch back")).toBeInTheDocument();
    expect(
      screen.getByText(
        "HMAC-SHA256 signature · needs a public HTTPS address · HTTP 200 after the request is stored",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "works from your network · HTTP 202 after the request is stored",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Tilecast answers the provider's check/),
    ).toBeInTheDocument();
    expect(screen.getByText(/The plugin never reads it/)).toBeInTheDocument();
  });

  it("renders nothing without webhooks", () => {
    const { container } = render(<WebhookReviewSection view={view([])} />);
    expect(container).toBeEmptyDOMElement();
  });
});
