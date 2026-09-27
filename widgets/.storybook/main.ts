import type { StorybookConfig } from "@storybook/web-components-vite";

// Widget development and visual-regression stories. Local only: no hosted
// Storybook service is required, and telemetry is off.
const config: StorybookConfig = {
  stories: ["../*/runtime/*.stories.ts"],
  framework: { name: "@storybook/web-components-vite", options: {} },
  core: { disableTelemetry: true, disableWhatsNewNotifications: true },
};

export default config;
