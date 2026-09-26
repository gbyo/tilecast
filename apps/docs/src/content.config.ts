import { defineCollection } from "astro:content";
import { docsSchema } from "@astrojs/starlight/schema";
import { docsCollectionLoader } from "../plugin-docs.mjs";

export const collections = {
  docs: defineCollection({
    loader: docsCollectionLoader(),
    schema: docsSchema(),
  }),
};
