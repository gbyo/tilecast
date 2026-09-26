# syntax=docker/dockerfile:1.7
FROM node:26-alpine AS dashboard
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY packages/design-tokens/package.json packages/design-tokens/package.json
COPY packages/design-tokens/*.css packages/design-tokens/
COPY packages/design-tokens/*.ts packages/design-tokens/
COPY packages/api-schema/package.json packages/api-schema/package.json
COPY packages/manifest-schema/package.json packages/manifest-schema/package.json
COPY packages/settings-schema/package.json packages/settings-schema/package.json
COPY packages/layout-schema/package.json packages/layout-schema/package.json
COPY packages/plugin-sdk/package.json packages/plugin-sdk/package.json
RUN npm ci
COPY apps/dashboard apps/dashboard
# Studio discovers each bundled plugin's Studio code and manifest at build time.
COPY packages/plugin-sdk packages/plugin-sdk
COPY plugins plugins
RUN npm run build --workspace @tilecast/dashboard

FROM golang:1.26-alpine AS server
RUN apk add --no-cache ca-certificates git
# The server module replaces the bundled plugins and the plugin SDK with their
# directories in this repository, so all three modules keep their repository
# layout here.
ENV GOWORK=off
WORKDIR /src
COPY apps/server/go.mod apps/server/go.sum apps/server/
COPY plugins/go.mod plugins/go.sum plugins/
COPY packages/plugin-sdk/go/go.mod packages/plugin-sdk/go/go.sum packages/plugin-sdk/go/
RUN cd apps/server && go mod download
COPY packages/plugin-sdk/go packages/plugin-sdk/go
COPY plugins plugins
COPY apps/server apps/server
COPY --from=dashboard /src/apps/dashboard/dist/ apps/server/internal/web/static/
WORKDIR /src/apps/server
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/tilecast-server ./cmd/tilecast

FROM alpine:3.24
RUN apk add --no-cache ca-certificates tzdata ffmpeg && addgroup -S tilecast && adduser -S -G tilecast tilecast
WORKDIR /app
COPY --from=server /out/tilecast-server /usr/local/bin/tilecast-server
RUN mkdir -p /data/media/originals /data/media/variants /data/media/thumbnails /data/media/uploads /data/media/trash /data/updates && chown -R tilecast:tilecast /data
USER tilecast
EXPOSE 8080
VOLUME ["/data"]
ENTRYPOINT ["/usr/local/bin/tilecast-server"]
