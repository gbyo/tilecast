---
title: Create an integration token
description: Give a script or service limited access to Tilecast without sharing a Studio password.
---

Integration tokens are for scripts and services that need to update a Manual Table or read fleet health. Only the **Owner** can create and revoke them from **Settings** > **Integration tokens**.

## Create a token

1. Select **Create a token** and enter a **Name** that identifies the system using it.
2. Choose one or both **Capabilities**:
   - **Write Manual Table rows** can replace rows in Manual Table Data Sources.
   - **Read fleet health** can read the bounded JSON summary or Prometheus metrics.
3. For a write token, choose **Limit to Data Sources**. Selecting none permits writes to any Manual Table; selecting sources restricts the token to those sources.
4. Set **Expires on** if the token is temporary. The selected day is its last day of use. Leave it empty only when the integration needs a token without an expiry.
5. Select **Create token**, then copy the secret into the system's secret store.

Tilecast shows the complete token once. It cannot be read back later. A token uses this header format:

```http
Authorization: Bearer tci_<public-id>.<secret>
```

See [replace Manual Table rows](../manual-table/) and [read fleet health](../fleet-health/) for requests using each capability.

## Revoke or replace a token

In **Settings** > **Integration tokens**, select **Revoke** next to the token. Revocation takes effect immediately and cannot be undone; create a new token and update the integration when you need to replace one. Removing the account that created a token also disables that token.

Tilecast records token actions under the creating account. Give each integration its own token so you can identify and revoke one system without affecting another.
