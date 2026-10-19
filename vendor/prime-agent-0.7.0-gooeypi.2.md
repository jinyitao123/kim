# prime-agent 0.7.0-gooeypi.2

This artifact is a GooeyPi-maintained patch of the previously trusted
`prime-agent-0.7.0.tgz` vendor archive.

- Base SHA-256: `88b6578518c72cd51a825bc80f28e0fef9a64c67de4a7d6fd7afd7ca1b34da0b`
- Patched SHA-256: `ec92af9b03311277522568bb850078bef628fbe40b379062f530ad58c41b5f31`
- Patched files: `package.json`, `dist/core/auth-storage.js`, `dist/bundle/chunk-L3VO7F2S.js`

The reviewable source diff is
`vendor/patches/prime-agent-0.7.0-gooeypi.2.patch`. Run
`npm run vendor:verify-patches` to verify the trusted base checksum, apply that
diff, compare every rebuilt package file with this reviewed archive, and prove
that the pinned npm toolchain can repack the result reproducibly.

The Prime Agent CLI bundle embeds the same MCP OAuth implementation shipped by
`prime-agent-ai`. This patch mirrors GooeyPi's confidential-client support so
Prime sessions retain the dynamically registered `client_secret` and selected
token authentication method during authorization-code and refresh-token
requests.

The dependency-pin release tests bind the archive to its reviewed SHA-512
digest. The end-to-end token behavior is covered by
`tests/backend/mcp-oauth.test.ts` against the unbundled implementation shared
with the desktop host.

Weave opts into `WEAVE_DISABLE_SHARED_PRIME_AUTH=1` in its Prime subprocesses.
This disables the shared Prime CLI config reader/writer even when the CLI requests
that fallback. Explicit app auth storage remains usable; without this opt-in,
upstream behavior is unchanged. Both source and the distributed CLI bundle carry
the same guard. Other CLI homes and credentials are not migrated or modified.
