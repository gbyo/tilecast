//! Player-owned presentation media capabilities.
//!
//! A CAS digest identifies bytes; it never authorizes a renderer read. The
//! `tcmedia` scheme handler resolves only these random, renderer-bound
//! grants. Generations move through prepared, active and draining before
//! retirement. The lifecycle mirrors the Edge daemon's, because the Runtime
//! sees the same `tcmedia://cap/<opaque>` URIs on every native host.

use player_core::{VerifiedContentRef, VerifiedFrameRef};
use player_types::Sha256Digest;
use ring::rand::{SecureRandom as _, SystemRandom};
use std::collections::{HashMap, HashSet};

const TOKEN_BYTES: usize = 32;
const MAX_GRANTS_PER_GENERATION: usize = 1024;
const PREPARED_LIFETIME_MS: i64 = 10 * 60 * 1_000;
const DRAIN_LIFETIME_MS: i64 = 30 * 1_000;

#[derive(Clone, PartialEq, Eq, Hash)]
pub struct MediaCapability(String);

impl std::fmt::Debug for MediaCapability {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("MediaCapability([redacted])")
    }
}

impl MediaCapability {
    pub fn uri(&self) -> String {
        format!("tcmedia://cap/{}", self.0)
    }

    /// The frame-document URI for a capability minted by
    /// [`MediaRegistry::prepare_frames`]: `tcwidget://cap/<opaque>`. The
    /// token authenticates identically; only the scheme tells the host to
    /// confine the answer as a sandboxed frame.
    pub fn frame_uri(&self) -> String {
        format!("{}://{}/{}", player_types::frames::FRAME_SCHEME, player_types::frames::FRAME_CAPABILITY_HOST, self.0)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn parse(value: &str) -> Option<Self> {
        (value.len() == TOKEN_BYTES * 2
            && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
        .then(|| Self(value.to_owned()))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GenerationState {
    Prepared,
    Active,
    Draining,
}

/// What a grant authorizes reads for. Media and frame capabilities share
/// one token space and lifecycle; the usage is pinned at mint time and a
/// grant never serves the other scheme.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaGrantKind {
    Media,
    Frame,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaGrant {
    pub session: uuid::Uuid,
    pub generation: u64,
    pub sha256: Sha256Digest,
    pub size_bytes: u64,
    pub mime_type: String,
    pub kind: MediaGrantKind,
    pub state: GenerationState,
    pub expires_at_ms: Option<i64>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum MediaError {
    #[error("renderer session has changed")]
    RendererChanged,
    #[error("presentation generation already exists")]
    GenerationExists,
    #[error("presentation has too many media objects")]
    TooMany,
    #[error("presentation lists conflicting content claims")]
    ConflictingContent,
    #[error("random capability generation failed")]
    Random,
    #[error("presentation generation is not prepared")]
    NotPrepared,
}

#[derive(Debug)]
struct Generation {
    state: GenerationState,
    tokens: Vec<MediaCapability>,
    /// Manifest asset/variant identity to verified digest, from the
    /// activation's projection media map. Plugin media loads address
    /// `tcmedia://variant/<assetId>/<variantId>` (the reference player's
    /// shape); the alias binds those loads to this generation's grants, so
    /// re-activation still revokes them.
    aliases: HashMap<(uuid::Uuid, uuid::Uuid), Sha256Digest>,
    expires_at_ms: Option<i64>,
}

/// The bound WebView2 controller, identified by the host's opaque session.
/// A new controller invalidates every old capability immediately.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RendererInstance {
    pub session: uuid::Uuid,
}

/// Grants are process-local. A restart never revives a capability; the
/// renderer must reconnect and receive a fresh activation.
#[derive(Debug, Default)]
pub struct MediaRegistry {
    renderer: Option<RendererInstance>,
    generations: HashMap<u64, Generation>,
    grants: HashMap<MediaCapability, MediaGrant>,
}

impl MediaRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// A new renderer instance invalidates every old capability immediately.
    pub fn bind_renderer(&mut self, renderer: RendererInstance) {
        if self.renderer != Some(renderer) {
            self.generations.clear();
            self.grants.clear();
            self.renderer = Some(renderer);
        }
    }

    pub fn renderer(&self) -> Option<RendererInstance> {
        self.renderer
    }

    pub fn unbind_renderer(&mut self, session: uuid::Uuid) {
        if self.renderer.is_some_and(|renderer| renderer.session == session) {
            self.generations.clear();
            self.grants.clear();
            self.renderer = None;
        }
    }

    /// Creates one opaque capability per distinct verified object. The
    /// caller still has to establish CAS verification and pins before
    /// sending the corresponding presentation to the Runtime.
    pub fn prepare(
        &mut self,
        session: uuid::Uuid,
        generation: u64,
        now_ms: i64,
        content: &[VerifiedContentRef],
    ) -> Result<HashMap<Sha256Digest, MediaCapability>, MediaError> {
        if self.renderer.is_none_or(|renderer| renderer.session != session) {
            return Err(MediaError::RendererChanged);
        }
        if self.generations.contains_key(&generation) {
            return Err(MediaError::GenerationExists);
        }
        if content.len() > MAX_GRANTS_PER_GENERATION {
            return Err(MediaError::TooMany);
        }
        let mut unique = HashMap::new();
        for reference in content {
            if let Some(previous) = unique.insert(reference.sha256, reference)
                && (previous.size_bytes != reference.size_bytes || previous.mime_type != reference.mime_type)
            {
                return Err(MediaError::ConflictingContent);
            }
        }
        let random = SystemRandom::new();
        let mut minted = HashMap::new();
        let mut tokens = Vec::with_capacity(unique.len());
        let mut seen = HashSet::new();
        for reference in unique.values() {
            let token = loop {
                let mut bytes = [0u8; TOKEN_BYTES];
                random.fill(&mut bytes).map_err(|_| MediaError::Random)?;
                let candidate = MediaCapability(bytes.iter().map(|byte| format!("{byte:02x}")).collect());
                if !self.grants.contains_key(&candidate) && seen.insert(candidate.clone()) {
                    break candidate;
                }
            };
            minted.insert(reference.sha256, token.clone());
            tokens.push(token);
        }
        for reference in unique.values() {
            let token = minted.get(&reference.sha256).expect("minted for every content reference").clone();
            self.grants.insert(
                token,
                MediaGrant {
                    session,
                    generation,
                    sha256: reference.sha256,
                    size_bytes: reference.size_bytes,
                    mime_type: reference.mime_type.as_str().to_owned(),
                    kind: MediaGrantKind::Media,
                    state: GenerationState::Prepared,
                    expires_at_ms: Some(now_ms.saturating_add(PREPARED_LIFETIME_MS)),
                },
            );
        }
        self.generations.insert(
            generation,
            Generation {
                state: GenerationState::Prepared,
                tokens,
                aliases: HashMap::new(),
                expires_at_ms: Some(now_ms.saturating_add(PREPARED_LIFETIME_MS)),
            },
        );
        Ok(minted)
    }

    /// Creates one opaque frame capability per distinct verified frame,
    /// attached to the generation `prepare` opened. A digest claimed as
    /// both media and a frame fails the activation rather than serving
    /// either: the substitution maps are digest-keyed and must not guess.
    pub fn prepare_frames(
        &mut self,
        session: uuid::Uuid,
        generation: u64,
        now_ms: i64,
        frames: &[VerifiedFrameRef],
    ) -> Result<HashMap<Sha256Digest, MediaCapability>, MediaError> {
        if self.renderer.is_none_or(|renderer| renderer.session != session) {
            return Err(MediaError::RendererChanged);
        }
        let Some(entry) = self.generations.get(&generation) else {
            return Err(MediaError::NotPrepared);
        };
        if entry.state != GenerationState::Prepared {
            return Err(MediaError::NotPrepared);
        }
        if frames.len() > MAX_GRANTS_PER_GENERATION {
            return Err(MediaError::TooMany);
        }
        let mut unique = HashMap::new();
        for reference in frames {
            if let Some(previous) = unique.insert(reference.sha256, reference)
                && previous.size_bytes != reference.size_bytes
            {
                return Err(MediaError::ConflictingContent);
            }
        }
        for digest in unique.keys() {
            let dual_claimed = self
                .grants
                .values()
                .any(|grant| grant.session == session && grant.generation == generation && grant.sha256 == *digest);
            if dual_claimed {
                return Err(MediaError::ConflictingContent);
            }
        }
        let random = SystemRandom::new();
        let mut minted = HashMap::new();
        let mut seen = HashSet::new();
        for reference in unique.values() {
            let token = loop {
                let mut bytes = [0u8; TOKEN_BYTES];
                random.fill(&mut bytes).map_err(|_| MediaError::Random)?;
                let candidate = MediaCapability(bytes.iter().map(|byte| format!("{byte:02x}")).collect());
                if !self.grants.contains_key(&candidate) && seen.insert(candidate.clone()) {
                    break candidate;
                }
            };
            minted.insert(reference.sha256, token.clone());
            let entry = self.generations.get_mut(&generation).expect("generation prepared above");
            entry.tokens.push(token.clone());
            self.grants.insert(
                token,
                MediaGrant {
                    session,
                    generation,
                    sha256: reference.sha256,
                    size_bytes: reference.size_bytes,
                    mime_type: "text/html".to_owned(),
                    kind: MediaGrantKind::Frame,
                    state: GenerationState::Prepared,
                    expires_at_ms: Some(now_ms.saturating_add(PREPARED_LIFETIME_MS)),
                },
            );
        }
        Ok(minted)
    }

    /// Registers an activation's projection media map for its prepared
    /// generation. One variant names one digest; a conflict fails the
    /// activation rather than serving either.
    pub fn register_aliases(
        &mut self,
        session: uuid::Uuid,
        generation: u64,
        aliases: &[((uuid::Uuid, uuid::Uuid), Sha256Digest)],
    ) -> Result<(), MediaError> {
        if self.renderer.is_none_or(|renderer| renderer.session != session) {
            return Err(MediaError::RendererChanged);
        }
        let Some(entry) = self.generations.get_mut(&generation) else {
            return Err(MediaError::NotPrepared);
        };
        if entry.state != GenerationState::Prepared {
            return Err(MediaError::NotPrepared);
        }
        // Validate everything before inserting anything: a conflict fails
        // the activation without poisoning the generation.
        for (identity, digest) in aliases {
            if let Some(previous) = entry.aliases.get(identity)
                && previous != digest
            {
                return Err(MediaError::ConflictingContent);
            }
        }
        for (identity, digest) in aliases {
            entry.aliases.insert(*identity, *digest);
        }
        Ok(())
    }

    pub fn activate(&mut self, session: uuid::Uuid, generation: u64, now_ms: i64) -> Result<(), MediaError> {
        if self.renderer.is_none_or(|renderer| renderer.session != session) {
            return Err(MediaError::RendererChanged);
        }
        self.expire(now_ms);
        if self.generations.get(&generation).is_none_or(|entry| entry.state != GenerationState::Prepared) {
            return Err(MediaError::NotPrepared);
        }
        let retire: Vec<u64> = self
            .generations
            .iter()
            .filter_map(|(id, entry)| (entry.state == GenerationState::Draining).then_some(*id))
            .collect();
        for id in retire {
            self.retire(id);
        }
        for (id, entry) in &mut self.generations {
            if *id == generation {
                entry.state = GenerationState::Active;
                entry.expires_at_ms = None;
            } else if entry.state == GenerationState::Active {
                entry.state = GenerationState::Draining;
                entry.expires_at_ms = Some(now_ms.saturating_add(DRAIN_LIFETIME_MS));
            }
            for token in &entry.tokens {
                if let Some(grant) = self.grants.get_mut(token) {
                    grant.state = entry.state;
                    grant.expires_at_ms = entry.expires_at_ms;
                }
            }
        }
        Ok(())
    }

    /// An activation without media: the active generation starts draining
    /// exactly as it would for a media activation.
    pub fn drain_active(&mut self, now_ms: i64) {
        self.expire(now_ms);
        for entry in self.generations.values_mut() {
            if entry.state == GenerationState::Active {
                entry.state = GenerationState::Draining;
                entry.expires_at_ms = Some(now_ms.saturating_add(DRAIN_LIFETIME_MS));
                for token in &entry.tokens {
                    if let Some(grant) = self.grants.get_mut(token) {
                        grant.state = entry.state;
                        grant.expires_at_ms = entry.expires_at_ms;
                    }
                }
            }
        }
    }

    pub fn retire(&mut self, generation: u64) {
        if let Some(entry) = self.generations.remove(&generation) {
            for token in entry.tokens {
                self.grants.remove(&token);
            }
        }
    }

    pub fn expire(&mut self, now_ms: i64) {
        let expired: Vec<u64> = self
            .generations
            .iter()
            .filter_map(|(id, entry)| entry.expires_at_ms.is_some_and(|expires| now_ms >= expires).then_some(*id))
            .collect();
        for generation in expired {
            self.retire(generation);
        }
    }

    /// Unknown or malformed tokens get the same answer. A digest, even when
    /// known to the player, can never be used as a read grant. A frame
    /// capability never resolves here; the usage pinned at mint time
    /// decides which scheme serves a grant.
    pub fn resolve(&self, session: uuid::Uuid, token: &str, now_ms: i64) -> Option<&MediaGrant> {
        self.resolve_kind(session, token, now_ms, MediaGrantKind::Media)
    }

    /// Resolves a frame capability for the widget scheme. Media
    /// capabilities never resolve here.
    pub fn resolve_frame(&self, session: uuid::Uuid, token: &str, now_ms: i64) -> Option<&MediaGrant> {
        self.resolve_kind(session, token, now_ms, MediaGrantKind::Frame)
    }

    fn resolve_kind(&self, session: uuid::Uuid, token: &str, now_ms: i64, kind: MediaGrantKind) -> Option<&MediaGrant> {
        if self.renderer.is_none_or(|renderer| renderer.session != session) {
            return None;
        }
        let token = MediaCapability::parse(token)?;
        self.grants.get(&token).filter(|grant| {
            grant.session == session && grant.kind == kind && grant.expires_at_ms.is_none_or(|expires| now_ms < expires)
        })
    }

    /// Resolves a plugin media load (`tcmedia://variant/…`) through the
    /// live generations' alias maps to the grant for its digest. Unknown
    /// variants, retired generations, and expired grants all answer
    /// identically: nothing.
    pub fn resolve_variant(
        &self,
        session: uuid::Uuid,
        asset_id: uuid::Uuid,
        variant_id: uuid::Uuid,
        now_ms: i64,
    ) -> Option<MediaGrant> {
        if self.renderer.is_none_or(|renderer| renderer.session != session) {
            return None;
        }
        for (generation, entry) in &self.generations {
            let Some(digest) = entry.aliases.get(&(asset_id, variant_id)) else {
                continue;
            };
            let live = self.grants.values().find(|grant| {
                grant.session == session
                    && grant.generation == *generation
                    && grant.kind == MediaGrantKind::Media
                    && grant.sha256 == *digest
                    && grant.expires_at_ms.is_none_or(|expires| now_ms < expires)
            });
            if let Some(grant) = live {
                return Some(grant.clone());
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use player_types::bounded::SafeText;

    fn content(object: &[u8]) -> VerifiedContentRef {
        VerifiedContentRef {
            sha256: Sha256Digest::of(object),
            size_bytes: object.len() as u64,
            mime_type: SafeText::new("image/png").expect("test fixture"),
            stream: None,
        }
    }

    fn frame(document: &[u8]) -> VerifiedFrameRef {
        VerifiedFrameRef {
            package_id: SafeText::new("acme.athletics").expect("test fixture"),
            package_digest: Sha256Digest::of(b"package"),
            sha256: Sha256Digest::of(document),
            size_bytes: document.len() as u64,
        }
    }

    fn bound() -> (MediaRegistry, uuid::Uuid) {
        let mut registry = MediaRegistry::new();
        let session = uuid::Uuid::new_v4();
        registry.bind_renderer(RendererInstance { session });
        (registry, session)
    }

    #[test]
    fn grants_are_opaque_random_and_generation_scoped() {
        let (mut registry, session) = bound();
        let minted = registry.prepare(session, 1, 0, &[content(b"a"), content(b"b")]).expect("prepare");
        assert_eq!(minted.len(), 2);
        for capability in minted.values() {
            assert!(capability.uri().starts_with("tcmedia://cap/"));
            assert!(!capability.as_str().contains("tcmedia"));
        }
        let tokens: Vec<_> = minted.values().map(MediaCapability::as_str).collect();
        assert_ne!(tokens[0], tokens[1]);
        // A digest is never a grant, even for a prepared object.
        let digest = Sha256Digest::of(b"a");
        assert!(registry.resolve(session, &digest.to_string(), 0).is_none());
        // Unknown and malformed tokens are indistinguishable.
        assert!(registry.resolve(session, &"0".repeat(64), 0).is_none());
        assert!(registry.resolve(session, "nope", 0).is_none());
        // The previous renderer session cannot use this one's grants.
        assert!(registry.resolve(uuid::Uuid::new_v4(), tokens[0], 0).is_none());
    }

    #[test]
    fn generations_drain_then_retire() {
        let (mut registry, session) = bound();
        let first = registry.prepare(session, 1, 0, &[content(b"a")]).expect("prepare");
        let token = first.values().next().expect("test fixture").as_str().to_owned();
        registry.activate(session, 1, 1_000).expect("activate");
        assert!(registry.resolve(session, &token, 2_000).is_some());
        registry.prepare(session, 2, 3_000, &[content(b"b")]).expect("prepare");
        registry.activate(session, 2, 4_000).expect("activate");
        // Generation 1 drains for 30 seconds, then retires.
        assert!(registry.resolve(session, &token, 5_000).is_some());
        assert!(registry.resolve(session, &token, 4_000 + DRAIN_LIFETIME_MS + 1).is_none());
        // Prepared generations expire after ten minutes without activation.
        let second = registry.prepare(session, 3, 0, &[content(b"c")]).expect("prepare");
        let pending = second.values().next().expect("test fixture").as_str().to_owned();
        assert!(registry.resolve(session, &pending, PREPARED_LIFETIME_MS - 1).is_some());
        assert!(registry.resolve(session, &pending, PREPARED_LIFETIME_MS + 1).is_none());
    }

    #[test]
    fn frame_grants_resolve_only_as_frames_and_share_the_lifecycle() {
        let (mut registry, session) = bound();
        registry.prepare(session, 1, 0, &[content(b"a")]).expect("prepare");
        let minted = registry.prepare_frames(session, 1, 0, &[frame(b"frame")]).expect("prepare frames");
        let token = minted.values().next().expect("test fixture").as_str().to_owned();
        // Usage is pinned at mint time: a frame capability never
        // resolves as media, and a media capability never as a frame.
        assert!(registry.resolve(session, &token, 1_000).is_none());
        let media = registry.prepare(session, 2, 0, &[content(b"b")]).expect("prepare");
        let media_token = media.values().next().expect("test fixture").as_str().to_owned();
        assert!(registry.resolve_frame(session, &media_token, 1_000).is_none());
        let grant = registry.resolve_frame(session, &token, 1_000).expect("resolves as frame");
        assert_eq!(grant.kind, MediaGrantKind::Frame);
        assert_eq!(grant.mime_type, "text/html");
        assert_eq!(grant.generation, 1);
        // Frames drain and retire with their generation.
        registry.activate(session, 1, 1_000).expect("activate");
        registry.activate(session, 2, 2_000).expect("activate");
        assert!(registry.resolve_frame(session, &token, 3_000).is_some());
        assert!(registry.resolve_frame(session, &token, 2_000 + DRAIN_LIFETIME_MS + 1).is_none());
    }

    #[test]
    fn dual_claimed_digests_and_unprepared_frames_fail() {
        let (mut registry, session) = bound();
        // A digest claimed as both media and a frame fails the
        // activation rather than serving either.
        registry.prepare(session, 1, 0, &[content(b"same")]).expect("prepare");
        assert_eq!(registry.prepare_frames(session, 1, 0, &[frame(b"same")]), Err(MediaError::ConflictingContent));
        // Frames attach to the generation `prepare` opened: no
        // generation, a live generation, or the wrong session fails.
        assert_eq!(registry.prepare_frames(session, 9, 0, &[frame(b"frame")]), Err(MediaError::NotPrepared));
        registry.activate(session, 1, 1_000).expect("activate");
        assert_eq!(registry.prepare_frames(session, 1, 2_000, &[frame(b"frame")]), Err(MediaError::NotPrepared));
        assert_eq!(
            registry.prepare_frames(uuid::Uuid::new_v4(), 1, 2_000, &[frame(b"frame")]),
            Err(MediaError::RendererChanged)
        );
        // Same digest, two sizes is a conflict like media.
        let (mut registry, session) = bound();
        registry.prepare(session, 1, 0, &[content(b"a")]).expect("prepare");
        let mut second = frame(b"frame");
        second.size_bytes += 1;
        assert_eq!(
            registry.prepare_frames(session, 1, 0, &[frame(b"frame"), second]),
            Err(MediaError::ConflictingContent)
        );
    }

    #[test]
    fn a_new_renderer_kills_every_grant() {
        let (mut registry, session) = bound();
        let minted = registry.prepare(session, 1, 0, &[content(b"a")]).expect("prepare");
        let token = minted.values().next().expect("test fixture").as_str().to_owned();
        registry.activate(session, 1, 1_000).expect("activate");
        registry.bind_renderer(RendererInstance { session: uuid::Uuid::new_v4() });
        assert!(registry.resolve(session, &token, 2_000).is_none());
    }

    #[test]
    fn conflicting_claims_and_double_prepare_fail() {
        let (mut registry, session) = bound();
        let mut second = content(b"a");
        second.size_bytes += 1;
        assert_eq!(registry.prepare(session, 1, 0, &[content(b"a"), second]), Err(MediaError::ConflictingContent));
        registry.prepare(session, 1, 0, &[content(b"a")]).expect("prepare");
        assert_eq!(registry.prepare(session, 1, 0, &[content(b"a")]), Err(MediaError::GenerationExists));
        assert_eq!(registry.activate(session, 9, 0), Err(MediaError::NotPrepared));
        assert_eq!(registry.prepare(uuid::Uuid::new_v4(), 2, 0, &[content(b"a")]), Err(MediaError::RendererChanged));
    }

    #[test]
    fn variant_loads_follow_generation_grants() {
        let (mut registry, session) = bound();
        let reference = content(b"a");
        registry.prepare(session, 1, 0, std::slice::from_ref(&reference)).expect("prepare");
        let asset = uuid::Uuid::new_v4();
        let variant = uuid::Uuid::new_v4();
        registry.register_aliases(session, 1, &[((asset, variant), reference.sha256)]).expect("aliases");
        registry.activate(session, 1, 1_000).expect("activate");
        let grant = registry.resolve_variant(session, asset, variant, 2_000).expect("resolves");
        assert_eq!(grant.sha256, reference.sha256);
        assert_eq!(grant.generation, 1);
        assert!(registry.resolve_variant(session, asset, uuid::Uuid::new_v4(), 2_000).is_none());
        assert!(registry.resolve_variant(uuid::Uuid::new_v4(), asset, variant, 2_000).is_none());
        // Re-activation drains the old generation: in-flight loads still
        // serve until the drain lapses, then stop.
        registry.prepare(session, 2, 3_000, &[content(b"b")]).expect("prepare");
        registry.activate(session, 2, 4_000).expect("activate");
        assert!(registry.resolve_variant(session, asset, variant, 5_000).is_some());
        assert!(registry.resolve_variant(session, asset, variant, 40_000).is_none());
    }

    #[test]
    fn conflicting_aliases_fail_the_activation() {
        let (mut registry, session) = bound();
        registry.prepare(session, 1, 0, &[content(b"a")]).expect("prepare");
        let identity = (uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        let first = Sha256Digest::of(b"a");
        let second = Sha256Digest::of(b"b");
        registry.register_aliases(session, 1, &[(identity, first)]).expect("aliases");
        assert_eq!(registry.register_aliases(session, 1, &[(identity, second)]), Err(MediaError::ConflictingContent));
        assert_eq!(
            registry.register_aliases(session, 1, &[(identity, first)]),
            Ok(()),
            "repeating the same alias is idempotent"
        );
        assert_eq!(registry.register_aliases(session, 9, &[(identity, first)]), Err(MediaError::NotPrepared));
    }
}
