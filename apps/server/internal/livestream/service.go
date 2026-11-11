package livestream

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"
)

const (
	LeaseDuration = 15 * time.Second
	// MaxFrameBytes bounds one MJPEG frame (TCLS version 1).
	MaxFrameBytes = 100 * 1024
	// MaxJPEGWidth and MaxJPEGHeight bound every MJPEG profile.
	MaxJPEGWidth  = 960
	MaxJPEGHeight = 540
	frameHeader   = 33
	// MaxSocketMessageBytes is the largest Player WebSocket message: one
	// TCLS version 2 packet, which is larger than any TCLS version 1 frame.
	MaxSocketMessageBytes = MaxChunkPacketBytes + 1024

	// A healthy Watch Live stream should deliver frames many times per second.
	// These deliberately generous bounds detect an actual stall without
	// treating normal capture jitter as a failure.
	FrameStaleAfter    = 5 * time.Second
	FrameNudgeCooldown = 3 * time.Second
)

var (
	ErrNotFound     = errors.New("live stream session was not found")
	ErrReplaced     = errors.New("live stream session was replaced")
	ErrInvalidFrame = errors.New("live stream frame is invalid")
	// ErrWrongTransport: the relay endpoint does not carry the selected profile.
	ErrWrongTransport = errors.New("live stream session uses another transport")
)

var frameMagic = [4]byte{'T', 'C', 'L', 'S'}

type Notifier interface {
	Notify(screenID uuid.UUID, message map[string]any) bool
}

// Session is the lease both Studio and the Player read. Until the Player
// first reconciles, Profile is empty and the limits are the legacy profile.
type Session struct {
	ID                  uuid.UUID  `json:"id"`
	ScreenID            uuid.UUID  `json:"screenId"`
	Active              bool       `json:"active"`
	ExpiresAt           time.Time  `json:"expiresAt"`
	Profile             string     `json:"profile,omitempty"`
	Transport           Transport  `json:"transport"`
	Codec               string     `json:"codec,omitempty"`
	ProfileGeneration   int        `json:"profileGeneration"`
	FrameIntervalMillis int        `json:"frameIntervalMillis"`
	MaxWidth            int        `json:"maxWidth"`
	MaxHeight           int        `json:"maxHeight"`
	MaxFrameBytes       int        `json:"maxFrameBytes"`
	TargetBitrate       int        `json:"targetBitrate,omitempty"`
	LastFrameAt         *time.Time `json:"lastFrameAt,omitempty"`
	FrameSequence       uint64     `json:"frameSequence"`
}

func (s *Session) applyProfile(profile Profile) {
	s.Profile = profile.ID
	s.Transport = profile.Transport
	s.FrameIntervalMillis = int(profile.FrameInterval.Milliseconds())
	s.MaxWidth, s.MaxHeight = profile.MaxWidth, profile.MaxHeight
	s.TargetBitrate = profile.TargetBitrate
	s.Codec = ""
	s.MaxFrameBytes = MaxFrameBytes
	if profile.Transport == TransportH264 {
		s.Codec = H264Codec
		s.MaxFrameBytes = MaxAccessUnitBytes
	}
}

// inactiveSession is what a Player or Studio sees without a lease.
func inactiveSession(screenID uuid.UUID) Session {
	session := Session{ScreenID: screenID}
	session.applyProfile(legacyProfile)
	session.Profile = ""
	return session
}

type Frame struct {
	CapturedAt time.Time
	Width      int
	Height     int
	JPEG       []byte
}

type activeSession struct {
	Session
	startedAt   time.Time
	lastNudgeAt time.Time
	// viewerProfiles is what the Studio that started the lease can consume;
	// nil means an older Studio (MJPEG only).
	viewerProfiles []string
	// profileRank is the selected profile's preference rank, or -1 before
	// the Player first reconciled. It never decreases: no upgrades.
	profileRank int
	done        chan struct{}
	// generation closes when the selected profile changes, ending every
	// relay request so Studio reconnects with the new transport.
	generation  chan struct{}
	subscribers map[chan Frame]struct{}
	viewers     map[*viewerQueue]struct{}
	gop         gopState
}

func (a *activeSession) profile() Profile {
	if a.profileRank < 0 {
		return legacyProfile
	}
	return Profiles[a.profileRank]
}

