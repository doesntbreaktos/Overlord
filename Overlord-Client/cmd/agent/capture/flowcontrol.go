package capture

import (
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"overlord-client/cmd/agent/internal/overlordenv"
)

const defaultMaxInFlightFrames int64 = 2

var (
	inFlightFrames atomic.Int64
	frameAckSeen   atomic.Bool
	lastAckNano    atomic.Int64
	maxFrameSlots  atomic.Int64
	frameStreamsMu sync.Mutex
	frameStreams   = make(map[string]int)
)

func AcquireFrameSlot() bool {
	if !frameAckSeen.Load() {
		return true
	}

	for {
		cur := inFlightFrames.Load()
		if cur >= activeFrameSlotLimit() {
			lastAck := lastAckNano.Load()
			if lastAck > 0 && time.Since(time.Unix(0, lastAck)) > time.Second {
				inFlightFrames.Store(0)
				continue
			}
			statFrameSlotSkips.Add(1)
			return false
		}
		if inFlightFrames.CompareAndSwap(cur, cur+1) {
			return true
		}
	}
}

func ReleaseFrameSlot() {
	frameAckSeen.Store(true)
	lastAckNano.Store(time.Now().UnixNano())
	if inFlightFrames.Add(-1) < 0 {
		inFlightFrames.Store(0)
	}
}

func ResetFrameSlots() {
	inFlightFrames.Store(0)
	frameAckSeen.Store(false)
	lastAckNano.Store(0)
}

func SetFrameFlowTargetFPS(fps int) {
	maxFrameSlots.Store(frameSlotLimitForFPS(fps))
}

func StartFrameFlowStream(stream string, fps int) {
	frameStreamsMu.Lock()
	frameStreams[stream] = fps
	applyActiveFrameStreamLimitLocked()
	frameStreamsMu.Unlock()
}

func UpdateFrameFlowStream(stream string, fps int) {
	frameStreamsMu.Lock()
	if _, active := frameStreams[stream]; active {
		frameStreams[stream] = fps
		applyActiveFrameStreamLimitLocked()
	}
	frameStreamsMu.Unlock()
}

func StopFrameFlowStream(stream string) {
	frameStreamsMu.Lock()
	delete(frameStreams, stream)
	if len(frameStreams) == 0 {
		ResetFrameSlots()
		maxFrameSlots.Store(defaultMaxInFlightFrames)
	} else {
		applyActiveFrameStreamLimitLocked()
	}
	frameStreamsMu.Unlock()
}

func applyActiveFrameStreamLimitLocked() {
	combinedFPS := 0
	for _, fps := range frameStreams {
		if fps > 0 {
			combinedFPS += fps
		}
	}
	maxFrameSlots.Store(frameSlotLimitForFPS(combinedFPS))
}

func frameSlotLimitForFPS(fps int) int64 {
	limit := defaultMaxInFlightFrames
	switch {
	case fps >= 180:
		limit = 12
	case fps >= 120:
		limit = 8
	case fps >= 60:
		limit = 4
	}
	if env := strings.TrimSpace(overlordenv.Getenv("OVERLORD_DESKTOP_IN_FLIGHT_FRAMES")); env != "" {
		if v, err := strconv.Atoi(env); err == nil {
			switch {
			case v < 1:
				limit = 1
			case v > 32:
				limit = 32
			default:
				limit = int64(v)
			}
		}
	}
	return limit
}

func activeFrameSlotLimit() int64 {
	if limit := maxFrameSlots.Load(); limit > 0 {
		return limit
	}
	return defaultMaxInFlightFrames
}

func frameFlowSnapshot() (inFlight, limit int64, ackSeen bool, ackAge time.Duration) {
	inFlight = inFlightFrames.Load()
	limit = activeFrameSlotLimit()
	ackSeen = frameAckSeen.Load()
	if lastAck := lastAckNano.Load(); lastAck > 0 {
		ackAge = time.Since(time.Unix(0, lastAck))
	}
	return inFlight, limit, ackSeen, ackAge
}
