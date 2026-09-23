.PHONY: android-build android-check bootstrap build check dev-dashboard dev-server docs-check edge-check edge-e2e edge-linux edge-test format helper-check test

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
	cd apps/server && gofmt -w $$(find . -name '*.go' -type f)

test:
	npm test
	cd apps/server && go test ./...
	python3 -m unittest discover -s apps/player-linux/helper

docs-check:
	bash scripts/check-docs-ste.sh
