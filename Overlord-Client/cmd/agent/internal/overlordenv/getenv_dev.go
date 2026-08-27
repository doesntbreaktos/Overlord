//go:build !builder_release

package overlordenv

import "os"

// Enabled reports whether development-only environment overrides are compiled into this
const Enabled = true

// Getenv returns an application-specific environment override in development
// builds. Production builder artifacts use the builder_release implementation,
// which never consults the process environment.
func Getenv(name string) string {
	return os.Getenv(name)
}
