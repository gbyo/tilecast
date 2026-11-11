package livestream

import (
	"encoding/binary"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
)

type notificationRecorder struct {
	screenID uuid.UUID
	count    int
}

func (r *notificationRecorder) Notify(screenID uuid.UUID, _ map[string]any) bool {
	r.screenID = screenID
	r.count++
	return true
}

func TestSessionLifecycleAndLatestFrameDelivery(t *testing.T) {
	screenID := uuid.New()
	notifier := &notificationRecorder{}
	service := NewService(notifier)
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	service.now = func() time.Time { return now }

	session := service.Start(screenID, nil)
	if !session.Active || session.FrameIntervalMillis != 125 || notifier.count != 1 {
		t.Fatalf("unexpected session: %+v notifications=%d", session, notifier.count)
	}
	subscription, cancel, err := service.Subscribe(screenID, session.ID)
	frames, done := subscription.Frames, subscription.Done
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()

	first := Frame{CapturedAt: now, Width: 640, Height: 360, JPEG: []byte{0xff, 0xd8, 1, 0xff, 0xd9}}
	second := Frame{CapturedAt: now.Add(time.Millisecond), Width: 640, Height: 360, JPEG: []byte{0xff, 0xd8, 2, 0xff, 0xd9}}
	if err := service.Publish(screenID, session.ID, first); err != nil {
		t.Fatal(err)
	}
	if err := service.Publish(screenID, session.ID, second); err != nil {
		t.Fatal(err)
	}
	if received := <-frames; received.JPEG[2] != 2 {
		t.Fatalf("received stale frame: %v", received.JPEG)
	}
	current := service.Current(screenID)
	if current.FrameSequence != 2 || current.LastFrameAt == nil || !current.LastFrameAt.Equal(now) {
		t.Fatalf("frame health was not recorded: %+v", current)
	}

	now = now.Add(4 * time.Second)
	if _, err := service.Renew(screenID, session.ID); err != nil {
		t.Fatal(err)
	}
	if notifier.count != 1 {
		t.Fatalf("healthy renew notifications=%d", notifier.count)
	}
	now = now.Add(2 * time.Second)
	if _, err := service.Renew(screenID, session.ID); err != nil {
		t.Fatal(err)
	}
	if notifier.count != 2 {
		t.Fatalf("stalled renew should nudge once, notifications=%d", notifier.count)
	}
	now = now.Add(time.Second)
	if _, err := service.Renew(screenID, session.ID); err != nil {
		t.Fatal(err)
	}
	if notifier.count != 2 {
		t.Fatalf("stalled renew ignored cooldown, notifications=%d", notifier.count)
	}
	if err := service.End(screenID, session.ID); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	default:
		t.Fatal("subscriber was not stopped")
	}
	if service.Current(screenID).Active {
		t.Fatal("ended session is still active")
	}
}

func TestReplacedSessionIsDistinctFromExpiredSession(t *testing.T) {
	service := NewService(nil)
	now := time.Now().UTC()
	service.now = func() time.Time { return now }
	screenID := uuid.New()
	first := service.Start(screenID, nil)
	second := service.Start(screenID, nil)
	if first.ID == second.ID {
		t.Fatal("replacement reused a session id")
	}
	if _, err := service.Renew(screenID, first.ID); !errors.Is(err, ErrReplaced) {
		t.Fatalf("renew replaced session error=%v", err)
	}
	if err := service.End(screenID, first.ID); !errors.Is(err, ErrReplaced) {
		t.Fatalf("end replaced session error=%v", err)
	}
	now = now.Add(LeaseDuration + time.Second)
	if _, err := service.Renew(screenID, second.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("renew expired session error=%v", err)
	}
}

func TestParseBinaryFrame(t *testing.T) {
	sessionID := uuid.New()
	capturedAt := time.Date(2026, 7, 30, 12, 34, 56, 789000000, time.UTC)
	payload := make([]byte, frameHeader)
	copy(payload[:4], frameMagic[:])
	payload[4] = 1
	copy(payload[5:21], sessionID[:])
	binary.BigEndian.PutUint64(payload[21:29], uint64(capturedAt.UnixMilli()))
	binary.BigEndian.PutUint16(payload[29:31], 640)
	binary.BigEndian.PutUint16(payload[31:33], 360)
	payload = append(payload, 0xff, 0xd8, 1, 2, 0xff, 0xd9)

	parsedID, frame, err := ParseBinaryFrame(payload)
	if err != nil {
		t.Fatal(err)
	}
	if parsedID != sessionID || !frame.CapturedAt.Equal(capturedAt) || frame.Width != 640 || frame.Height != 360 {
		t.Fatalf("parsed %s %+v", parsedID, frame)
	}
}

