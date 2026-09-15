/**
 * Spec's initial EF-compatible implementation does not promise a supported JavaScript library API
 * (package public API; see docs/README.md for design authority).
 * Historical implementation notes previously described the product/package
 * Boundary": "EF v1 promises the CLI and its documented machine-readable
 * contracts. It does not initially expose a supported JavaScript library
 * API."). The Spec CLI (`src/cli.ts`, `src/cli/*`) and its stable JSON envelopes
 * are the product surface; this entry point deliberately exports nothing
 * meaningful. It exists only so the package has a resolvable, buildable
 * `main`/`exports` entry alongside the `spec` binary.
 */
export type NoLibraryApi = Record<string, never>

/** Deliberately empty: see the module doc comment above. */
export const noLibraryApi: NoLibraryApi = {}
