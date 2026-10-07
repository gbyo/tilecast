.PHONY: android-build android-check bootstrap build check data-sources-check doctor generate generated-check gofmt-check plugins-check plugins-generate widgets-check demo demo-down demo-logs demo-reset dev dev-dashboard dev-down dev-server dev-server-watch docs-check e2e edge-check edge-e2e edge-linux edge-test player-check player-test windows-check windows-test format helper-check quick test watch-dashboard watch-linux

bootstrap:
	npm install
	cd apps/server && go mod download
	cd apps/cli && go mod download

gofmt-check:
	cd apps/server && test -z "$$(gofmt -l . ../../plugins ../../packages/plugin-sdk/go ../../packages/package-sdk/go ../../apps/cli ../../widgets ../../packages/api-client ../../data-sources)"

build:
	npm run build:all
	rm -rf apps/server/internal/web/static
	mkdir -p apps/server/internal/web/static
	cp -R apps/dashboard/dist/. apps/server/internal/web/static/
	cp -R apps/player-web/dist/. apps/server/internal/web/player-static/
	cd apps/server && go build ./cmd/tilecast-server
	cd apps/cli && go build ./cmd/tilecast
	cd apps/player-android && ./gradlew assembleDebug

check:
	$(MAKE) docs-check
	python3 scripts/ci/check-player-architecture.py
	$(MAKE) plugins-check
	$(MAKE) widgets-check
	$(MAKE) data-sources-check
	$(MAKE) generated-check
	npm run format:check
	npm run lint
	npm test
	$(MAKE) gofmt-check
	cd apps/server && go vet ./... $(PLUGIN_GO_PACKAGES) && go test ./... $(PLUGIN_GO_PACKAGES)
	cd apps/cli && go vet ./... && go test ./...
	cd packages/api-client && go vet ./... && go test ./...
	cd data-sources && go vet ./... && go test ./...
	$(MAKE) helper-check
	npm run android:branding:check
	cd apps/player-android && ./gradlew testDebugUnitTest lintDebug

# Regenerate every generated file in dependency order: the extension
# ledgers and composed OpenAPI contract first, then the consumers (the Go
# client and the TypeScript contract) generated from that contract.
generate:
	npm run player-contracts:generate
	npm run ios:icons:generate
	npm run extensions:generate
	./scripts/sync-marketplace-catalog.sh
	cd packages/api-client && go generate ./...
	npm run generate --workspace @tilecast/api-schema

# Fail on any working-tree diff in a generated file. Run in a clean
# checkout; dirty-tree runs blame unrelated edits.
generated-check:
	./scripts/generated-check.sh

# Area-aware prerequisite diagnostics. Never installs anything:
# make doctor AREA=server|dashboard|edge|windows|android|media|docs
doctor:
	./scripts/doctor.sh $(AREA)

# Bundled plugins and the plugin SDK are separate Go modules in the go.work
# workspace; the server's commands name them so one run covers all three.
PLUGIN_GO_PACKAGES = github.com/tilecast/tilecast/plugins/... github.com/tilecast/tilecast/packages/plugin-sdk/go/... github.com/tilecast/tilecast/packages/package-sdk/go/... github.com/tilecast/tilecast/widgets/...

# The Official Tilecast Plugin Conformance checks that need no compiler:
# manifests, generated files, boundaries, migrations, and OpenAPI fragments.
plugins-check:
	npm run plugins:check
	npm test --workspace @tilecast/plugin-sdk

plugins-generate:
	npm run plugins:generate

# Widgets V2 (docs/widgets-v2.md): module manifests, generated files, the
# catalog suite, and the SDK and kit tests.
widgets-check:
	npm run widgets:check
	npm test --workspace @tilecast/widget-sdk
	npm test --workspace @tilecast/widget-kit

# Data sources: manifests, generated files, and the SDK tests.
data-sources-check:
	npm run data-sources:check

# The root-owned Presentation Network helper. Its nmcli and NetworkManager
# interaction is mocked, so this needs neither a Wi-Fi adapter nor a running
# NetworkManager daemon.
helper-check:
	python3 -m unittest discover -s apps/player-linux/helper

