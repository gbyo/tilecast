# oasdiff error exemptions

Read by `scripts/ci/openapi-compat.sh` through `oasdiff breaking
--err-ignore`. oasdiff matches each exemption line on its `METHOD /path`
plus the change description text. Every entry below is a spec correction,
not a runtime break. A body entry names a handler that rejects a missing body
through the strict JSON decoder (`decodeJSON` answers 400 `invalid_request` on
an empty body), so no client that works against the running server can break.
A request enum entry names a request property that the contract now describes as
an open string: every earlier value stays accepted. A response enum entry names a
response property that the contract used to describe as a bare string and now
describes with the closed vocabulary the Server already returned.
A required-property entry names a property the handler already rejected when
missing or outside the new enum, so documenting it cannot break a working
client. A schema-restatement entry names a schema rewritten without `not`
for the Swift generator that accepts and rejects exactly the same requests.
A new finding that is not listed here describes a real behavior change and
must be fixed, not appended.

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
POST /api/v1/schedules/preview added required request body: previewSchedule always decoded a screen and timestamp body.
POST /api/v1/widgets/compile-preview added required request body: compileWidgetPreview always decoded a provider plus configuration body.
POST /api/v1/playlists/{id}/publish removed the success response with the status `200`: publishPlaylist answers 201 on publish and 202 on review submission, never 200.
POST /api/v1/locations added required request body: createLocation always decoded a location body.
PATCH /api/v1/locations/{id} added required request body: updateLocation always decoded a location body.
POST /api/v1/auth/login added required request body: login always decoded a username and password body.
POST /api/v1/content-folders added required request body: createContentFolder always decoded a folder body.
POST /api/v1/content-collections added required request body: createContentCollection always decoded a collection body.
POST /api/v1/content-tags added required request body: createContentTag always decoded a tag body.
PATCH /api/v1/playlists/{id} added required request body: updatePlaylist always decoded a details body.
PATCH /api/v1/playlists/{id}/items/{itemId} added required request body: updatePlaylistItem always decoded an item body.
PUT /api/v1/playlists/{id}/items/order added required request body: reorderPlaylistItems always decoded an itemIds body.
PATCH /api/v1/schedules/{id} added required request body: updateSchedule always decoded a schedule body.
POST /api/v1/screen-groups added required request body: createScreenGroup always decoded a group body.
PATCH /api/v1/screen-groups/{id} added required request body: updateScreenGroup always decoded a group body.
POST /api/v1/screen-groups/{id}/screens added required request body: addScreenGroupMember always decoded a screenId body.
PUT /api/v1/screen-groups/{id}/policy added required request body: putGroupPolicy always decoded a policy body.
PUT /api/v1/screens/{id}/policy added required request body: putScreenPolicy always decoded a policy body.
POST /api/v1/assets/websites added required request body: createWebsite always decoded a website body.
PATCH /api/v1/assets/{id}/website added required request body: updateWebsite always decoded a website body.
POST /api/v1/player-releases/github/device/poll added required request body: pollGitHubDeviceAuthorization always decoded a flowId body.
POST /api/v1/player/commands/{id}/result added required request body: resultPlayerCommand always decoded a command result body.
POST /api/v1/player/enroll added required request body: enrollPlayer always decoded an enrollment body.
POST /api/v1/player/pairing-sessions added required request body: createPairingSession always decoded a pairing body.
POST /api/v1/screens/{id}/commands added required request body: createPlayerCommand always decoded a command body.
POST /api/v1/update-deployments added required request body: createUpdateDeployment always decoded a deployment body.
POST /api/v1/data-sources removed the enum value `air_quality` of the request property `provider`: the request property is now an open string, so the value is still accepted; the Server resolves provider against its live registry, which includes definition and plugin providers.
POST /api/v1/data-sources removed the enum value `atom` of the request property `provider`: the request property is now an open string, so the value is still accepted; the Server resolves provider against its live registry, which includes definition and plugin providers.
POST /api/v1/data-sources removed the enum value `calendar` of the request property `provider`: the request property is now an open string, so the value is still accepted; the Server resolves provider against its live registry, which includes definition and plugin providers.
POST /api/v1/data-sources removed the enum value `cap_alerts` of the request property `provider`: the request property is now an open string, so the value is still accepted; the Server resolves provider against its live registry, which includes definition and plugin providers.
POST /api/v1/data-sources removed the enum value `csv` of the request property `provider`: the request property is now an open string, so the value is still accepted; the Server resolves provider against its live registry, which includes definition and plugin providers.
POST /api/v1/data-sources removed the enum value `json` of the request property `provider`: the request property is now an open string, so the value is still accepted; the Server resolves provider against its live registry, which includes definition and plugin providers.
POST /api/v1/data-sources removed the enum value `manual` of the request property `provider`: the request property is now an open string, so the value is still accepted; the Server resolves provider against its live registry, which includes definition and plugin providers.
POST /api/v1/data-sources removed the enum value `rss` of the request property `provider`: the request property is now an open string, so the value is still accepted; the Server resolves provider against its live registry, which includes definition and plugin providers.
POST /api/v1/data-sources removed the enum value `transit` of the request property `provider`: the request property is now an open string, so the value is still accepted; the Server resolves provider against its live registry, which includes definition and plugin providers.
POST /api/v1/data-sources removed the enum value `weather` of the request property `provider`: the request property is now an open string, so the value is still accepted; the Server resolves provider against its live registry, which includes definition and plugin providers.
PATCH /api/v1/data-sources/{id} removed the enum value `air_quality` of the request property `provider`: the request property is now an open string, so the value is still accepted; the Server resolves provider against its live registry, which includes definition and plugin providers.
PATCH /api/v1/data-sources/{id} removed the enum value `atom` of the request property `provider`: the request property is now an open string, so the value is still accepted; the Server resolves provider against its live registry, which includes definition and plugin providers.
PATCH /api/v1/data-sources/{id} removed the enum value `calendar` of the request property `provider`: the request property is now an open string, so the value is still accepted; the Server resolves provider against its live registry, which includes definition and plugin providers.
PATCH /api/v1/data-sources/{id} removed the enum value `cap_alerts` of the request property `provider`: the request property is now an open string, so the value is still accepted; the Server resolves provider against its live registry, which includes definition and plugin providers.
PATCH /api/v1/data-sources/{id} removed the enum value `csv` of the request property `provider`: the request property is now an open string, so the value is still accepted; the Server resolves provider against its live registry, which includes definition and plugin providers.
PATCH /api/v1/data-sources/{id} removed the enum value `json` of the request property `provider`: the request property is now an open string, so the value is still accepted; the Server resolves provider against its live registry, which includes definition and plugin providers.
PATCH /api/v1/data-sources/{id} removed the enum value `manual` of the request property `provider`: the request property is now an open string, so the value is still accepted; the Server resolves provider against its live registry, which includes definition and plugin providers.
PATCH /api/v1/data-sources/{id} removed the enum value `rss` of the request property `provider`: the request property is now an open string, so the value is still accepted; the Server resolves provider against its live registry, which includes definition and plugin providers.
PATCH /api/v1/data-sources/{id} removed the enum value `transit` of the request property `provider`: the request property is now an open string, so the value is still accepted; the Server resolves provider against its live registry, which includes definition and plugin providers.
PATCH /api/v1/data-sources/{id} removed the enum value `weather` of the request property `provider`: the request property is now an open string, so the value is still accepted; the Server resolves provider against its live registry, which includes definition and plugin providers.
GET /api/v1/auth/status added the new `demo` enum value to the `authMethod` response property for the response status `200`: the value was already returned; the contract now names the vocabulary instead of a bare string.
GET /api/v1/auth/status added the new `oauth` enum value to the `authMethod` response property for the response status `200`: the value was already returned; the contract now names the vocabulary instead of a bare string.
GET /api/v1/auth/status added the new `passkey` enum value to the `authMethod` response property for the response status `200`: the value was already returned; the contract now names the vocabulary instead of a bare string.
GET /api/v1/auth/status added the new `password` enum value to the `authMethod` response property for the response status `200`: the value was already returned; the contract now names the vocabulary instead of a bare string.
GET /api/v1/auth/status added the new `pat` enum value to the `authMethod` response property for the response status `200`: the value was already returned; the contract now names the vocabulary instead of a bare string.
GET /api/v1/auth/status added the new `recovery_code` enum value to the `authMethod` response property for the response status `200`: the value was already returned; the contract now names the vocabulary instead of a bare string.
GET /api/v1/auth/status added the new `totp` enum value to the `authMethod` response property for the response status `200`: the value was already returned; the contract now names the vocabulary instead of a bare string.
POST /api/v1/oauth/approve removed the enum value `S256` of the request property `method`: the property is an open string now, so the Server, not the type, rejects an unsupported method with the same error as before.
POST /api/v1/oauth/deny removed the enum value `S256` of the request property `method`: the property is an open string now, so the Server, not the type, rejects an unsupported method with the same error as before.
GET /api/v1/oauth/authorize removed the enum value `S256` from the `query` request parameter `code_challenge_method`: the parameter is an open string now, so the Server, not the type, rejects an unsupported method with the same error as before.
POST /api/v1/data-sources/{provider}/preview removed the enum value `air_quality` from the `path` request parameter `provider`: the parameter is an open string now, because definition-backed providers are previewable too; every earlier value stays accepted.
POST /api/v1/data-sources/{provider}/preview removed the enum value `atom` from the `path` request parameter `provider`: the parameter is an open string now, because definition-backed providers are previewable too; every earlier value stays accepted.
POST /api/v1/data-sources/{provider}/preview removed the enum value `calendar` from the `path` request parameter `provider`: the parameter is an open string now, because definition-backed providers are previewable too; every earlier value stays accepted.
POST /api/v1/data-sources/{provider}/preview removed the enum value `cap_alerts` from the `path` request parameter `provider`: the parameter is an open string now, because definition-backed providers are previewable too; every earlier value stays accepted.
POST /api/v1/data-sources/{provider}/preview removed the enum value `csv` from the `path` request parameter `provider`: the parameter is an open string now, because definition-backed providers are previewable too; every earlier value stays accepted.
POST /api/v1/data-sources/{provider}/preview removed the enum value `json` from the `path` request parameter `provider`: the parameter is an open string now, because definition-backed providers are previewable too; every earlier value stays accepted.
POST /api/v1/data-sources/{provider}/preview removed the enum value `manual` from the `path` request parameter `provider`: the parameter is an open string now, because definition-backed providers are previewable too; every earlier value stays accepted.
POST /api/v1/data-sources/{provider}/preview removed the enum value `rss` from the `path` request parameter `provider`: the parameter is an open string now, because definition-backed providers are previewable too; every earlier value stays accepted.
POST /api/v1/data-sources/{provider}/preview removed the enum value `transit` from the `path` request parameter `provider`: the parameter is an open string now, because definition-backed providers are previewable too; every earlier value stays accepted.
POST /api/v1/data-sources/{provider}/preview removed the enum value `weather` from the `path` request parameter `provider`: the parameter is an open string now, because definition-backed providers are previewable too; every earlier value stays accepted.
POST /api/v1/oauth/ios-session request property `client_id` was restricted to a list of enum values: oauthIOSSession already rejected any client_id other than tilecast-ios, so the contract now names the only value the server ever accepted.
POST /api/v1/oauth/ios-session the request property `client_id` became required: oauthIOSSession already rejected a missing client_id, so documenting it cannot break a working client.
POST /api/v1/playlists/{id}/items the request body dependentRequired was added: when `layoutId` is present, `durationMs` are required: PlaylistItemInput restates the same rule without `not` for the Swift generator; layout items still need a duration and asset items are unchanged.
POST /api/v1/playlists/{id}/items removed `subschema #1, subschema #2` from the request body `oneOf` list: PlaylistItemInput restates the same oneOf branches without `not`; asset-only and layout-with-duration still validate, and neither, both, or layout-without-duration still fail.
PUT /api/v1/playlists/{id}/items/bulk removed `subschema #1, subschema #2` from the request body `oneOf` list: PlaylistBulkItemInput restates the same oneOf branches without `not`; transition-only and duration-only still validate, and both or neither still fail.
PATCH /api/v1/playlists/{id}/items/{itemId} the request body dependentRequired was added: when `layoutId` is present, `durationMs` are required: PlaylistItemInput restates the same rule without `not` for the Swift generator; layout items still need a duration and asset items are unchanged.
PATCH /api/v1/playlists/{id}/items/{itemId} removed `subschema #1, subschema #2` from the request body `oneOf` list: PlaylistItemInput restates the same oneOf branches without `not`; asset-only and layout-with-duration still validate, and neither, both, or layout-without-duration still fail.
