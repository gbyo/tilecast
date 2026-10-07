module github.com/tilecast/tilecast/apps/server

go 1.26.0

require (
	github.com/MobilityData/gtfs-realtime-bindings/golang/gtfs v1.0.0
	github.com/avast/apkparser v0.0.0-20251022140151-7294e274bf65
	github.com/avast/apkverifier v0.0.0-20260710162049-d0e1a791cd5a
	github.com/coder/websocket v1.8.15
	github.com/emersion/go-ical v0.0.0-20250609112844-439c63cef608
	github.com/go-chi/chi/v5 v5.3.2
	github.com/go-webauthn/webauthn v0.18.2
	github.com/google/uuid v1.6.0
	github.com/grandcat/zeroconf v1.0.0
	github.com/jackc/pgx/v5 v5.11.0
	github.com/oklog/ulid/v2 v2.1.2
	github.com/opencontainers/go-digest v1.0.0
	github.com/opencontainers/image-spec v1.1.1
	github.com/pressly/goose/v3 v3.28.0
	github.com/sigstore/sigstore-go v1.3.0
	github.com/tilecast/tilecast/data-sources v0.0.0
	github.com/tilecast/tilecast/packages/package-sdk/go v0.0.0
	github.com/tilecast/tilecast/packages/plugin-sdk/go v0.0.0
	github.com/tilecast/tilecast/plugins v0.0.0
	github.com/tilecast/tilecast/widgets v0.0.0
	golang.org/x/crypto v0.57.0
	golang.org/x/image v0.46.0
	golang.org/x/text v0.42.0
	google.golang.org/protobuf v1.36.12
	gopkg.in/yaml.v3 v3.0.1
	oras.land/oras-go/v2 v2.6.2
)

