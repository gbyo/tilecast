# oasdiff error exemptions

Read by `scripts/ci/openapi-compat.sh` through `oasdiff breaking
--err-ignore`. oasdiff matches each exemption line on its `METHOD /path`
plus the change description text. Every entry below is a spec correction,
not a runtime break: the named handler rejects a missing body through the
strict JSON decoder (`decodeJSON` answers 400 `invalid_request` on an empty
body), so no client that works against the running server can break. A new
finding that is not listed here describes a real behavior change and must
be fixed, not appended.

POST /api/v1/layouts added required request body: createLayout always decoded a details body.
PATCH /api/v1/layouts/{id} added required request body: updateLayout always decoded a details body.
PUT /api/v1/layouts/{id}/draft added required request body: saveLayoutDraft always decoded expectedDraftRevision plus document.
POST /api/v1/layouts/{id}/publish added required request body: publishLayout always decoded expectedDraftRevision.
POST /api/v1/layouts/{id}/revisions/{revisionId}/restore added required request body: restoreLayoutRevision always decoded expectedDraftRevision.
POST /api/v1/takeovers added required request body: activateTakeover always decoded a takeover body.
POST /api/v1/takeovers/{id}/cancel added required request body: cancelTakeover always decoded a reason body.
POST /api/v1/system/settings/import/preview added required request body: previewSettingsImport always decoded a settings export body.
POST /api/v1/system/settings/import/apply added required request body: applySettingsImport always decoded a settings export body.
POST /api/v1/presentation-overrides/{id}/stop added required request body: stopPresentationOverride always decoded a reason body.
PUT /api/v1/screens/{id}/power-assist added required request body: confirmPowerAssist always decoded a power confirmation body.
POST /api/v1/playlists/{id}/publish removed the success response with the status `200`: publishPlaylist answers 201 on publish and 202 on review submission, never 200.
