---
title: Create and reuse Widgets
description: Configure reusable visual content in Tilecast Studio and connect it to a Data Source when needed.
---

A **Widget** is a reusable visual item, such as a clock, a notice, or a view of live data. Add a Widget to a Playlist or place it on a Layout. A Widget is separate from its **Data Source**: the Data Source provides values, and the Widget decides how to show them.

## Create a Widget

An Owner, Administrator, or Editor can create and edit Widgets.

1. Open **Content** > **Widgets**, then select **Create Widget**.
2. Search or choose a category in the catalog. The available Apps and building blocks depend on the definitions installed on your Tilecast Server. A disabled catalog item shows why it isn't available.
3. Configure the selected Widget. For a data-driven Widget, select a compatible Data Source, map the fields it should show, and choose its display options. Some Widgets use settings you enter directly instead.
4. Check the live preview, enter a name, and select **Save Widget**.

The editor's controls vary by Widget. If no compatible Data Source appears in the picker, choose a provider that supplies the kind of values this Widget accepts, or create a new one from the picker. See [Data Sources](../data-sources/).

## Reuse a Widget

Add a saved Widget to a Playlist or Layout wherever you need the same visual content. You can use a Widget in more than one presentation; its details show where it is used. Editing a shared Widget changes the Widget itself, so check its other uses before changing its data or appearance.

In a Layout, the **Widgets** section opens the Apps picker. Add the Widget to the canvas, then use the inspector to set its position, fit, and unavailable behavior. A Widget can also be selected as a Playlist item.

## When a Widget has no current data

Check the Data Source's status and refresh diagnostics in **Content** > **Data Sources**. A Widget may have an empty-state or fallback setting, depending on its definition. The Layout inspector also lets you choose whether an unavailable App placement is shown or hidden. These options vary by Widget; preview the result before publishing.

## Next steps

- Create a reusable [Data Source](../data-sources/).
- Add a Widget to a [Playlist](../playlists/).
- Arrange Widgets with other content in a [Layout](../layouts/).
