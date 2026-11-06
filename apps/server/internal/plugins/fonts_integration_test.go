package plugins

import (
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/fonts"
	"github.com/tilecast/tilecast/apps/server/internal/media"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
	"golang.org/x/image/font/gofont/goregular"
)

// A plugin records the library fonts its instances use. The library then
// refuses to remove a family in use and names the instance, and a plugin
// can touch only its own references.
func TestHostFontsBlockRemovalOfAFamilyInUse(t *testing.T) {
	withInstallationDatabase(t, func(env installationEnvironment) {
		alpha := newSyntheticProvider("synthetic_alpha", "alpha")
		gamma := newSyntheticProvider("synthetic_gamma", "gamma")
		service := NewService(env.pool, nil, WithPlugins(alpha, gamma))
		alphaHost, _ := service.Host("synthetic_alpha")
		gammaHost, _ := service.Host("synthetic_gamma")

		storage, err := media.NewLocalStorage(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		library := fonts.NewService(env.pool, storage, fonts.NewCatalog(true))
		uploaded, err := library.Upload(env.ctx, env.userID, "Go-Regular.ttf", goregular.TTF, true)
		if err != nil {
			t.Fatal(err)
		}
		family := uploaded.Family.ID
		instance := uuid.New()

		use := func(host plugin.Host, owner uuid.UUID, label string, ids ...uuid.UUID) error {
			tx, err := env.pool.Begin(env.ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(env.ctx) //nolint:errcheck
			if err = host.Fonts.UseInTx(env.ctx, tx, owner, label, ids...); err != nil {
				return err
			}
			return tx.Commit(env.ctx)
		}
		if err := use(alphaHost, instance, "Lunch bar", uuid.New()); !errors.Is(err, plugin.ErrInvalid) {
			t.Fatalf("an unknown family = %v, want ErrInvalid", err)
		}
		if err := use(alphaHost, instance, "  ", family); !errors.Is(err, plugin.ErrInvalid) {
			t.Fatalf("a blank label = %v, want ErrInvalid", err)
		}
		if err := use(alphaHost, instance, "Lunch bar", family); err != nil {
			t.Fatal(err)
		}
		// Another plugin using the same instance ID does not share the claim.
		if err := use(gammaHost, instance, "Gamma item"); err != nil {
			t.Fatal(err)
		}

		var inUse *fonts.InUse
		if err := library.Delete(env.ctx, env.userID, family); !errors.As(err, &inUse) ||
			len(inUse.Plugins) != 1 || inUse.Plugins[0] != "Lunch bar" {
			t.Fatalf("delete of a family in use = %v (%+v)", err, inUse)
		}

		// Replacing the families releases the old one.
		if err := use(alphaHost, instance, "Lunch bar"); err != nil {
			t.Fatal(err)
		}
		if err := use(alphaHost, instance, "Lunch bar", family); err != nil {
			t.Fatal(err)
		}
		tx, err := env.pool.Begin(env.ctx)
		if err != nil {
			t.Fatal(err)
		}
		// Another plugin's release leaves the claim in place.
		if err = gammaHost.Fonts.ReleaseInTx(env.ctx, tx, instance); err != nil {
			t.Fatal(err)
		}
		if err = tx.Commit(env.ctx); err != nil {
			t.Fatal(err)
		}
		if err := library.Delete(env.ctx, env.userID, family); !errors.Is(err, fonts.ErrInUse) {
			t.Fatalf("delete after another plugin's release = %v", err)
		}

		tx, err = env.pool.Begin(env.ctx)
		if err != nil {
			t.Fatal(err)
		}
		if err = alphaHost.Fonts.ReleaseInTx(env.ctx, tx, instance); err != nil {
			t.Fatal(err)
		}
		if err = tx.Commit(env.ctx); err != nil {
			t.Fatal(err)
		}
		if err := library.Delete(env.ctx, env.userID, family); err != nil {
			t.Fatalf("delete after release = %v", err)
		}
		if err := use(alphaHost, instance, "Lunch bar", family); !errors.Is(err, plugin.ErrInvalid) {
			t.Fatalf("a removed family = %v, want ErrInvalid", err)
		}
	})
}