type Service struct {
	mu       sync.Mutex
	sessions map[uuid.UUID]*activeSession
	notifier Notifier
	now      func() time.Time
}

func NewService(notifier Notifier) *Service {
	return &Service{
		sessions: make(map[uuid.UUID]*activeSession),
		notifier: notifier,
		now:      time.Now,
	}
}

// Start replaces any lease for the screen. viewerProfiles lists the
// profiles the requesting Studio can consume; nil means MJPEG only.
func (s *Service) Start(screenID uuid.UUID, viewerProfiles []string) Session {
	now := s.now().UTC()
	s.mu.Lock()
	if previous := s.sessions[screenID]; previous != nil {
		close(previous.done)
	}
	base := inactiveSession(screenID)
	base.ID = uuid.New()
	base.Active = true
	base.ExpiresAt = now.Add(LeaseDuration)
	active := &activeSession{
		Session:        base,
		startedAt:      now,
		viewerProfiles: NormalizeProfiles(viewerProfiles),
		profileRank:    -1,
		done:           make(chan struct{}),
		generation:     make(chan struct{}),
		subscribers:    make(map[chan Frame]struct{}),
		viewers:        make(map[*viewerQueue]struct{}),
	}
	active.gop.reset()
	s.sessions[screenID] = active
	result := active.Session
	s.mu.Unlock()
	s.notify(screenID)
	return result
}

// SelectProfile negotiates the lease with the Player's current profile
// list (nil: a Player that said nothing, which gets the legacy profile). The
// first call selects the best profile both sides support. A later call
// keeps it while the Player still lists it and otherwise moves down: a
// session never upgrades. A change bumps ProfileGeneration, drops buffered
// H.264, and ends every relay request.
func (s *Service) SelectProfile(screenID uuid.UUID, playerProfiles []string) Session {
	s.mu.Lock()
	active := s.activeLocked(screenID)
	if active == nil {
		s.mu.Unlock()
		return inactiveSession(screenID)
	}
	ceiling := active.profileRank
	if ceiling < 0 {
		ceiling = 0
	}
	profile, rank := selectProfile(active.viewerProfiles, NormalizeProfiles(playerProfiles), ceiling)
	changed := rank != active.profileRank
	if changed {
		first := active.profileRank < 0
		active.profileRank = rank
		active.applyProfile(profile)
		if !first {
			active.ProfileGeneration++
			close(active.generation)
			active.generation = make(chan struct{})
			active.subscribers = make(map[chan Frame]struct{})
			active.viewers = make(map[*viewerQueue]struct{})
		}
		active.gop.reset()
	}
	result := active.Session
	s.mu.Unlock()
	return result
}

func (s *Service) Renew(screenID, sessionID uuid.UUID) (Session, error) {
	now := s.now().UTC()
	s.mu.Lock()
	active := s.activeLocked(screenID)
	if active == nil {
		s.mu.Unlock()
		return Session{}, ErrNotFound
	}
	if active.ID != sessionID {
		s.mu.Unlock()
		return Session{}, ErrReplaced
	}
	active.ExpiresAt = now.Add(LeaseDuration)

	// A renewal doubles as a low-cost health observation. Healthy renewals do
	// not wake the Player. A stream that has never produced a frame or whose
	// last accepted frame is old gets a rate-limited reconcile nudge.
	staleSince := active.startedAt
	if active.LastFrameAt != nil {
		staleSince = *active.LastFrameAt
	}
	shouldNudge := now.Sub(staleSince) >= FrameStaleAfter &&
		(active.lastNudgeAt.IsZero() || now.Sub(active.lastNudgeAt) >= FrameNudgeCooldown)
	if shouldNudge {
		active.lastNudgeAt = now
	}
	result := active.Session
	s.mu.Unlock()
	if shouldNudge {
		s.notify(screenID)
	}
	return result, nil
}

func (s *Service) End(screenID, sessionID uuid.UUID) error {
	s.mu.Lock()
	active := s.activeLocked(screenID)
	if active == nil {
		s.mu.Unlock()
		return ErrNotFound
	}
	if active.ID != sessionID {
		s.mu.Unlock()
		return ErrReplaced
	}
	delete(s.sessions, screenID)
	close(active.done)
	s.mu.Unlock()
	s.notify(screenID)
	return nil
}

