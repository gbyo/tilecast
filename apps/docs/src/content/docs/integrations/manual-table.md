---
title: Replace Manual Table rows
description: Push a complete set of rows into a Manual Table Data Source with an integration token.
---

Use this workflow when another system owns a small table, such as a menu or bell schedule, and Tilecast displays it through a Widget. Each request replaces the whole table, so send the complete current row set.

## Before you start

- Create a **Manual Table** Data Source in Studio and configure its columns.
- Create an integration token with **Write Manual Table rows**. Restrict it to this Data Source when possible; see [Create an integration token](../tokens/).
- Copy the Data Source ID from its Studio address. It is the ID in `/data-sources/<id>`.

## Send the rows

Send a `PUT` to `/api/v1/integration/data-sources/{id}/rows`. Each row has a `values` object keyed by the column keys configured in Studio. Values are strings.

```sh
curl --fail-with-body -X PUT "$TILECAST_URL/api/v1/integration/data-sources/$TILECAST_DATA_SOURCE_ID/rows" \
  -H "Authorization: Bearer $TILECAST_INTEGRATION_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"rows":[{"values":{"item":"Garden salad","price":"2.75"}},{"values":{"item":"Soup","price":"3.00"}}]}'
```

Replace the example keys with the keys in your Data Source. A request can contain at most 200 rows, matching the Manual Table limit in Studio. Tilecast rejects a key that does not match an existing column; the token cannot create or delete a Data Source or change its columns.

Send an empty array to clear the table:

```json
{ "rows": [] }
```

The `rows` field is required. Omitting it is an error; sending an empty array intentionally removes every row. A successful replacement refreshes the Data Source used by its Widgets and appears in the Studio audit log under the token's creator.

## If the request fails

- `401 invalid_token`: check the token value, expiry, and revocation status.
- `403 insufficient_scope`: the token needs **Write Manual Table rows** and must be allowed to write this Data Source.
- `404 not_found`: confirm the ID belongs to an existing Data Source.
- `422 rows_invalid`: check that the source is a Manual Table and every supplied key matches one of its configured columns.

See [API conventions](../../reference/api/) for the response envelope and error format.
