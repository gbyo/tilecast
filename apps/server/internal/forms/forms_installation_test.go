package forms

import (
	"errors"
	"testing"
	"time"

	"github.com/tilecast/tilecast/apps/server/internal/plugins"
)

// Forms is an installable plugin. Creating a form requires the installation,
// and the time-window worker leaves forms alone when it is missing — a state
// normal operation cannot reach, since Remove refuses while forms exist, but a
// restore or manual edit can.
func TestFormsRequireInstallation(t *testing.T) {
	e := setupForms(t)
	form, err := e.service.CreateForm(e.ctx, e.owner, FormInput{Name: "Expiring", DraftSchema: announcementSchema()})
	if err != nil {
		t.Fatal(err)
	}
	rec := e.approveWithExpiry(t, form.ID, "Old", time.Now().UTC().Add(-time.Hour))
	if _, err = e.pool.Exec(e.ctx, `DELETE FROM plugin_installations WHERE plugin_id='forms'`); err != nil {
		t.Fatal(err)
	}
	if _, err = e.service.CreateForm(e.ctx, e.owner, FormInput{Name: "Another", DraftSchema: announcementSchema()}); !errors.Is(err, plugins.ErrPluginNotInstalled) {
		t.Fatalf("create form without installation err = %v", err)
	}
	e.forceDue(t, form.ID)
	if err = NewProjectionWorker(e.service, nil).RunDue(e.ctx); err != nil {
		t.Fatal(err)
	}
	if got := e.expiredEventCount(t, rec.ID); got != 0 {
		t.Fatalf("worker expired %d records for an uninstalled plugin", got)
	}
}