func (s *Service) Current(screenID uuid.UUID) Session {
	s.mu.Lock()
	active := s.activeLocked(screenID)
	var result Session
	if active != nil {
		result = active.Session
	} else {
		result = inactiveSession(screenID)
	}
	s.mu.Unlock()
	return result
}

func (s *Service) Publish(screenID, sessionID uuid.UUID, frame Frame) error {
	if err := validateFrame(frame); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	active := s.activeLocked(screenID)
	if active == nil || active.ID != sessionID {
		return ErrNotFound
	}
	// A JPEG is accepted only while the session says MJPEG: data encoded
	// for one profile never passes while the session claims another.
	if profile := active.profile(); profile.Transport != TransportMJPEG ||
		frame.Width > profile.MaxWidth || frame.Height > profile.MaxHeight {
		return fmt.Errorf("%w: frame does not match the selected profile", ErrInvalidFrame)
	}
	frame.JPEG = bytes.Clone(frame.JPEG)
	acceptedAt := s.now().UTC()
	active.LastFrameAt = &acceptedAt
	active.FrameSequence++
	active.lastNudgeAt = time.Time{}
	for subscriber := range active.subscribers {
		select {
		case subscriber <- frame:
		default:
			select {
			case <-subscriber:
			default:
			}
			select {
			case subscriber <- frame:
			default:
			}
		}
	}
	return nil
}

// MJPEGSubscription is one Studio request's latest-frame view.
type MJPEGSubscription struct {
	Frames <-chan Frame
	// Done closes when the session ends; Changed when its profile changes.
	Done, Changed <-chan struct{}
}

func (s *Service) Subscribe(screenID, sessionID uuid.UUID) (MJPEGSubscription, func(), error) {
	s.mu.Lock()
	active := s.activeLocked(screenID)
	if active == nil || active.ID != sessionID {
		s.mu.Unlock()
		return MJPEGSubscription{}, nil, ErrNotFound
	}
	if active.profile().Transport != TransportMJPEG {
		s.mu.Unlock()
		return MJPEGSubscription{}, nil, ErrWrongTransport
	}
	frames := make(chan Frame, 1)
	active.subscribers[frames] = struct{}{}
	subscription := MJPEGSubscription{Frames: frames, Done: active.done, Changed: active.generation}
	s.mu.Unlock()

	var once sync.Once
	cancel := func() {
		once.Do(func() {
			s.mu.Lock()
			if current := s.sessions[screenID]; current != nil && current.ID == sessionID {
				delete(current.subscribers, frames)
			}
			s.mu.Unlock()
		})
	}
	return subscription, cancel, nil
}

// PublishChunk accepts one validated H.264 access unit for the active
// session's selected profile and fans it out to connected viewers.
func (s *Service) PublishChunk(screenID uuid.UUID, chunk Chunk) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	active := s.activeLocked(screenID)
	if active == nil || active.ID != chunk.SessionID {
		return ErrNotFound
	}
	profile := active.profile()
	if profile.Transport != TransportH264 || profile.Code != chunk.ProfileCode {
		return fmt.Errorf("%w: chunk does not match the selected profile", ErrInvalidFrame)
	}
	resync, err := active.gop.accept(chunk)
	if resync {
		for viewer := range active.viewers {
			viewer.resync()
		}
	}
	if err != nil {
		return err
	}
	chunk.Packet = bytes.Clone(chunk.Packet)
	acceptedAt := s.now().UTC()
	active.LastFrameAt = &acceptedAt
	active.FrameSequence++
	active.lastNudgeAt = time.Time{}
	for viewer := range active.viewers {
		viewer.push(chunk)
	}
	return nil
}

// H264Subscription is one Studio request's bounded view of an H.264 stream.
type H264Subscription struct {
	service  *Service
	screenID uuid.UUID
	queue    *viewerQueue
	// Ready signals that Take may return chunks.
	Ready <-chan struct{}
	// Done closes when the session ends; Changed when its profile changes.
	Done, Changed <-chan struct{}
}

// Take returns and clears the queued chunks. The first chunk after a
// subscription or a resync is always a keyframe.
func (h *H264Subscription) Take() []Chunk {
	h.service.mu.Lock()
	defer h.service.mu.Unlock()
	return h.queue.take()
}

