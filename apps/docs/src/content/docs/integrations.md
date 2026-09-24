---
title: Integrations
description: Move data between Tilecast and other systems, or send Tilecast events to your own service.
---

Choose an integration by the direction data needs to move:

- To display data Tilecast fetches, create a [Data Source](../studio/). Widgets can show its records on a screen.
- To push table rows into Tilecast or read a fleet summary, use an [integration token](./tokens/).
- To receive Tilecast notifications, configure [email or a webhook](./notifications/).

Use [Manual Table rows](./manual-table/) to connect an external system that owns the source data. Use [fleet health](./fleet-health/) to connect an existing monitoring system.

The integration API is deliberately scoped. Tokens cannot administer Tilecast, create content, or control screens. See the [API overview](../reference/api/) for the shared request and authentication conventions.