func TestExpiredSessionStopsSubscribers(t *testing.T) {
	service := NewService(nil)
	now := time.Now().UTC()
	service.now = func() time.Time { return now }
	screenID := uuid.New()
	session := service.Start(screenID, nil)
	subscription, cancel, err := service.Subscribe(screenID, session.ID)
	done := subscription.Done
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()

	now = now.Add(LeaseDuration + time.Second)
	if service.Current(screenID).Active {
		t.Fatal("expired session is active")
	}
	select {
	case <-done:
	default:
		t.Fatal("expired session did not stop subscribers")
	}
}

func TestLegacyPlayersKeepTheirMJPEGBounds(t *testing.T) {
	screenID := uuid.New()
	service := NewService(nil)
	initial := service.Start(screenID, nil)
	if initial.MaxWidth != 640 || initial.MaxHeight != 640 || initial.FrameIntervalMillis != 125 || initial.Profile != "" || initial.Transport != TransportMJPEG {
		t.Fatalf("unexpected default profile: %+v", initial)
	}
	// An older Edge Player names the retired 540p10 query on every poll.
	upgraded := service.SelectProfile(screenID, LegacyEdgeProfiles(), nil)
	if upgraded.ID != initial.ID || upgraded.Profile != ProfileMJPEG540p10 || upgraded.MaxWidth != 960 || upgraded.MaxHeight != 960 || upgraded.FrameIntervalMillis != 100 || upgraded.MaxFrameBytes != 100*1024 || upgraded.Codec != "" {
		t.Fatalf("bad negotiated profile: %+v", upgraded)
	}
	jpeg := []byte{0xff, 0xd8, 1, 0xff, 0xd9}
	if err := service.Publish(screenID, initial.ID, Frame{CapturedAt: time.Now(), Width: 960, Height: 540, JPEG: jpeg}); err != nil {
		t.Fatalf("upgraded frame rejected: %v", err)
	}
	if err := service.Publish(screenID, initial.ID, Frame{CapturedAt: time.Now(), Width: 961, Height: 540, JPEG: jpeg}); !errors.Is(err, ErrInvalidFrame) {
		t.Fatalf("oversized frame accepted: %v", err)
	}
	other := uuid.New()
	legacy := service.Start(other, nil)
	if selected := service.SelectProfile(other, nil, nil); selected.Profile != ProfileMJPEG360p8 {
		t.Fatalf("a Player that says nothing got %+v", selected)
	}
	if err := service.Publish(other, legacy.ID, Frame{CapturedAt: time.Now(), Width: 960, Height: 540, JPEG: jpeg}); !errors.Is(err, ErrInvalidFrame) {
		t.Fatalf("unnegotiated high resolution accepted: %v", err)
	}
}


// Portrait bounds are independent of landscape orientation.
func TestPortraitMjpegProfilesPreserveFullFrame(t *testing.T) {
	screenID := uuid.New()
	service := NewService(nil)
	session := service.Start(screenID, nil)
	jpeg := []byte{0xff, 0xd8, 0xff, 0xd9}
	if session.MaxWidth != 640 || session.MaxHeight != 640 {
		t.Fatalf("unexpected legacy bounds: %dx%d", session.MaxWidth, session.MaxHeight)
	}
	if err := service.Publish(screenID, session.ID, Frame{CapturedAt: time.Now(), Width: 360, Height: 640, JPEG: jpeg}); err != nil {
		t.Fatalf("portrait frame rejected: %v", err)
	}
	service.SelectProfile(screenID, []string{ProfileMJPEG540p10}, []string{ProfileMJPEG540p10})
	if err := service.Publish(screenID, session.ID, Frame{CapturedAt: time.Now(), Width: 540, Height: 960, JPEG: jpeg}); err != nil {
		t.Fatalf("higher resolution portrait frame rejected: %v", err)
	}
}