// SubscribeH264 starts a viewer at the buffered GOP's IDR, or at the next
// keyframe when there is no joinable GOP.
func (s *Service) SubscribeH264(screenID, sessionID uuid.UUID) (*H264Subscription, func(), error) {
	s.mu.Lock()
	active := s.activeLocked(screenID)
	if active == nil || active.ID != sessionID {
		s.mu.Unlock()
		return nil, nil, ErrNotFound
	}
	if active.profile().Transport != TransportH264 {
		s.mu.Unlock()
		return nil, nil, ErrWrongTransport
	}
	queue := newViewerQueue(active.gop.joinable())
	active.viewers[queue] = struct{}{}
	subscription := &H264Subscription{
		service: s, screenID: screenID, queue: queue, Ready: queue.signal,
		Done: active.done, Changed: active.generation,
	}
	s.mu.Unlock()
	var once sync.Once
	cancel := func() {
		once.Do(func() {
			s.mu.Lock()
			if current := s.sessions[screenID]; current != nil && current.ID == sessionID {
				delete(current.viewers, queue)
			}
			queue.take()
			s.mu.Unlock()
		})
	}
	return subscription, cancel, nil
}

func (s *Service) activeLocked(screenID uuid.UUID) *activeSession {
	active := s.sessions[screenID]
	if active == nil {
		return nil
	}
	if !active.ExpiresAt.After(s.now()) {
		delete(s.sessions, screenID)
		close(active.done)
		return nil
	}
	return active
}

func (s *Service) notify(screenID uuid.UUID) {
	if s.notifier != nil {
		s.notifier.Notify(screenID, map[string]any{"type": "live_stream.session_changed"})
	}
}

func validateFrame(frame Frame) error {
	if frame.CapturedAt.IsZero() {
		return fmt.Errorf("%w: capture time is required", ErrInvalidFrame)
	}
	if frame.Width < 1 || frame.Width > MaxJPEGWidth || frame.Height < 1 || frame.Height > MaxJPEGHeight {
		return fmt.Errorf("%w: dimensions exceed %dx%d", ErrInvalidFrame, MaxJPEGWidth, MaxJPEGHeight)
	}
	if len(frame.JPEG) < 4 || len(frame.JPEG) > MaxFrameBytes {
		return fmt.Errorf("%w: JPEG must be between 4 and %d bytes", ErrInvalidFrame, MaxFrameBytes)
	}
	if frame.JPEG[0] != 0xff || frame.JPEG[1] != 0xd8 ||
		frame.JPEG[len(frame.JPEG)-2] != 0xff || frame.JPEG[len(frame.JPEG)-1] != 0xd9 {
		return fmt.Errorf("%w: payload is not a complete JPEG", ErrInvalidFrame)
	}
	return nil
}

// BinaryVersion reports the TCLS version of a Player binary message, or 0.
func BinaryVersion(payload []byte) byte {
	if len(payload) < 5 || !bytes.Equal(payload[:4], frameMagic[:]) {
		return 0
	}
	return payload[4]
}

// ParseBinaryFrame parses one TCLS version 1 (JPEG) frame. Version 1 is
// unchanged for compatibility with every MJPEG Player.
func ParseBinaryFrame(payload []byte) (uuid.UUID, Frame, error) {
	if len(payload) < frameHeader+4 {
		return uuid.Nil, Frame{}, fmt.Errorf("%w: binary payload is too short", ErrInvalidFrame)
	}
	if !bytes.Equal(payload[:4], frameMagic[:]) || payload[4] != 1 {
		return uuid.Nil, Frame{}, fmt.Errorf("%w: unsupported binary header", ErrInvalidFrame)
	}
	sessionID, err := uuid.FromBytes(payload[5:21])
	if err != nil {
		return uuid.Nil, Frame{}, fmt.Errorf("%w: invalid session id", ErrInvalidFrame)
	}
	capturedAtMillis := int64(binary.BigEndian.Uint64(payload[21:29]))
	frame := Frame{
		CapturedAt: time.UnixMilli(capturedAtMillis).UTC(),
		Width:      int(binary.BigEndian.Uint16(payload[29:31])),
		Height:     int(binary.BigEndian.Uint16(payload[31:33])),
		JPEG:       payload[33:],
	}
	if err := validateFrame(frame); err != nil {
		return uuid.Nil, Frame{}, err
	}
	return sessionID, frame, nil
}
