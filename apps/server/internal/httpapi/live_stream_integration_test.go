package httpapi

import (
	"context"
	"encoding/binary"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
	"github.com/tilecast/tilecast/apps/server/internal/livestream"
)

// This real-PostgreSQL path crosses the authenticated player socket and then
// proves the live frame did not create either kind of stored screen image.
func TestLiveStreamBinaryFrameRelaysWithoutPersistence(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		env.server.liveStreams = livestream.NewService(env.server.devices)
		session := env.server.liveStreams.Start(env.screenID, nil)
		subscription, cancelSubscription, err := env.server.liveStreams.Subscribe(env.screenID, session.ID)
		frames := subscription.Frames
		if err != nil {
			t.Fatal(err)
		}
		defer cancelSubscription()

		principal := devices.DevicePrincipal{ScreenID: env.screenID, ScreenName: "Cafeteria TV", Enabled: true}
		socketServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			env.server.playerSocket(w, r.WithContext(context.WithValue(r.Context(), deviceContextKey, principal)))
		}))
		defer socketServer.Close()

		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		connection, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(socketServer.URL, "http"), nil)
		if err != nil {
			t.Fatal(err)
		}
		defer connection.CloseNow() //nolint:errcheck
		var hello socketMessage
		if err = wsjson.Read(ctx, connection, &hello); err != nil {
			t.Fatal(err)
		}

		jpeg := []byte{0xff, 0xd8, 1, 2, 3, 0xff, 0xd9}
		payload := make([]byte, 33, 33+len(jpeg))
		copy(payload[:4], "TCLS")
		payload[4] = 1
		copy(payload[5:21], session.ID[:])
		binary.BigEndian.PutUint64(payload[21:29], uint64(time.Now().UTC().UnixMilli()))
		binary.BigEndian.PutUint16(payload[29:31], 640)
		binary.BigEndian.PutUint16(payload[31:33], 360)
		payload = append(payload, jpeg...)
		if err = connection.Write(ctx, websocket.MessageBinary, payload); err != nil {
			t.Fatal(err)
		}

		select {
		case frame := <-frames:
			if frame.Width != 640 || frame.Height != 360 || string(frame.JPEG) != string(jpeg) {
				t.Fatalf("relayed frame = %+v", frame)
			}
		case <-ctx.Done():
			t.Fatal("timed out waiting for relayed live frame")
		}

		var previews, snapshots int
		if err = env.pool.QueryRow(ctx, `SELECT count(*) FROM screen_previews WHERE screen_id=$1`, env.screenID).Scan(&previews); err != nil {
			t.Fatal(err)
		}
		if err = env.pool.QueryRow(ctx, `SELECT count(*) FROM screen_snapshots WHERE screen_id=$1`, env.screenID).Scan(&snapshots); err != nil {
			t.Fatal(err)
		}
		if previews != 0 || snapshots != 0 {
			t.Fatalf("live stream persisted images: previews=%d snapshots=%d", previews, snapshots)
		}
	})
}

// The same real-PostgreSQL path for H.264: TCLS version 2 access units
// cross the authenticated socket and reach the relay as a decodable GOP,
// and nothing about them is stored.
func TestLiveStreamH264ChunksRelayWithoutPersistence(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		env.server.liveStreams = livestream.NewService(env.server.devices)
		session := env.server.liveStreams.Start(env.screenID, []string{livestream.ProfileH264540p15})
		env.server.liveStreams.SelectProfile(env.screenID, []string{livestream.ProfileH264540p15}, nil)
		subscription, cancelSubscription, err := env.server.liveStreams.SubscribeH264(env.screenID, session.ID)
		if err != nil {
			t.Fatal(err)
		}
		defer cancelSubscription()

		principal := devices.DevicePrincipal{ScreenID: env.screenID, ScreenName: "Cafeteria TV", Enabled: true}
		socketServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			env.server.playerSocket(w, r.WithContext(context.WithValue(r.Context(), deviceContextKey, principal)))
		}))
		defer socketServer.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		connection, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(socketServer.URL, "http"), nil)
		if err != nil {
			t.Fatal(err)
		}
		defer connection.CloseNow() //nolint:errcheck
		var hello socketMessage
		if err = wsjson.Read(ctx, connection, &hello); err != nil {
			t.Fatal(err)
		}
		// An IDR near the size ceiling must fit the socket read limit.
		bigKey := append(append([]byte(nil), h264Key...), make([]byte, livestream.MaxAccessUnitBytes-len(h264Key))...)
		for sequence, payload := range [][]byte{bigKey, h264Delta} {
			packet := livestream.EncodeChunk(session.ID, 2, uint64(sequence+1), uint64(sequence)*66_666, 960, 540, sequence == 0, payload)
			if err = connection.Write(ctx, websocket.MessageBinary, packet); err != nil {
				t.Fatal(err)
			}
		}
		var received []livestream.Chunk
		for len(received) < 2 {
			select {
			case <-subscription.Ready:
				received = append(received, subscription.Take()...)
			case <-ctx.Done():
				t.Fatalf("timed out with %d chunks", len(received))
			}
		}
		if !received[0].Keyframe || len(received[0].Payload()) != livestream.MaxAccessUnitBytes || received[1].Keyframe {
			t.Fatalf("relayed chunks %+v", received)
		}
		var previews, snapshots int
		if err = env.pool.QueryRow(ctx, `SELECT count(*) FROM screen_previews WHERE screen_id=$1`, env.screenID).Scan(&previews); err != nil {
			t.Fatal(err)
		}
		if err = env.pool.QueryRow(ctx, `SELECT count(*) FROM screen_snapshots WHERE screen_id=$1`, env.screenID).Scan(&snapshots); err != nil {
			t.Fatal(err)
		}
		if previews != 0 || snapshots != 0 {
			t.Fatalf("live stream persisted images: previews=%d snapshots=%d", previews, snapshots)
		}
	})
}
