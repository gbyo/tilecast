package services

import (
	"context"
	"encoding/json"
	"reflect"
	"slices"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/tilecast/tilecast/apps/server/internal/auth"
	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

// These tests pin the shared read contracts without a database: the
// registry entries, the one context rule, grant separation between
// content.read@1 and @2, the cursor and limit contract, and the public model
// shapes. Behavior against seeded rows lives in the integration tests.

func TestContentReadV1IsFrozen(t *testing.T) {
	capability, ok := Find("content.read", 1)
	if !ok {
		t.Fatal("content.read@1 is not in the registry")
	}
	if len(capability.Callers) != 0 || capability.AllowsCaller(CallerBundled) || !capability.AllowsCaller(CallerPackage) {
		t.Fatalf("content.read@1 callers = %v, want packages only", capability.Callers)
	}
	if !reflect.DeepEqual(capability.Contexts, []string{ContextStudio, ContextBackground}) {
		t.Fatalf("content.read@1 contexts = %v", capability.Contexts)
	}
	want := []string{
		"content.read@1/playlists.list", "content.read@1/playlists.get",
		"content.read@1/layouts.list", "content.read@1/layouts.get",
		"content.read@1/datasources.list", "content.read@1/datasources.get",
		"content.read@1/schedules.list", "content.read@1/schedules.get",
		"content.read@1/groups.list", "content.read@1/groups.get",
	}
	got := []string{}
	for _, operation := range capability.Operations {
		got = append(got, operation.Name)
		if operation.Mutating || !reflect.DeepEqual(operation.Contexts, []string{ContextStudio, ContextBackground}) {
			t.Errorf("%s changed: mutating=%t contexts=%v", operation.Name, operation.Mutating, operation.Contexts)
		}
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("content.read@1 operations = %v", got)
	}
	if capability.Name != "Content library" || capability.Category != CategoryRead {
		t.Fatalf("content.read@1 display changed: %+v", capability)
	}
}

func TestSharedReadServicesAreExplicit(t *testing.T) {
	for _, test := range []struct {
		id         string
		version    int
		operations []string
	}{
		{"content.read", 2, []string{
			"playlists.list", "playlists.get", "layouts.list", "layouts.get", "widgets.list", "widgets.get",
			"media.list", "media.get", "dataSources.list", "dataSources.get", "schedules.list", "schedules.get",
			"groups.list", "groups.get",
		}},
		{"activity.read", 1, []string{"proof.list", "proof.summary", "compliance.summary", "screens.current"}},
	} {
		capability, ok := Find(test.id, test.version)
		if !ok {
			t.Fatalf("%s@%d is not in the registry", test.id, test.version)
		}
		if !capability.AllowsCaller(CallerPackage) || !capability.AllowsCaller(CallerBundled) {
			t.Errorf("%s@%d callers = %v", test.id, test.version, capability.Callers)
		}
		if capability.Category != CategoryRead {
			t.Errorf("%s@%d category = %s", test.id, test.version, capability.Category)
		}
		want := []string{ContextStudio, ContextBackground, ContextSystem}
		if !reflect.DeepEqual(capability.Contexts, want) {
			t.Errorf("%s@%d contexts = %v", test.id, test.version, capability.Contexts)
		}
		names := []string{}
		for _, operation := range capability.Operations {
			names = append(names, strings.TrimPrefix(operation.Name, test.id+"@"+string(rune('0'+test.version))+"/"))
			if operation.Mutating || operation.Network {
				t.Errorf("%s is not a plain read", operation.Name)
			}
			if !reflect.DeepEqual(operation.Contexts, want) {
				t.Errorf("%s contexts = %v", operation.Name, operation.Contexts)
			}
			if LimitsOf(operation).MaxOutputBytes != MaxOutputBytes {
				t.Errorf("%s widens the package output window", operation.Name)
			}
		}
		if !reflect.DeepEqual(names, test.operations) {
			t.Errorf("%s@%d operations = %v", test.id, test.version, names)
		}
	}
}

func TestReviewDetailsCarryContexts(t *testing.T) {
	details, err := Details([]packagemanifest.ServiceGrant{{ID: "content.read", Version: 1}, {ID: "content.read", Version: 2}, {ID: "activity.read", Version: 1}})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(details[0].Contexts, []string{ContextStudio, ContextBackground}) {
		t.Fatalf("content.read@1 review contexts = %v", details[0].Contexts)
	}
	for _, detail := range details[1:] {
		if !slices.Contains(detail.Contexts, ContextSystem) || !slices.Contains(detail.Operations[0].Contexts, ContextBackground) {
			t.Fatalf("%s@%d review contexts = %v / %v", detail.ID, detail.Version, detail.Contexts, detail.Operations[0].Contexts)
		}
	}
	// A V1 grant and a V2 grant are different review rows.
	if details[0].Version == details[1].Version {
		t.Fatal("content.read versions collapsed in review")
	}
}

func readGrant(id string, version int) []packagemanifest.ServiceGrant {
	return []packagemanifest.ServiceGrant{{ID: id, Version: version}}
}

func TestReadServicesFollowTheOneContextRule(t *testing.T) {
	dispatcher := testDispatcher()
	ctx := context.Background()
	owner := builtinActor("owner")
	for _, operation := range []string{"content.read@2/playlists.list", "activity.read@1/proof.list", "activity.read@1/screens.current"} {
		_, capability, _ := LookupOperation(operation)
		grants := readGrant(capability.ID, capability.Version)
		cases := []struct {
			name string
			call Call
			kind string
		}{
			{"missing grant", Call{PackageID: "acme.read", Context: ContextBackground, Operation: operation}, DenialMissingGrant},
			{"wrong version", Call{PackageID: "acme.read", Context: ContextBackground, Grants: readGrant(capability.ID, capability.Version+1), Operation: operation}, DenialMissingGrant},
			{"bundled without declaring", Call{PluginID: "acme-plugin", Context: ContextBackground, Operation: operation}, DenialMissingGrant},
			{"studio without actor", Call{PackageID: "acme.read", Context: ContextStudio, Grants: grants, Operation: operation}, DenialInvalidActor},
			{"background with actor", Call{PackageID: "acme.read", Context: ContextBackground, Actor: owner, Grants: grants, Operation: operation}, DenialInvalidActor},
			{"system with actor", Call{PackageID: "acme.read", Context: ContextSystem, Actor: owner, Grants: grants, Operation: operation}, DenialInvalidActor},
			{"unknown context", Call{PackageID: "acme.read", Context: "webhook", Grants: grants, Operation: operation}, DenialForbiddenContext},
			{"empty context", Call{PackageID: "acme.read", Grants: grants, Operation: operation}, DenialForbiddenContext},
		}
		for _, test := range cases {
			_, denial, _ := dispatcher.Call(ctx, test.call)
			if denial == nil || denial.Kind != test.kind {
				t.Errorf("%s %s: denial = %+v, want %s", operation, test.name, denial, test.kind)
			}
		}
	}
}

func TestContentReadV1GrantDoesNotReachV2(t *testing.T) {
	dispatcher := testDispatcher()
	for _, capability := range All() {
		if capability.ID != "content.read" || capability.Version != 2 {
			continue
		}
		for _, operation := range capability.Operations {
			for _, call := range []Call{
				{PackageID: "acme.v1", Context: ContextBackground, Grants: readGrant("content.read", 1), Operation: operation.Name},
				{PackageID: "acme.v1", Context: ContextStudio, Actor: builtinActor("owner"), Grants: readGrant("content.read", 1), Operation: operation.Name},
			} {
				if _, denial, _ := dispatcher.Call(context.Background(), call); denial == nil || denial.Kind != DenialMissingGrant {
					t.Errorf("a content.read@1 grant called %s in %s: %+v", operation.Name, call.Context, denial)
				}
			}
		}
	}
	// And a V2 grant does not reach V1, which stays package-only.
	if _, denial, _ := dispatcher.Call(context.Background(), Call{PackageID: "acme.v2", Context: ContextBackground, Grants: readGrant("content.read", 2), Operation: "content.read@1/playlists.list"}); denial == nil || denial.Kind != DenialMissingGrant {
		t.Errorf("a content.read@2 grant called content.read@1: %+v", denial)
	}
	if err := ValidateGrants(readGrant("content.read", 3)); err == nil {
		t.Error("an unknown content.read version validated")
	}
}

func TestStudioReadsNeedTheDashboardCapability(t *testing.T) {
	dispatcher := testDispatcher()
	none := &Actor{UserID: uuid.New(), Role: "custom.nothing", Capabilities: auth.NewCapabilitySet()}
	for operation, capability := range map[string]string{
		"content.read@2/playlists.list":      "content.read",
		"content.read@2/playlists.get":       "content.read",
		"content.read@2/layouts.list":        "content.read",
		"content.read@2/widgets.list":        "content.read",
		"content.read@2/media.list":          "content.read",
		"content.read@2/dataSources.list":    "content.read",
		"content.read@2/dataSources.get":     "content.read",
		"activity.read@1/proof.list":         "activity.read",
		"activity.read@1/proof.summary":      "activity.read",
		"activity.read@1/compliance.summary": "activity.read",
	} {
		version := 2
		if capability == "activity.read" {
			version = 1
		}
		input := []byte(`{}`)
		if strings.HasSuffix(operation, ".get") {
			input = []byte(`{"id":"` + uuid.NewString() + `"}`)
		}
		_, denial, failure := dispatcher.Call(context.Background(), Call{
			PackageID: "acme.read", Context: ContextStudio, Actor: none,
			Grants: readGrant(capability, version), Operation: operation, Input: input,
		})
		if denial != nil || failure == nil || failure.Code != ErrCodeForbidden {
			t.Errorf("%s without the capability: denial=%+v failure=%+v", operation, denial, failure)
		}
	}
}

func TestListLimitBounds(t *testing.T) {
	for limit, want := range map[int]int{0: DefaultListLimit, 1: 1, 50: 50, MaxListLimit: MaxListLimit} {
		got, failure := listLimit(limit)
		if failure != nil || got != want {
			t.Errorf("listLimit(%d) = %d, %+v", limit, got, failure)
		}
	}
	for _, limit := range []int{-1, MaxListLimit + 1, 10000} {
		if _, failure := listLimit(limit); failure == nil || failure.Code != ErrCodeInvalidInput {
			t.Errorf("listLimit(%d) accepted", limit)
		}
	}
	if DefaultListLimit != 50 || MaxListLimit != 250 {
		t.Fatalf("list bounds changed: %d/%d", DefaultListLimit, MaxListLimit)
	}
}

func TestCursorsBindOperationAndFilters(t *testing.T) {
	at := time.Date(2026, 11, 23, 12, 0, 0, 123, time.UTC)
	id := uuid.New()
	filters := map[string]string{"search": "lobby"}
	token := keysetCursor("content.read@2/playlists.list", filters, at, id)
	after, failure := decodeKeysetCursor(token, "content.read@2/playlists.list", filters)
	if failure != nil || !after.At.Equal(at) || after.ID != id {
		t.Fatalf("round trip = %+v, %+v", after, failure)
	}
	if _, failure := decodeKeysetCursor(token, "content.read@2/playlists.list", map[string]string{"search": "hall"}); failure == nil || failure.Code != ErrCodeInvalidInput {
		t.Fatal("a cursor continued under other filters")
	}
	if _, failure := decodeKeysetCursor(token, "content.read@2/layouts.list", filters); failure == nil || failure.Code != ErrCodeInvalidInput {
		t.Fatal("a cursor continued under another operation")
	}
	for _, garbage := range []string{"%%%", "e30", strings.Repeat("a", maxCursorBytes+1), token[:len(token)-4]} {
		if _, failure := decodeKeysetCursor(garbage, "content.read@2/playlists.list", filters); failure == nil || failure.Code != ErrCodeInvalidInput {
			t.Errorf("garbage cursor %q accepted", garbage)
		}
	}
	if after, failure := decodeKeysetCursor("", "content.read@2/playlists.list", filters); after != nil || failure != nil {
		t.Fatal("an empty cursor is not the first page")
	}
}

func TestFitPageStaysWithinTheTransportBound(t *testing.T) {
	type item struct {
		ID   int    `json:"id"`
		Text string `json:"text"`
	}
	items := make([]item, 0, 250)
	for index := range 250 {
		items = append(items, item{ID: index, Text: strings.Repeat("x", 600)})
	}
	operation := "content.read@2/playlists.list"
	kept, last := fitPage(operation, items, 250, false)
	if len(kept) == 0 || len(kept) >= 250 || last != len(kept)-1 {
		t.Fatalf("kept %d, last %d", len(kept), last)
	}
	encoded, _ := json.Marshal(map[string]any{"ok": true, "data": map[string]any{"items": kept, "nextCursor": strings.Repeat("c", 400)}})
	if len(encoded) > MaxOutputBytes {
		t.Fatalf("page is %d bytes", len(encoded))
	}
	small, last := fitPage(operation, items[:3], 2, false)
	if len(small) != 2 || last != 1 {
		t.Fatalf("limit not applied: %d, %d", len(small), last)
	}
	all, last := fitPage(operation, items[:3], 3, false)
	if len(all) != 3 || last != -1 {
		t.Fatalf("a final page issued a cursor: %d, %d", len(all), last)
	}
}

// jsonKeys returns the sorted member names of value's encoding.
func jsonKeys(t *testing.T, value any) []string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var members map[string]any
	if err := json.Unmarshal(encoded, &members); err != nil {
		t.Fatal(err)
	}
	keys := make([]string, 0, len(members))
	for key := range members {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// fill sets every exported member of a struct, recursively through embedded
// structs, so omitempty members still encode.
func fill(value reflect.Value) {
	switch value.Kind() {
	case reflect.Pointer:
		value.Set(reflect.New(value.Type().Elem()))
		fill(value.Elem())
	case reflect.Struct:
		if value.Type() == reflect.TypeOf(time.Time{}) {
			value.Set(reflect.ValueOf(time.Unix(1, 0).UTC()))
			return
		}
		if value.Type() == reflect.TypeOf(uuid.UUID{}) {
			value.Set(reflect.ValueOf(uuid.New()))
			return
		}
		for index := range value.NumField() {
			if field := value.Type().Field(index); field.IsExported() || field.Anonymous {
				fill(value.Field(index))
			}
		}
	case reflect.String:
		value.SetString("x")
	case reflect.Bool:
		value.SetBool(true)
	case reflect.Int, reflect.Int64:
		value.SetInt(1)
	case reflect.Float64:
		value.SetFloat(1)
	case reflect.Slice:
		if value.Type() == reflect.TypeOf(json.RawMessage{}) {
			value.SetBytes([]byte(`{}`))
			return
		}
		value.Set(reflect.MakeSlice(value.Type(), 0, 0))
	}
}

func filled[T any]() T {
	var value T
	fill(reflect.ValueOf(&value).Elem())
	return value
}

// TestReadServiceModelShapes pins every member of the public read models.
// A change here is a plugin API change: it needs a new service version
// when it removes or renames a member, and documentation when it adds one.
func TestReadServiceModelShapes(t *testing.T) {
	for name, test := range map[string]struct {
		value any
		want  string
	}{
		"playlist":         {filled[contentPlaylist](), "createdAt description draftRevision hasUnpublishedChanges id itemCount name publishedRevision sourceType updatedAt"},
		"playlistDetail":   {filled[contentPlaylistDetail](), "createdAt dataSourceIds description draftRevision hasUnpublishedChanges id itemCount items itemsComplete name publishedRevision sourceType tagRule updatedAt"},
		"playlistItem":     {filled[contentPlaylistItem](), "contentId contentType durationMs id position"},
		"layout":           {filled[contentLayout](), "canvasHeight canvasWidth createdAt description draftRevision hasUnpublishedChanges id name orientation publishedAt publishedRevision updatedAt"},
		"layoutDetail":     {filled[contentLayoutDetail](), "canvasHeight canvasWidth createdAt dependencies dependenciesComplete description draftRevision hasUnpublishedChanges id name orientation placementCount publishedAt publishedRevision updatedAt"},
		"widget":           {filled[contentWidget](), "availableFrom configVersion createdAt description expiresAt id name provider updatedAt"},
		"widgetDetail":     {filled[contentWidgetDetail](), "availableFrom configVersion configuration configurationOmitted createdAt description expiresAt folderId id name provider updatedAt"},
		"media":            {filled[contentMedia](), "availableFrom createdAt description durationSeconds expiresAt height id mimeType name processingStatus sizeBytes type updatedAt width"},
		"mediaDetail":      {filled[contentMediaDetail](), "availableFrom createdAt description durationSeconds expiresAt folderId height id mimeType name processingStatus sizeBytes tagIds type updatedAt width"},
		"dataSource":       {filled[contentDataSource](), "cachedRecordCount configVersion createdAt description id name provider status updatedAt"},
		"dataSourceDetail": {filled[contentDataSourceDetail](), "cacheExpiresAt cacheUpdatedAt cachedRecordCount configVersion createdAt description fields fieldsComplete id lastAttemptedRefreshAt lastSuccessfulRefreshAt name provider status updatedAt usingCachedData"},
		"schedule":         {filled[contentSchedule](), "createdAt dailyEnd dailyStart daysOfWeek description enabled endDate id layoutId name oneTimeEnd oneTimeStart playlistId presentationType priority startDate timezone type updatedAt"},
		"scheduleDetail":   {filled[contentScheduleDetail](), "createdAt dailyEnd dailyStart daysOfWeek description enabled endDate id layoutId name oneTimeEnd oneTimeStart playlistId presentationType priority startDate targets targetsComplete timezone type updatedAt"},
		"group":            {filled[contentGroup](), "createdAt description displayMode id layoutId name playlistId presentationType screenCount updatedAt"},
		"groupDetail":      {filled[contentGroupDetail](), "createdAt description displayMode id layoutId name playlistId presentationType screenCount screenIds screensComplete updatedAt"},
		"proof":            {filled[activityProof](), "actualDurationMs contentId contentName contentType endedAt expectedDurationMs failureCode groupId groupName id layoutPlacementId manifestVersion playlistItemId presentationId presentationName presentationRevision presentationType result scheduleId screenId screenName selectedRecordId selectionDate sessionType snapshotHash sourceCachedAt sourceId sourceRevision startedAt takeoverId terminalReason trigger"},
		"summaryItem":      {filled[activitySummaryItem](), "completed confirmedScreenPlaybackMs contentExposureMs failures interrupted key label partial records sessionCompletionPercent unknown"},
		"complianceTotals": {filled[activityComplianceTotals](), "cancelledMs compliancePercent confirmedMs earlyEndings failedWindows lateStarts measurableExpectedMs missedMs neverStarted notMeasurableMs offlineMisses partialWindows takeoverOverriddenMs windows"},
		"complianceGroup":  {filled[activityComplianceGroup](), "compliancePercent confirmedMs earlyEndings key label lateStarts measurableExpectedMs missedMs neverStarted offlineMisses topFailureReason windows"},
		"currentScreen":    {filled[activityScreen](), "currentContent currentPresentation health healthReason lastContactAt lastHealthyPlaybackAt lastSuccessfulManifestActivationAt online screenId screenName"},
		"openSession":      {filled[activityOpenSession](), "id name startedAt type"},
	} {
		if got := strings.Join(jsonKeys(t, test.value), " "); got != test.want {
			t.Errorf("%s members =\n  %s\nwant\n  %s", name, got, test.want)
		}
	}
}

func TestActivityModelsCarryNoSensitiveMembers(t *testing.T) {
	forbidden := []string{"metadata", "details", "ip", "address", "request", "token", "secret", "cookie", "authorization", "credential", "diagnostic", "payload", "message"}
	for _, value := range []any{filled[activityProof](), filled[activityScreen](), filled[activitySummaryItem](), filled[activityComplianceGroup]()} {
		for _, key := range jsonKeys(t, value) {
			lower := strings.ToLower(key)
			for _, fragment := range forbidden {
				if lower == fragment || strings.HasPrefix(lower, fragment) || strings.HasSuffix(lower, fragment) {
					t.Errorf("%T exposes %q", value, key)
				}
			}
		}
	}
}

func TestWidgetConfigurationDropsSecrets(t *testing.T) {
	raw := json.RawMessage(`{"title":"Lunch","apiToken":"t-1","nested":{"Password":"p","color":"#fff","items":[{"clientSecret":"s","label":"a"}]},"Authorization":"Bearer x","accessKey":"k","sessionCookie":"c"}`)
	var got map[string]any
	if err := json.Unmarshal(safeConfiguration(raw), &got); err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(got)
	for _, leaked := range []string{"t-1", "Bearer", `"p"`, `"s"`, `"k"`, `"c"`} {
		if strings.Contains(string(encoded), leaked) {
			t.Fatalf("configuration leaked %s: %s", leaked, encoded)
		}
	}
	if got["title"] != "Lunch" || got["nested"].(map[string]any)["color"] != "#fff" {
		t.Fatalf("authored members lost: %s", encoded)
	}
	if string(safeConfiguration(json.RawMessage(`not json`))) != "null" {
		t.Fatal("invalid configuration was returned")
	}
}
