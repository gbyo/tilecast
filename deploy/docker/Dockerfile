# syntax=docker/dockerfile:1.7
FROM node:26-alpine AS node-deps
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY apps/player-web/package.json apps/player-web/package.json
COPY packages/player-runtime/package.json packages/player-runtime/package.json
COPY packages/design-tokens/package.json packages/design-tokens/package.json
COPY packages/design-tokens/*.css packages/design-tokens/
COPY packages/design-tokens/*.ts packages/design-tokens/
COPY packages/api-schema/package.json packages/api-schema/package.json
COPY packages/manifest-schema/package.json packages/manifest-schema/package.json
COPY packages/settings-schema/package.json packages/settings-schema/package.json
COPY packages/layout-schema/package.json packages/layout-schema/package.json
COPY packages/plugin-sdk/package.json packages/plugin-sdk/package.json
COPY packages/package-sdk/package.json packages/package-sdk/package.json
COPY packages/widget-kit/package.json packages/widget-kit/package.json
COPY packages/widget-sdk/package.json packages/widget-sdk/package.json
COPY packages/presentation-model/package.json packages/presentation-model/package.json
COPY packages/native-bridge-schema/package.json packages/native-bridge-schema/package.json
COPY packages/player-activity/package.json packages/player-activity/package.json
COPY packages/player-active-hours/package.json packages/player-active-hours/package.json
COPY packages/companion-protocol/package.json packages/companion-protocol/package.json
RUN --mount=type=cache,id=tilecast-npm,target=/root/.npm npm ci

FROM node-deps AS dashboard-build
COPY apps/dashboard apps/dashboard
COPY packages/player-runtime packages/player-runtime
COPY packages/manifest-schema/data-document-value-fixtures.json packages/manifest-schema/data-document-value-fixtures.json
# Studio imports the committed generated contract types
# (@tilecast/api-schema/generated/openapi). They are copied, not regenerated,
# so the image builds exactly the contract `make generated-check` pins.
COPY packages/api-schema/generated packages/api-schema/generated
# Studio discovers each bundled plugin's Studio code and manifest at build time.
COPY packages/plugin-sdk packages/plugin-sdk
# Studio builds the Widgets V2 runtimes and their manifests from these
# workspace sources (PR3 Studio V2 authoring shell and later migrations).
COPY packages/widget-kit packages/widget-kit
COPY packages/widget-sdk packages/widget-sdk
COPY packages/presentation-model packages/presentation-model
# Studio's native-host tests type-check against the shared bridge contract.
COPY packages/native-bridge-schema packages/native-bridge-schema
COPY packages/player-activity packages/player-activity
COPY packages/player-active-hours packages/player-active-hours
COPY widgets widgets
COPY data-sources data-sources
COPY plugins plugins
ARG TILECAST_DASHBOARD_SOURCEMAP=false
RUN --mount=type=cache,id=tilecast-dashboard-tsbuild,target=/src/apps/dashboard/node_modules/.tmp \
    TILECAST_DASHBOARD_SOURCEMAP="${TILECAST_DASHBOARD_SOURCEMAP}" npm run build --workspace @tilecast/dashboard

FROM node-deps AS player-web-build
COPY apps/player-web apps/player-web
COPY packages/player-runtime packages/player-runtime
COPY packages/manifest-schema/data-document-value-fixtures.json packages/manifest-schema/data-document-value-fixtures.json
COPY packages/api-schema/generated packages/api-schema/generated
COPY packages/plugin-sdk packages/plugin-sdk
COPY packages/widget-kit packages/widget-kit
COPY packages/widget-sdk packages/widget-sdk
COPY packages/presentation-model packages/presentation-model
COPY packages/native-bridge-schema packages/native-bridge-schema
# Browser Player shares Activity and active-hours policy with the Linux Player.
# Vite resolves both from src through the package's import condition.
COPY packages/player-activity packages/player-activity
COPY packages/player-active-hours packages/player-active-hours
# The Companion bridge imports the page protocol from src, and the capability
# providers import the versioned registry JSON by relative path.
COPY packages/companion-protocol packages/companion-protocol
COPY packages/player-contracts/player-capabilities.json packages/player-contracts/player-capabilities.json
COPY widgets widgets
COPY data-sources data-sources
COPY plugins plugins
RUN npm run build --workspace @tilecast/player-web

FROM golang:1.27-alpine AS server
RUN apk add --no-cache ca-certificates git
# Build identity injected into apps/server/internal/version. Development is
# the default so an unparameterized local build can never claim to be Stable.
# Stable releases inject VERSION_NUMBER from the server-vX.Y.Z tag.
ARG VERSION_NUMBER=0.0.0-dev
ARG VERSION_CHANNEL=development
ARG VERSION_COMMIT=local
ARG VERSION_DATE=development
# The server module replaces the bundled plugins and the plugin SDK with their
# directories in this repository, so all three modules keep their repository
# layout here.
ENV GOWORK=off
WORKDIR /src
COPY apps/server/go.mod apps/server/go.sum apps/server/
COPY plugins/go.mod plugins/go.sum plugins/
COPY packages/plugin-sdk/go/go.mod packages/plugin-sdk/go/go.sum packages/plugin-sdk/go/
COPY packages/package-sdk/go/go.mod packages/package-sdk/go/
COPY widgets/go.mod widgets/
COPY data-sources/go.mod data-sources/
RUN --mount=type=cache,id=tilecast-go-mod,target=/go/pkg/mod \
    cd apps/server && go mod download
COPY packages/plugin-sdk/go packages/plugin-sdk/go
COPY packages/package-sdk/go packages/package-sdk/go
COPY plugins plugins
COPY widgets widgets
COPY data-sources data-sources
COPY apps/server apps/server
COPY --from=dashboard-build /src/apps/dashboard/dist/ apps/server/internal/web/static/
COPY --from=player-web-build /src/apps/player-web/dist/ apps/server/internal/web/player-static/
WORKDIR /src/apps/server
RUN --mount=type=cache,id=tilecast-go-mod,target=/go/pkg/mod \
    --mount=type=cache,id=tilecast-go-build,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X github.com/tilecast/tilecast/apps/server/internal/version.Version=${VERSION_NUMBER} -X github.com/tilecast/tilecast/apps/server/internal/version.Channel=${VERSION_CHANNEL} -X github.com/tilecast/tilecast/apps/server/internal/version.Commit=${VERSION_COMMIT} -X github.com/tilecast/tilecast/apps/server/internal/version.Date=${VERSION_DATE}" -o /out/tilecast-server ./cmd/tilecast-server

FROM alpine:3.24
RUN apk add --no-cache ca-certificates tzdata ffmpeg && addgroup -S tilecast && adduser -S -G tilecast tilecast
WORKDIR /app
COPY --from=server /out/tilecast-server /usr/local/bin/tilecast-server
RUN mkdir -p /data/media/originals /data/media/variants /data/media/thumbnails /data/media/uploads /data/media/trash /data/updates && chown -R tilecast:tilecast /data
USER tilecast
EXPOSE 8080
VOLUME ["/data"]
ENTRYPOINT ["/usr/local/bin/tilecast-server"]
