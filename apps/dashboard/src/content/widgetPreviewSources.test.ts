import { describe, expect, it } from "vitest";
import type { ContentDefinitionField } from "../api/types";
import {
  widgetPreviewAssetFields,
  widgetPreviewConfiguration,
  widgetPreviewDataSourceIds,
  widgetPreviewMedia,
} from "./widgetPreviewSources";

const fields: ContentDefinitionField[] = [
  {
    key: "rows",
    label: "Rows",
    control: "repeating_group",
    itemFields: [
      {
        key: "source",
        label: "Source",
        control: "data_source",
      },
    ],
  },
];

describe("Widget preview source resolution", () => {
  it("injects managed App source keys without changing author configuration", () => {
    const author = { heading: "Sports" };
    const preview = widgetPreviewConfiguration(author, "managed-source");

    expect(preview).toEqual({
      heading: "Sports",
      sourceId: "managed-source",
      managedDataSourceId: "managed-source",
    });
    expect(author).toEqual({ heading: "Sports" });
  });

  it("includes the managed source before recursively declared sources and de-duplicates IDs", () => {
    const configuration = {
      rows: [{ source: "nested-source" }, { source: "managed-source" }],
    };

    expect(
      widgetPreviewDataSourceIds(fields, configuration, "managed-source"),
    ).toEqual(["managed-source", "nested-source"]);
  });

  it("plans image grants only for selected asset-compatible fields", () => {
    const cardFields: ContentDefinitionField[] = [
      { key: "dataSourceId", label: "Source", control: "data_source" },
      {
        key: "imageField",
        label: "Image",
        control: "data_source_field",
        dataSourceFieldTypes: ["text", "asset"],
      },
      {
        key: "titleField",
        label: "Title",
        control: "data_source_field",
        dataSourceFieldTypes: ["text"],
      },
    ];
    expect(
      widgetPreviewAssetFields(cardFields, {
        dataSourceId: "source-a",
        imageField: "cover",
        titleField: "title",
        maximumItems: 120,
      }),
    ).toEqual([
      { dataSourceId: "source-a", fieldKey: "cover", maximumItems: 100 },
    ]);
  });

  it("projects generic and repeating-group media fields into the preview grant", () => {
    const mediaFields: ContentDefinitionField[] = [
      { key: "logo", label: "Logo", control: "media_asset" },
      {
        key: "slides",
        label: "Slides",
        control: "repeating_group",
        itemFields: [
          { key: "posterAssetId", label: "Poster", control: "media_asset" },
        ],
      },
    ];
    const authorConfiguration = {
      logo: "logo-asset",
      slides: [{ posterAssetId: "poster-asset" }, { posterAssetId: "" }],
    };

    const preview = widgetPreviewMedia(mediaFields, authorConfiguration);

    expect(preview).toEqual({
      configuration: {
        logo: "logo-asset",
        logoVariantId: "preview",
        slides: [
          { posterAssetId: "poster-asset", posterVariantId: "preview" },
          { posterAssetId: "" },
        ],
      },
      media: [
        { assetId: "logo-asset", variantId: "preview" },
        { assetId: "poster-asset", variantId: "preview" },
      ],
    });
    expect(authorConfiguration).toEqual({
      logo: "logo-asset",
      slides: [{ posterAssetId: "poster-asset" }, { posterAssetId: "" }],
    });
  });
});
