---
title: Connect a Data Source
description: Create reusable, cached data connections for Widgets and live text in Layouts.
---

A **Data Source** connects Tilecast to structured information that a Widget or Layout can display. The source holds the data; the Widget or text binding controls how it appears. Tilecast Server fetches remote sources and caches the parsed data, and Studio shows the source's status and refresh diagnostics.

## Create a Data Source

1. Open **Content** > **Data Sources**, then select **Create Data Source**.
2. Choose a provider from the catalog offered by your Tilecast Server. Depending on the installed definitions, providers can include RSS or Atom feeds, calendars, JSON or CSV, weather, transit, alerts, and an editor-managed table.
3. Follow the setup checklist for that provider. Enter its connection details, map the values to typed fields when prompted, and review the preview when one is available.
4. Select **Save Data Source**.

The provider determines what you configure. For example, a public calendar needs an ICS feed URL; a JSON or CSV source needs field mappings; a **Manual Table** lets you define typed columns and enter up to 200 rows in Studio. The available catalog can change with the server's installed definitions.

The **CAP Alerts** source can display records from a configured public CAP feed. It is separate from the U.S.-specific [US Weather Alerts](../operations/emergency-alerts/) automation and does not trigger its rules or Takeovers. CAP availability depends on the configured feed; not every country's warning service publishes CAP.

You can also create a Data Source from a compatible source picker while editing a Widget or Layout. The picker filters sources by the data kind that the selected Widget or binding can use.

## Use its data

In a Widget editor, choose a compatible Data Source and map its fields to the Widget's display fields. In a Layout, select a text layer, switch **Content mode** to **Dynamic field**, then choose a Data Source and field. For a structured, repeatable display such as a list or ticker, use a Widget rather than a single text binding.

One Data Source can feed several Widgets and Layout bindings. Studio's Data Source details show where it is used. If you need to remove a source, first remove every Widget and Layout binding that uses it; Tilecast prevents deleting a source that is still referenced.

## Check a source that looks out of date

Open the Data Source and check **Last success**, **Last attempt**, its status, and whether the displayed values are cached. A failed refresh can leave cached values available, so an old value may still appear while the upstream connection is unavailable. Check the source URL and the server's network access before changing the Widget.

Tilecast Server makes the remote request. The default `TILECAST_SOURCE_ALLOW_PRIVATE_NETWORKS=false` policy blocks private-network destinations. An administrator must change this setting if a source is intentionally hosted on the installation's private network. A source hosted elsewhere must be reachable from the server, not only from your browser or the Player.

## Next steps

- Connect a source to a [Widget](../widgets/).
- Bind a field to text in a [Layout](../layouts/).
- Read about [integrations](../integrations/) for supported connection patterns.
