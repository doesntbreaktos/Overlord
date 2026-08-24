package runtime

import (
	"sync"
	"testing"
	"time"

	"overlord-client/cmd/agent/config"
)

func TestEnv_ClientIDUsesServerCanonicalIdentityAfterAck(t *testing.T) {
	env := &Env{Cfg: config.Config{ID: "claimed-client-id"}}
	if got := env.ClientID(); got != "claimed-client-id" {
		t.Fatalf("ClientID before ack = %q, want configured fallback", got)
	}

	if !env.SetServerClientID("key-fingerprint-canonical-id") {
		t.Fatal("expected canonical server id to be accepted")
	}
	if got := env.ClientID(); got != "key-fingerprint-canonical-id" {
		t.Fatalf("ClientID after ack = %q, want canonical id", got)
	}

	if env.SetServerClientID("bad\r\nheader") {
		t.Fatal("expected control characters in canonical id to be rejected")
	}
	if got := env.ClientID(); got != "key-fingerprint-canonical-id" {
		t.Fatalf("invalid update replaced canonical id with %q", got)
	}
}

func TestEnv_ClientIDConcurrentAccess(t *testing.T) {
	env := &Env{Cfg: config.Config{ID: "claimed-client-id"}}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 1_000; j++ {
				if got := env.ClientID(); got == "" {
					t.Errorf("ClientID returned empty during concurrent access")
					return
				}
			}
		}()
	}
	for i := 0; i < 100; i++ {
		if !env.SetServerClientID("key-fingerprint-canonical-id") {
			t.Fatal("canonical id update failed")
		}
	}
	wg.Wait()
}

func TestEnv_NotificationConfig(t *testing.T) {
	env := &Env{}

	if kw := env.GetNotificationKeywords(); kw != nil {
		t.Fatalf("expected nil keywords initially, got %v", kw)
	}
	if ms := env.GetNotificationMinIntervalMs(); ms != 0 {
		t.Fatalf("expected 0 interval initially, got %d", ms)
	}
	if cb := env.GetClipboardEnabled(); cb {
		t.Fatal("expected clipboard disabled initially")
	}

	env.SetNotificationConfig([]string{"bank", "password"}, 5000, true)

	kw := env.GetNotificationKeywords()
	if len(kw) != 2 || kw[0] != "bank" || kw[1] != "password" {
		t.Fatalf("expected [bank password], got %v", kw)
	}
	if env.GetNotificationMinIntervalMs() != 5000 {
		t.Fatalf("expected 5000ms interval, got %d", env.GetNotificationMinIntervalMs())
	}
	if !env.GetClipboardEnabled() {
		t.Fatal("expected clipboard enabled")
	}
}

func TestEnv_NotificationConfig_ZeroInterval(t *testing.T) {
	env := &Env{}
	env.SetNotificationConfig([]string{"test"}, 3000, false)
	env.SetNotificationConfig([]string{"test2"}, 0, false)

	if env.GetNotificationMinIntervalMs() != 3000 {
		t.Fatalf("expected interval to remain 3000 when 0 passed, got %d", env.GetNotificationMinIntervalMs())
	}
}

func TestEnv_NotificationKeywords_ReturnsCopy(t *testing.T) {
	env := &Env{}
	env.SetNotificationConfig([]string{"a", "b"}, 1000, false)

	kw1 := env.GetNotificationKeywords()
	kw2 := env.GetNotificationKeywords()

	kw1[0] = "modified"
	if env.GetNotificationKeywords()[0] == "modified" {
		t.Fatal("GetNotificationKeywords should return a copy")
	}

	if kw2[0] != "a" || kw2[1] != "b" {
		t.Fatalf("expected [a b], got %v", kw2)
	}
}

func TestEnv_LastPong(t *testing.T) {
	env := &Env{}

	if !env.LastPong().IsZero() {
		t.Fatal("expected zero time for unset LastPong")
	}

	now := time.Now().UnixMilli()
	env.SetLastPong(now)

	pong := env.LastPong()
	if pong.UnixMilli() != now {
		t.Fatalf("expected %d, got %d", now, pong.UnixMilli())
	}
}

func TestEnv_LastPong_ZeroDefault(t *testing.T) {
	env := &Env{}

	before := time.Now().UnixMilli()
	env.SetLastPong(0)
	after := time.Now().UnixMilli()

	pong := env.LastPong()
	if pong.UnixMilli() < before || pong.UnixMilli() > after {
		t.Fatalf("expected time between %d and %d, got %d", before, after, pong.UnixMilli())
	}
}

func TestEnv_LastPong_NegativeDefault(t *testing.T) {
	env := &Env{}
	before := time.Now().UnixMilli()
	env.SetLastPong(-1)
	after := time.Now().UnixMilli()

	pong := env.LastPong()
	if pong.UnixMilli() < before || pong.UnixMilli() > after {
		t.Fatalf("expected time between %d and %d, got %d", before, after, pong.UnixMilli())
	}
}

func TestHostname(t *testing.T) {
	h := Hostname()
	if h == "" {
		t.Fatal("expected non-empty hostname")
	}
}

func TestCurrentUser(t *testing.T) {
	u := CurrentUser()
	if u == "" {
		t.Fatal("expected non-empty user")
	}
}

func TestMinDuration(t *testing.T) {
	if got := MinDuration(1*time.Second, 5*time.Second); got != 1*time.Second {
		t.Fatalf("expected 1s, got %s", got)
	}
	if got := MinDuration(5*time.Second, 1*time.Second); got != 1*time.Second {
		t.Fatalf("expected 1s, got %s", got)
	}
	if got := MinDuration(3*time.Second, 3*time.Second); got != 3*time.Second {
		t.Fatalf("expected 3s, got %s", got)
	}
	if got := MinDuration(0, 1*time.Second); got != 0 {
		t.Fatalf("expected 0, got %s", got)
	}
}
