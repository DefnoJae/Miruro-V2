# Miruro V2 provider

Seanime-compatible online streaming provider for https://www.miruro.cx/.

## Install

In Seanime's Extensions page, add this manifest URL:

https://raw.githubusercontent.com/DefnoJae/Miruro-V2/main/Manifest.json

The capitalized manifest path is intentional: it preserves the repository's original filename. The payload is `provider.js`, a standalone JavaScript `Provider` class with no npm dependencies. Node is needed only to run the development tests.

## Selection behavior

- The application's **sub/dub switch** changes the search selection and persists in the show and episode IDs. Miruro separates tracks into `sub` (hardsub/default sub), `ssub` (softsub, usually with external subtitle files) and `dub`. In sub mode the provider prefers a softsub entry when one exists so external subtitle tracks are attached, then falls back to the hardsub entry.
- **Auto** resolves the same way the site does: providers are tried in Miruro's configured order (`Icarus`, `Anikoto`, `KickAssAnime`, `AllManga`, `AnimePahe`, `AnimeGG`, `AniWaveS`). Naming a server restricts resolution to that provider and never silently substitutes another one.
- **Audio tracks inside a stream** belong to the player. The provider returns the original master playlist URL without selecting a rendition, stripping audio groups, or splitting audio tracks into separate sub/dub episodes.
- External subtitle tracks retain their source labels and default flags. Miruro serves some tracks behind extension-less or `.jpeg` proxy URLs, so the declared `format` (`vtt`/`srt`) is trusted as well as the file extension. Embedded HLS subtitle renditions remain in the master playlist.

## Features and boundaries

Search follows Miruro's cursor pagination, uses the catalogue metadata, and prefers the result whose `external_ids.anilist` matches the requested AniList ID. Standard Seanime consumes only its documented search fields; extra `metadata` (titles, description, cover, format, year, status, episode counts) is included for clients that read it.

Episode listing uses the catalogue's episode endpoint (`limit=10000`), sorts and deduplicates episodes, and preserves integer numbering. Fractional specials cannot be represented by Seanime's integer episode contract.

The resolver calls `/api/v1/anime/{id}/episodes/{n}/play`, collects every track (`sub`, `ssub`, `dub`), and returns the server's real stream URL together with its required headers (typically `Referer`). One stream entry can expose both a direct media URL and an alternate embed URL; the direct URL is returned and raw embed HTML is never returned as a video URL.

Miruro's catalogue responses are not plain JSON: every endpoint may answer with `application/octet-stream` whose bytes are XOR'd with the key `miruro/catalog` and then gzip-compressed. The provider decodes this in pure JavaScript (no `DecompressionStream`, `zlib`, or other runtime dependencies) so it works inside the sandboxed Seanime runtime. A valid request returns `200`; a malformed one (for example an unsupported `limit`) returns a `400 Unsupported catalog request.`, and a bot-management block from an untrusted host returns `403`. Both are surfaced as explicit errors rather than empty results.

External subtitle URLs are returned exactly as Miruro serves them. Some of those hosts reject requests that do not originate from a browser/player context, so subtitle loading can depend on the client player. Subtitles embedded in an HLS master playlist are unaffected.

The catalogue API is behind Cloudflare bot management. Requests go through Seanime's Cloudflare-bypass client (a Chrome TLS fingerprint) and, when the bypass request cannot reach a host at all, fall back to plain `fetch`; both send browser-like headers. A host that still blocks the request answers `403`, which is reported explicitly; because a `403` can be host-specific, the remaining mirrors are tried before giving up. The default host is `https://www.miruro.cx` (Miruro's current primary domain) with `https://www.miruro.tv`, `https://www.miruro.to`, `https://www.miruro.bz` and `https://www.miruro.ru` as fallbacks. Miruro retired `www.miruro.tv` as its primary domain in late October 2026 and announced the older mirrors are being phased out.

## Verify

```sh
npm test
npm run test:live
```

Unit tests use mocked responses (including a fixture that exercises the XOR+gzip decode through a real gzip stream) and need no network. The optional live check searches Spy×Family, lists both sub and dub episodes, resolves each mode, and fetches only the HLS master (no video segments). Host outages can make this check fail independently of provider changes.

Verified on October 16, 2026 against the then-primary `www.miruro.tv`: live sub and dub search (54 results, AniList ID matched), episode listing (12 episodes), resolution through **Auto** to **Icarus**, and HLS master retrieval (`200`, `#EXTM3U`) all succeeded. The sub track exposed 12 external subtitle tracks and dub exposed 1. Miruro has since moved its primary domain to `www.miruro.cx`, so this version defaults there and keeps the older mirrors as fallbacks; the change could not be re-verified live from the development workspace, which Miruro answers with a Cloudflare challenge. Actual playback inside Seanime/CAnime was not available in this workspace.

## Repository layout and sources

The repository initially contained only an empty `Manifest.json`. It now contains the manifest, provider, contract reference, tests, and a dependency-free CI check.

- [Seanime provider documentation](https://seanime.gitbook.io/seanime-extensions/content-providers/online-streaming-provider)
- [Authoritative Go provider contract](https://github.com/5rahim/seanime/blob/main/internal/extension/hibike/onlinestream/types.go)
- [TypeScript contract reference](https://github.com/5rahim/seanime/blob/main/internal/extension_repo/goja_onlinestream_test/onlinestream-provider.d.ts)
- [Seanime runtime fetch options](https://github.com/5rahim/seanime/blob/main/internal/extension_repo/goja_plugin_types/core.d.ts)
- [Public manifest example](https://github.com/kRYstall9/Seanime-streaming-providers/blob/main/src/AnimeKai/manifest.json)
- Miruro (v1.15.3) public client routes reimplemented here: `GET /api/v1/anime` (search/filter, cursor pagination), `/api/v1/anime/{id}`, `/api/v1/anime/{id}/episodes`, `/api/v1/anime/{id}/episodes/{n}`, and `/api/v1/anime/{id}/episodes/{n}/play`. The catalogue response body is XOR'd with `miruro/catalog` and gzip-compressed.

Upstream API routes, encoding and host behavior may change. Keep fixes in this repository and rerun both checks when updating the resolver.
