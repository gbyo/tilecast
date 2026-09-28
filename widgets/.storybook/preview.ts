import type { Preview } from "@storybook/web-components-vite";
// The bundled Tilecast face, as the Player Runtime ships it.
import "@fontsource-variable/geist/index.css";
import "./preview.css";

const preview: Preview = {
  parameters: {
    layout: "fullscreen",
    backgrounds: { disable: true },
  },
};

export default preview;
