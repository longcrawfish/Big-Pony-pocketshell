// Reviewed public Ed25519 SPKI PEM keys only. Provision before enabling OTA.
// Never accept a verification key supplied by the release or a runtime env var.
// An empty trust store deliberately disables automatic application of updates.
export const RELEASE_PUBLIC_KEYS: Readonly<Record<string, string>> = Object.freeze({});
