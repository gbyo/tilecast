package plugins

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

type recordingTakeovers struct {
	plugin.Takeovers
	requests []plugin.TakeoverRequest
}

func (r *recordingTakeovers) ActivateInTx(_ context.Context, _ pgx.Tx, request plugin.TakeoverRequest) (plugin.TakeoverResult, plugin.AfterCommit, error) {
	r.requests = append(r.requests, request)
	return plugin.TakeoverResult{}, func() {}, nil
}

type routinePlugin struct{ plugin.Bundle }

type emergencyPlugin struct{ plugin.Bundle }

func (emergencyPlugin) MaximumTakeoverClass() plugin.TakeoverClass { return plugin.TakeoverEmergency }

// A plugin gets automation by default and cannot raise a request above its
// ceiling; life_safety is refused for every plugin.
func TestPluginTakeoverClassCeiling(t *testing.T) {
	cases := []struct {
		name    string
		plugin  plugin.Plugin
		request plugin.TakeoverClass
		sent    plugin.TakeoverClass
		refused bool
	}{
		{"default class", routinePlugin{}, "", plugin.TakeoverAutomation, false},
		{"routine automation", routinePlugin{}, plugin.TakeoverAutomation, plugin.TakeoverAutomation, false},
		{"routine operator", routinePlugin{}, plugin.TakeoverOperator, "", true},
		{"routine emergency", routinePlugin{}, plugin.TakeoverEmergency, "", true},
		{"emergency plugin emergency", emergencyPlugin{}, plugin.TakeoverEmergency, plugin.TakeoverEmergency, false},
		{"emergency plugin operator", emergencyPlugin{}, plugin.TakeoverOperator, plugin.TakeoverOperator, false},
		{"emergency plugin life safety", emergencyPlugin{}, plugin.TakeoverLifeSafety, "", true},
		{"unknown class", emergencyPlugin{}, "critical", "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			recorder := &recordingTakeovers{}
			service := takeoversFor(recorder, tc.plugin)
			_, _, err := service.ActivateInTx(context.Background(), nil, plugin.TakeoverRequest{Class: tc.request})
			if tc.refused {
				if !errors.Is(err, plugin.ErrInvalid) || len(recorder.requests) != 0 {
					t.Fatalf("err=%v forwarded=%d, want ErrInvalid and nothing forwarded", err, len(recorder.requests))
				}
				return
			}
			if err != nil || len(recorder.requests) != 1 || recorder.requests[0].Class != tc.sent {
				t.Fatalf("err=%v requests=%+v, want class %q forwarded", err, recorder.requests, tc.sent)
			}
		})
	}
	if takeoversFor(nil, routinePlugin{}) != nil {
		t.Fatal("a host without a Takeover service gave a plugin one")
	}
}
