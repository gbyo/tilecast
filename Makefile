.PHONY: android-build android-check bootstrap build check demo demo-down demo-logs demo-reset dev-dashboard dev-server docs-check e2e format helper-check test

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
	npm run format:check
	npm run lint
	npm test
	cd apps/server && test -z "$$(gofmt -l .)" && go vet ./... && go test ./...
	$(MAKE) helper-check
	cd apps/player-android && ./gradlew testDebugUnitTest lintDebug

# The root-owned Presentation Network helper. Its nmcli and NetworkManager
# interaction is mocked, so this needs neither a Wi-Fi adapter nor a running
# NetworkManager daemon.
helper-check:
	python3 -m unittest discover -s apps/player-linux/helper

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
	cd apps/server && gofmt -w $$(find . -name '*.go' -type f)

test:
	npm test
	cd apps/server && go test ./...
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
