.PHONY: android-build android-check bootstrap build check plugins-check plugins-generate demo demo-down demo-logs demo-reset dev-dashboard dev-server docs-check e2e edge-check edge-e2e edge-linux edge-test format helper-check test

bootstrap:
	npm install
	cd apps/server && go mod download

build:
	npm run build
	rm -rf apps/server/internal/web/static
	mkdir -p apps/server/internal/web/static
	cp -R apps/dashboard/dist/. apps/server/internal/web/static/
	cd apps/server && go build ./cmd/tilecast
	cd apps/player-android && ./gradlew assembleDebug

check:
	$(MAKE) docs-check
	$(MAKE) plugins-check
	npm run format:check
	npm run lint
	npm test
	cd apps/server && test -z "$$(gofmt -l . ../../plugins ../../packages/plugin-sdk/go)" && go vet ./... $(PLUGIN_GO_PACKAGES) && go test ./... $(PLUGIN_GO_PACKAGES)
	$(MAKE) helper-check
	cd apps/player-android && ./gradlew testDebugUnitTest lintDebug

# Bundled plugins and the plugin SDK are separate Go modules in the go.work
# workspace; the server's commands name them so one run covers all three.
PLUGIN_GO_PACKAGES = github.com/tilecast/tilecast/plugins/... github.com/tilecast/tilecast/packages/plugin-sdk/go/...

# The Official Tilecast Plugin Conformance checks that need no compiler:
# manifests, generated files, boundaries, migrations, and OpenAPI fragments.
plugins-check:
	npm run plugins:check
	npm test --workspace @tilecast/plugin-sdk

plugins-generate:
	npm run plugins:generate

# The root-owned Presentation Network helper. Its nmcli and NetworkManager
# interaction is mocked, so this needs neither a Wi-Fi adapter nor a running
# NetworkManager daemon.
helper-check:
	python3 -m unittest discover -s apps/player-linux/helper

# Tilecast Edge (apps/edge). edge-linux and the renderer end-to-end run need
# the tilecast-edge-dev image (apps/edge/README.md).
edge-check:
	cd apps/edge && cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings

edge-test:
	cd apps/edge && cargo test --workspace

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
	npm run dev

dev-server:
	cd apps/server && go run ./cmd/tilecast

format:
	npm run format
	cd apps/server && gofmt -w $$(find . ../../plugins ../../packages/plugin-sdk/go -name '*.go' -type f)

test:
	npm test
	npm test --workspace @tilecast/plugin-sdk
	cd apps/server && go test ./... $(PLUGIN_GO_PACKAGES)
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