# Tilecast Edge (apps/edge). edge-linux and the renderer end-to-end run need
# the tilecast-edge-dev image (apps/edge/README.md).
edge-check:
	bash apps/edge/ci/cargo-edge.sh fmt --check
	bash apps/edge/ci/cargo-edge.sh clippy --all-targets -- -D warnings

edge-test:
	bash apps/edge/ci/cargo-edge.sh test

# Portable shared Player layer, on Linux, macOS, and Windows.
player-check:
	python3 scripts/ci/check-player-architecture.py
	bash scripts/ci/cargo-player.sh fmt --check
	bash scripts/ci/cargo-player.sh clippy --all-targets --all-features -- -D warnings

player-test:
	bash scripts/ci/cargo-player.sh test --all-features

# Tilecast Player for Windows (apps/player-windows). Unit tests run on any
# host; the renderer and conformance need Windows with WebView2.
windows-check:
	cargo fmt -p tilecast-windows -- --check
	cargo clippy --locked -p tilecast-windows --all-targets --all-features -- -D warnings

windows-test:
	cargo test --locked -p tilecast-windows --all-features

edge-linux:
	docker run --rm -v "$(CURDIR):/src" -v tilecast-edge-target:/target tilecast-edge-dev /src/apps/edge/ci/test-linux.sh

edge-e2e:
	python3 apps/edge/ci/e2e_server.py
	docker run --rm -v "$(CURDIR):/src" -v tilecast-edge-target:/target tilecast-edge-dev /src/apps/edge/renderer-wpe/ci/run-e2e.sh

android-build:
	cd apps/player-android && ./gradlew assembleDebug assembleRelease

android-check:
	cd apps/player-android && ./gradlew testDebugUnitTest lintDebug

dev-dashboard:
	npm run dev --workspace @tilecast/dashboard -- --host 127.0.0.1

dev-server:
	cd apps/server && go run ./cmd/tilecast-server

dev-server-watch:
	go run github.com/air-verse/air@v1.67.3 -c .air.toml

dev:
	node scripts/dev.mjs

dev-down:
	docker compose -f deploy/docker/compose.local-dev.yml down

watch-dashboard:
	npm run test:watch --workspace @tilecast/dashboard

watch-linux:
	npm run test:watch --workspace @gibsonmb71/tilecast-player-linux

quick:
	node scripts/quick-tests.mjs

format:
	npm run format
	cd apps/server && gofmt -w $$(find . ../../plugins ../../packages/plugin-sdk/go ../../packages/package-sdk/go ../../apps/cli -name '*.go' -type f)

test:
	npm test
	npm test --workspace @tilecast/plugin-sdk
	npm test --workspace @tilecast/widget-sdk
	npm test --workspace @tilecast/widget-kit
	npm test --workspace @tilecast/data-source-sdk
	npm test --workspace @tilecast/player-runtime
	npm test --workspace @gibsonmb71/tilecast-player-linux
	cd apps/server && go test ./... $(PLUGIN_GO_PACKAGES)
	cd apps/cli && go test ./...
	python3 -m unittest discover -s apps/player-linux/helper

docs-check:
	bash scripts/check-docs-ste.sh

# Demo Mode: a disposable, pre-seeded installation for development, browser
# tests, and screenshots. See docs/demo-mode.md.
DEMO_COMPOSE = docker compose -f deploy/docker/compose.demo.yml
TILECAST_DEMO_PORT ?= 18080

demo:
	$(DEMO_COMPOSE) up -d --build --wait
	@echo "Tilecast demo is ready at http://localhost:$(TILECAST_DEMO_PORT)"

demo-reset:
	scripts/demo-reset.sh $(SCENARIO)

demo-logs:
	$(DEMO_COMPOSE) logs -f server

demo-down:
	$(DEMO_COMPOSE) down -v --remove-orphans

# Browser smoke tests against a running demo (make demo first).
e2e:
	npm run test:e2e
