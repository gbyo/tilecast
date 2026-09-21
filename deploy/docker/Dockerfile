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
RUN npm ci
COPY apps/dashboard apps/dashboard
RUN npm run build --workspace @tilecast/dashboard

FROM golang:1.27-alpine AS server
RUN apk add --no-cache ca-certificates git
WORKDIR /src
COPY apps/server/go.mod apps/server/go.sum ./
RUN go mod download
COPY apps/server .
COPY --from=dashboard /src/apps/dashboard/dist/ internal/web/static/
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
