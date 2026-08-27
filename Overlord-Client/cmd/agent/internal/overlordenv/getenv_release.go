//go:build builder_release

package overlordenv

// enabled for dev only builds
const Enabled = false

// Getenv deliberately ignores application-specific environment overrides in production builder artifacts.
func Getenv(string) string {
	return ""
}
