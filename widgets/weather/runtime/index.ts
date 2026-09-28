import { defineWidget } from "@tilecast/widget-sdk";
import {
  parseWeatherConfig,
  resolveWeatherData,
  TilecastWeatherWidget,
  type WeatherConfig,
  type WeatherData,
} from "./weather.ts";

export default defineWidget<WeatherConfig, WeatherData>({
  type: "tilecast.weather",
  version: 1,
  tagName: "tc-widget-weather",
  parseConfig: parseWeatherConfig,
  // Weather reads the normalized Weather source the author connected. No
  // source or no usable record is an expected empty state, never an
  // error; a source without a records dataset is a configuration error.
  resolveData: (config, resources) => resolveWeatherData(config, resources),
  element: TilecastWeatherWidget,
});
