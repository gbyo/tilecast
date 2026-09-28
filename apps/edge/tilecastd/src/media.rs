//! Daemon-owned presentation media capabilities.
//!
//! A CAS digest identifies bytes; it never authorizes a renderer read. The
//! media service resolves only these random, renderer-instance-bound grants.
//! Generations move through prepared, active and draining before retirement.

use std::collections::{HashMap, HashSet};
use std::fmt;

use edge_protocol::Sha256Digest;
use edge_protocol::ids::SessionId;
use edge_protocol::ipc::presentation::ContentRef;
use ring::rand::{SecureRandom as _, SystemRandom};

const TOKEN_BYTES: usize = 32;
const MAX_GRANTS_PER_GENERATION: usize = 1024;
const PREPARED_LIFETIME_MS: i64 = 10 * 60 * 1_000;
const DRAIN_LIFETIME_MS: i64 = 30 * 1_000;

#[derive(Clone, PartialEq, Eq, Hash)]
pub struct MediaCapability(String);

impl fmt::Debug for MediaCapability {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("MediaCapability([redacted])")
    }
}

impl MediaCapability {
    pub fn uri(&self) -> String {
        format!("tcmedia://cap/{}", self.0)
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadMode {
    Seekable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaGrant {
    pub renderer_session: SessionId,
    pub generation: u64,
    pub sha256: Sha256Digest,
    pub size_bytes: u64,
    pub mime_type: String,
    pub read_mode: ReadMode,
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

struct Generation {
    state: GenerationState,
    tokens: Vec<MediaCapability>,
    expires_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RendererInstance {
    pub session: SessionId,
    pub uid: u32,
    pub pid: i32,
    pub start_ticks: u64,
}

/// Grants are process-local. A daemon restart never revives a capability;
/// the renderer must reconnect and receive a fresh activation.
pub struct MediaRegistry {
    renderer: Option<RendererInstance>,
    generations: HashMap<u64, Generation>,
    grants: HashMap<MediaCapability, MediaGrant>,
}

impl fmt::Debug for MediaRegistry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MediaRegistry")
            .field("renderer", &self.renderer)
            .field("generations", &self.generations.len())
            .field("grants", &self.grants.len())
            .finish()
    }
}

impl Default for MediaRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl MediaRegistry {
    pub fn new() -> Self {
        Self { renderer: None, generations: HashMap::new(), grants: HashMap::new() }
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

    pub fn unbind_renderer(&mut self, session: SessionId) {
        if self.renderer.is_some_and(|renderer| renderer.session == session) {
            self.generations.clear();
            self.grants.clear();
            self.renderer = None;
        }
    }

    /// Creates one opaque capability per distinct verified object. The
    /// caller still has to establish CAS verification and pins before sending
    /// the corresponding presentation to WPE.
    pub fn prepare(
        &mut self,
        session: SessionId,
        generation: u64,
        now_ms: i64,
        content: &[ContentRef],
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
                    renderer_session: session,
                    generation,
                    sha256: reference.sha256,
                    size_bytes: reference.size_bytes,
                    mime_type: reference.mime_type.as_str().to_owned(),
                    read_mode: ReadMode::Seekable,
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
                expires_at_ms: Some(now_ms.saturating_add(PREPARED_LIFETIME_MS)),
            },
        );
        Ok(minted)
    }

    pub fn activate(&mut self, session: SessionId, generation: u64, now_ms: i64) -> Result<(), MediaError> {
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
    /// known to the daemon, can never be used as a read grant.
    pub fn resolve(&self, session: SessionId, token: &str, now_ms: i64) -> Option<&MediaGrant> {
        if self.renderer.is_none_or(|renderer| renderer.session != session) {
            return None;
        }
        let token = MediaCapability::parse(token)?;
        self.grants.get(&token).filter(|grant| {
            grant.renderer_session == session && grant.expires_at_ms.is_none_or(|expires| now_ms < expires)
        })
    }
}

#[cfg(test)]
mod tests {
    use edge_protocol::bounded::SafeText;

    use super::*;

    fn content(value: &str) -> ContentRef {
        ContentRef {
            sha256: Sha256Digest::parse(value).unwrap(),
            size_bytes: 42,
            mime_type: SafeText::new("image/png").unwrap(),
        }
    }

    fn renderer(session: SessionId) -> RendererInstance {
        RendererInstance { session, uid: 1000, pid: 1234, start_ticks: 1 }
    }

    #[test]
    fn tokens_are_random_instance_bound_and_not_digests() {
        let session = SessionId::new_random();
        let other = SessionId::new_random();
        let reference = content(&"a".repeat(64));
        let mut registry = MediaRegistry::new();
        registry.bind_renderer(renderer(session));
        let first = registry.prepare(session, 1, 0, std::slice::from_ref(&reference)).unwrap();
        let token = &first[&reference.sha256];
        assert!(token.uri().starts_with("tcmedia://cap/"));
        assert_ne!(token.as_str(), reference.sha256.to_hex());
        assert!(registry.resolve(session, &reference.sha256.to_hex(), 0).is_none());
        assert!(registry.resolve(other, token.as_str(), 0).is_none());
        assert_eq!(registry.resolve(session, token.as_str(), 0).unwrap().state, GenerationState::Prepared);
        registry.bind_renderer(renderer(other));
        assert!(registry.resolve(session, token.as_str(), 0).is_none());
        let second = registry.prepare(other, 1, 0, &[reference]).unwrap();
        assert_ne!(token, second.values().next().unwrap());
    }

    #[test]
    fn prepared_active_draining_and_retired_lifetime() {
        let session = SessionId::new_random();
        let mut registry = MediaRegistry::new();
        registry.bind_renderer(renderer(session));
        let one = registry.prepare(session, 1, 0, &[content(&"a".repeat(64))]).unwrap();
        let one_token = one.values().next().unwrap().as_str();
        assert_eq!(registry.resolve(session, one_token, 0).unwrap().state, GenerationState::Prepared);
        registry.activate(session, 1, 0).unwrap();
        let two = registry.prepare(session, 2, 1, &[content(&"b".repeat(64))]).unwrap();
        registry.activate(session, 2, 1).unwrap();
        assert_eq!(registry.resolve(session, one_token, 1).unwrap().state, GenerationState::Draining);
        assert!(registry.resolve(session, one_token, DRAIN_LIFETIME_MS + 1).is_none());
        let three = registry.prepare(session, 3, 2, &[content(&"c".repeat(64))]).unwrap();
        registry.activate(session, 3, 2).unwrap();
        assert!(registry.resolve(session, one_token, 2).is_none());
        assert_eq!(
            registry.resolve(session, two.values().next().unwrap().as_str(), 2).unwrap().state,
            GenerationState::Draining
        );
        registry.unbind_renderer(session);
        assert!(registry.resolve(session, three.values().next().unwrap().as_str(), 2).is_none());
    }

    #[test]
    fn conflict_is_atomic_and_failed_activation_preserves_current() {
        let session = SessionId::new_random();
        let mut registry = MediaRegistry::new();
        registry.bind_renderer(renderer(session));
        let first = content(&"a".repeat(64));
        let mut conflicting = first.clone();
        conflicting.size_bytes = 43;
        assert_eq!(registry.prepare(session, 1, 0, &[first.clone(), conflicting]), Err(MediaError::ConflictingContent));
        assert_eq!(registry.activate(session, 1, 0), Err(MediaError::NotPrepared));
        let issued = registry.prepare(session, 1, 0, &[first]).unwrap();
        registry.activate(session, 1, 0).unwrap();
        assert_eq!(registry.activate(session, 2, 0), Err(MediaError::NotPrepared));
        assert_eq!(
            registry.resolve(session, issued.values().next().unwrap().as_str(), 0).unwrap().state,
            GenerationState::Active
        );
    }

    #[test]
    fn abandoned_prepared_grants_expire_before_activation() {
        let session = SessionId::new_random();
        let mut registry = MediaRegistry::new();
        registry.bind_renderer(renderer(session));
        let issued = registry.prepare(session, 1, 100, &[content(&"a".repeat(64))]).unwrap();
        let token = issued.values().next().unwrap().as_str();
        assert!(registry.resolve(session, token, 100 + PREPARED_LIFETIME_MS - 1).is_some());
        assert!(registry.resolve(session, token, 100 + PREPARED_LIFETIME_MS).is_none());
        assert_eq!(registry.activate(session, 1, 100 + PREPARED_LIFETIME_MS), Err(MediaError::NotPrepared));
        registry.expire(100 + PREPARED_LIFETIME_MS);
        assert!(registry.generations.is_empty());
    }
}
