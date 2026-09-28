variable "CI_CACHE" {
  default = false
}

target "wpe" {
  context = "apps/edge/renderer-wpe/ci"
  dockerfile = "Dockerfile"
  tags = ["tilecast-wpe-dev"]
  cache-from = CI_CACHE ? ["type=gha,scope=edge-wpe"] : []
  cache-to = CI_CACHE ? ["type=gha,scope=edge-wpe,mode=max"] : []
}

target "edge" {
  context = "apps/edge/renderer-wpe/ci"
  dockerfile = "Dockerfile.edge"
  contexts = { tilecast-wpe-dev = "target:wpe" }
  tags = ["tilecast-edge-dev"]
  cache-from = CI_CACHE ? ["type=gha,scope=edge-dev"] : []
  cache-to = CI_CACHE ? ["type=gha,scope=edge-dev,mode=max"] : []
}

target "server" {
  context = "apps/edge/ci"
  dockerfile = "Dockerfile.e2e"
  contexts = { tilecast-edge-dev = "target:edge" }
  tags = ["tilecast-edge-e2e"]
  cache-from = CI_CACHE ? ["type=gha,scope=edge-server"] : []
  cache-to = CI_CACHE ? ["type=gha,scope=edge-server,mode=max"] : []
}

target "migration" {
  context = "apps/edge/ci"
  dockerfile = "Dockerfile.migrate"
  contexts = { tilecast-edge-e2e = "target:server" }
  tags = ["tilecast-edge-migrate-e2e"]
  cache-from = CI_CACHE ? ["type=gha,scope=edge-migration"] : []
  cache-to = CI_CACHE ? ["type=gha,scope=edge-migration,mode=max"] : []
}

target "electron" {
  context = "apps/player-linux/conformance"
  tags = ["tilecast-conformance-electron"]
  cache-from = CI_CACHE ? ["type=gha,scope=edge-electron"] : []
  cache-to = CI_CACHE ? ["type=gha,scope=edge-electron,mode=max"] : []
}

target "activity" {
  context = "apps/edge/ci"
  dockerfile = "Dockerfile.parity"
  contexts = { tilecast-edge-e2e = "target:server" }
  tags = ["tilecast-edge-parity"]
  cache-from = CI_CACHE ? ["type=gha,scope=edge-activity"] : []
  cache-to = CI_CACHE ? ["type=gha,scope=edge-activity,mode=max"] : []
}