require (
	cloud.google.com/go/iam v1.14.0 // indirect
	cloud.google.com/go/longrunning v1.3.0 // indirect
	github.com/asaskevich/govalidator v0.0.0-20230301143203-a9d515a09cc2 // indirect
	github.com/blang/semver v3.5.1+incompatible // indirect
	github.com/cenkalti/backoff v2.2.1+incompatible // indirect
	github.com/cenkalti/backoff/v5 v5.0.3 // indirect
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/cyberphone/json-canonicalization v0.0.0-20241213102144-19d51d7fe467 // indirect
	github.com/digitorus/pkcs7 v0.0.0-20230818184609-3a137a874352 // indirect
	github.com/digitorus/timestamp v0.0.0-20231217203849-220c5c2851b7 // indirect
	github.com/fxamacker/cbor/v2 v2.9.4 // indirect
	github.com/go-logr/logr v1.4.4 // indirect
	github.com/go-logr/stdr v1.2.2 // indirect
	github.com/go-openapi/analysis v0.25.5 // indirect
	github.com/go-openapi/errors v0.22.8 // indirect
	github.com/go-openapi/jsonpointer v1.0.0 // indirect
	github.com/go-openapi/jsonreference v1.0.0 // indirect
	github.com/go-openapi/loads v0.25.0 // indirect
	github.com/go-openapi/runtime v0.33.0 // indirect
	github.com/go-openapi/runtime/server-middleware v0.30.0 // indirect
	github.com/go-openapi/spec v0.22.9 // indirect
	github.com/go-openapi/strfmt v0.27.0 // indirect
	github.com/go-openapi/swag v0.26.1 // indirect
	github.com/go-openapi/swag/cmdutils v0.27.0 // indirect
	github.com/go-openapi/swag/conv v0.27.3 // indirect
	github.com/go-openapi/swag/fileutils v0.27.3 // indirect
	github.com/go-openapi/swag/jsonname v0.26.1 // indirect
	github.com/go-openapi/swag/jsonutils v0.27.3 // indirect
	github.com/go-openapi/swag/loading v0.27.3 // indirect
	github.com/go-openapi/swag/mangling v0.27.3 // indirect
	github.com/go-openapi/swag/netutils v0.27.0 // indirect
	github.com/go-openapi/swag/pools v0.27.3 // indirect
	github.com/go-openapi/swag/stringutils v0.27.3 // indirect
	github.com/go-openapi/swag/typeutils v0.27.3 // indirect
	github.com/go-openapi/swag/yamlutils v0.27.3 // indirect
	github.com/go-openapi/validate v0.26.1 // indirect
	github.com/go-viper/mapstructure/v2 v2.5.0 // indirect
	github.com/go-webauthn/x v0.3.1 // indirect
	github.com/golang-jwt/jwt/v5 v5.3.1 // indirect
	github.com/google/certificate-transparency-go v1.3.3 // indirect
	github.com/google/go-containerregistry v0.21.7 // indirect
	github.com/google/go-tpm v0.9.8 // indirect
	github.com/googleapis/gax-go/v2 v2.23.0 // indirect
	github.com/grpc-ecosystem/grpc-gateway/v2 v2.29.0 // indirect
	github.com/in-toto/attestation v1.2.0 // indirect
	github.com/in-toto/in-toto-golang v0.11.0 // indirect
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.2 // indirect
	github.com/klauspost/compress v1.19.2 // indirect
	github.com/mfridman/interpolate v0.0.2 // indirect
	github.com/miekg/dns v1.1.27 // indirect
	github.com/philhofer/fwd v1.2.0 // indirect
	github.com/pkg/errors v0.9.1 // indirect
	github.com/rogpeppe/go-internal v1.16.0 // indirect
	github.com/secure-systems-lab/go-securesystemslib v0.11.0 // indirect
	github.com/sethvargo/go-retry v0.4.0 // indirect
	github.com/shibumi/go-pathspec v1.3.0 // indirect
	github.com/sigstore/protobuf-specs v0.5.1 // indirect
	github.com/sigstore/rekor v1.5.3 // indirect
	github.com/sigstore/rekor-tiles/v2 v2.3.0 // indirect
	github.com/sigstore/sigstore v1.10.8 // indirect
	github.com/sigstore/timestamp-authority/v2 v2.1.3 // indirect
	github.com/teambition/rrule-go v1.8.2 // indirect
	github.com/theupdateframework/go-tuf/v2 v2.4.2 // indirect
	github.com/tinylib/msgp v1.6.4 // indirect
	github.com/transparency-dev/formats v0.1.1 // indirect
	github.com/transparency-dev/merkle v0.0.2 // indirect
	github.com/x448/float16 v0.8.4 // indirect
	github.com/youmark/pkcs8 v0.0.0-20240726163527-a2c0da244d78 // indirect
	go.opentelemetry.io/auto/sdk v1.2.1 // indirect
	go.opentelemetry.io/otel v1.46.0 // indirect
	go.opentelemetry.io/otel/metric v1.46.0 // indirect
	go.opentelemetry.io/otel/trace v1.46.0 // indirect
	go.uber.org/multierr v1.11.0 // indirect
	go.yaml.in/yaml/v3 v3.0.5 // indirect
	golang.org/x/mod v0.41.0 // indirect
	golang.org/x/net v0.58.0 // indirect
	golang.org/x/sync v0.23.0 // indirect
	golang.org/x/sys v0.48.0 // indirect
	golang.org/x/term v0.46.0 // indirect
	google.golang.org/api v0.287.1 // indirect
	google.golang.org/genproto v0.0.0-20261005182115-fad411399dd8 // indirect
	google.golang.org/genproto/googleapis/api v0.0.0-20260928230214-8a89bd6388cc // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20260928230214-8a89bd6388cc // indirect
	google.golang.org/grpc v1.83.2 // indirect
	k8s.io/klog/v2 v2.140.0 // indirect
)

// First-party plugins and the plugin SDK are separate modules in this
// repository (see go.work). The replacements keep a build without the
// workspace, such as the server container, resolving them locally.
replace (
	github.com/tilecast/tilecast/data-sources => ../../data-sources
	github.com/tilecast/tilecast/packages/package-sdk/go => ../../packages/package-sdk/go
	github.com/tilecast/tilecast/packages/plugin-sdk/go => ../../packages/plugin-sdk/go
	github.com/tilecast/tilecast/plugins => ../../plugins
	github.com/tilecast/tilecast/widgets => ../../widgets
)
