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

	session := service.Start(screenID)
	if !session.Active || session.FrameIntervalMillis != 125 || notifier.count != 1 {
		t.Fatalf("unexpected session: %+v notifications=%d", session, notifier.count)
	}
	frames, done, cancel, err := service.Subscribe(screenID, session.ID)
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
	first := service.Start(screenID)
	second := service.Start(screenID)
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
	session := service.Start(screenID)
	_, done, cancel, err := service.Subscribe(screenID, session.ID)
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
