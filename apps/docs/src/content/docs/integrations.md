---
title: Integrations
description: Bring data from other systems into Tilecast, and connect Tilecast to your monitoring and alerting.
---

Tilecast connects to other systems in three ways. Pick the one that matches the direction the data moves.

| You want to                                                       | Use                     |
| ----------------------------------------------------------------- | ----------------------- |
| Show data from a feed, calendar, or file on a screen              | A Data Source in Studio |
| Have another system push rows into Tilecast, or read fleet health | An integration token    |
| Tell another system when a screen has a problem                   | A notification webhook  |

## Pull data with a Data Source

A **Data Source** is a reusable connection to data, such as an RSS or Atom feed, a calendar, a JSON or CSV file, or a table you fill in by hand. Widgets display the data on screen. Several Widgets can share one Data Source, and Tilecast keeps the last good copy if the source stops responding.

Create Data Sources in Studio under **Content** > **Data Sources**.

## Push data with an integration token

An integration token lets a script or another system call Tilecast without anyone's Studio password. Only an Owner can create one, in **Settings** > **Integration tokens**. Tilecast shows the token only once, when you create it.

A token can have one or both of these capabilities:

- `data_source:write` replaces the rows of a Manual Table Data Source. Use it for data that already lives somewhere else, such as a lunch menu or bell times.
- `activity:read` reads fleet health counts as JSON or as Prometheus metrics.

Send the token in the `Authorization` header:

```sh
curl -X PUT https://signage.example.org/api/v1/integration/data-sources/DATA_SOURCE_ID/rows \
  -H "Authorization: Bearer $TILECAST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"rows": [{"values": {"item": "Garden salad", "price": "2.75"}}]}'
```

Each write replaces every row in the Data Source. The keys must match the columns the Data Source already has.

:::note
A token stops working if the account that created it is removed. Set an expiry date for anything temporary, such as a vendor's installation work.
:::

## Get notified with a webhook

An Owner or Administrator can add a webhook in **Settings** > **Notifications**. Tilecast sends a signed JSON `POST` when an incident opens and when it recovers. Your receiver checks the `X-Tilecast-Signature` header to confirm the request came from your installation.

To reach a chat service, point the webhook at a relay you control. Tilecast doesn't include integrations for specific chat services.

## Go further

- [Integration tokens](https://github.com/gbyo/tilecast/blob/main/docs/integrations.md), including the fleet health endpoints
- [Notifications](https://github.com/gbyo/tilecast/blob/main/docs/notifications.md), including webhook signature checks
- [Widgets, Data Sources, and Layouts](https://github.com/gbyo/tilecast/blob/main/docs/widgets-and-layouts.md)
