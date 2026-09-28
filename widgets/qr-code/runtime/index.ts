import { defineWidget } from "@tilecast/widget-sdk";
import {
  parseQrCodeConfig,
  resolveQrCodeData,
  TilecastQrCodeWidget,
  type QrCodeConfig,
} from "./qr-code.ts";

export default defineWidget<QrCodeConfig, null>({
  type: "tilecast.qr-code",
  version: 1,
  tagName: "tc-widget-qr-code",
  parseConfig: parseQrCodeConfig,
  // A QR Code is standalone: it reads no Data Source. An empty payload is
  // an expected empty state, never an error.
  resolveData: (config) => resolveQrCodeData(config),
  element: TilecastQrCodeWidget,
});
