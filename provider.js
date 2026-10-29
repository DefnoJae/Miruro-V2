// Seanime online-stream provider for Miruro. No browser, Node, or third-party runtime dependencies.
class Provider {
    constructor() {
        // Miruro moved its primary domain to www.miruro.cx in late October 2026 and
        // announced the older mirrors are being phased out; keep them as fallbacks.
        this.base = "https://www.miruro.cx";
        this.mirrors = ["https://www.miruro.cx", "https://www.miruro.tv", "https://www.miruro.to", "https://www.miruro.bz", "https://www.miruro.ru"];
        this.catalogueKey = "miruro/catalog";
        this.timeout = 25;
        this.pageSize = 15;
        this.maxPages = 40;
        this.providers = [
            { id: "icarus", label: "Icarus" },
            { id: "anikoto", label: "Anikoto" },
            { id: "kickassanime", label: "KickAssAnime" },
            { id: "allmanga", label: "AllManga" },
            { id: "animepahe", label: "AnimePahe" },
            { id: "animegg", label: "AnimeGG" },
            { id: "aniwaves", label: "AniWaveS" }
        ];
        this._activeHost = null;
    }

    getSettings() {
        return { supportsDub: true, episodeServers: ["Auto"].concat(this.providers.map(p => p.label)) };
    }

    encode(value) { return encodeURIComponent(JSON.stringify(value)); }
    decode(id) {
        let value;
        try { value = JSON.parse(decodeURIComponent(id)); } catch (_) { throw new Error("Invalid Miruro ID; search again."); }
        if (!value || value.id == null || !["sub", "dub"].includes(value.mode)) throw new Error("Invalid Miruro selection.");
        return value;
    }

    hosts() {
        if (!this._activeHost) return this.mirrors.slice();
        return [this._activeHost].concat(this.mirrors.filter(h => h !== this._activeHost));
    }
    query(params) {
        const parts = [];
        for (const key of Object.keys(params || {})) {
            const value = params[key];
            if (value === undefined || value === null || value === "") continue;
            if (Array.isArray(value)) {
                if (!value.length) continue;
                parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(value.join(",")));
            } else {
                parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(value)));
            }
        }
        return parts.length ? "?" + parts.join("&") : "";
    }

    async request(path, params, referer) {
        const failures = [];
        for (const host of this.hosts()) {
            const url = host + "/api/" + String(path).replace(/^\/+/, "") + this.query(params);
            // Miruro sits behind Cloudflare bot management, so prefer Seanime's bypass
            // client (Chrome TLS fingerprint) and only fall back to the plain client when
            // the bypass request fails before any response arrives.
            for (const bypass of [true, false]) {
                const label = host + (bypass ? "" : " (no bypass)");
                try {
                    const response = await fetch(url, {
                        timeout: this.timeout,
                        ...(bypass ? {} : { noCloudflareBypass: true }),
                        headers: {
                            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                            "Accept": "*/*",
                            "Accept-Language": "en-US,en;q=0.9",
                            "Referer": referer || host + "/",
                            "Origin": host
                        }
                    });
                    if (response.ok) {
                        this._activeHost = host;
                        return response;
                    }
                    const detail = await this.problem(response);
                    // A 400 is the catalogue rejecting the request itself, so every mirror
                    // answers the same; a 403 or 5xx can be host-specific, so try the rest.
                    if (response.status === 400) {
                        this._activeHost = null;
                        throw new Error("Miruro rejected the request (HTTP 400" + (detail ? ": " + detail : "") + ").");
                    }
                    failures.push(label + ": HTTP " + response.status + (detail ? " " + detail : ""));
                    break;
                } catch (error) {
                    if (/rejected the request/.test(error.message)) throw error;
                    failures.push(label + ": " + error.message);
                }
            }
        }
        throw new Error("Miruro request failed. " + failures.join("; "));
    }
    contentType(response) {
        if (response.contentType) return response.contentType;
        const headers = response.headers || {};
        if (typeof headers.get === "function") return headers.get("content-type") || "";
        const key = Object.keys(headers).find(key => key.toLowerCase() === "content-type");
        return key ? String(headers[key]) : "";
    }
    async problem(response) {
        const type = this.contentType(response);
        try {
            if (/json/i.test(type)) { const body = await response.json(); return body.detail || body.title || body.error || ""; }
            const text = await response.text();
            return text.slice(0, 200).replace(/\s+/g, " ").trim();
        } catch (_) { return ""; }
    }
    async body(response) {
        // Every Miruro catalogue endpoint may answer with an application/octet-stream
        // payload: JSON is gzip-compressed, then XOR'd with the catalogue key.
        const type = this.contentType(response);
        if (/octet-stream/i.test(type)) return JSON.parse(this.utf8(this.gunzip(this.xor(await this.bytes(response), this.key()))));
        if (/html/i.test(type)) throw new Error("Miruro returned HTML instead of catalogue data (HTTP " + response.status + ").");
        const value = await response.json();
        if (value == null) throw new Error("Miruro returned invalid catalogue JSON (HTTP " + response.status + ", type " + (type || "unknown") + ").");
        return value;
    }
    async json(response) {
        const body = await this.body(response);
        if (body && typeof body === "object" && "data" in body) return body;
        return { data: body };
    }
    async playback(id, number) {
        const response = await this.request("v1/anime/" + encodeURIComponent(id) + "/episodes/" + encodeURIComponent(number) + "/play");
        const body = await this.body(response);
        return body && typeof body === "object" && "data" in body ? body.data : body;
    }

    async search(opts) {
        const mode = opts.dub ? "dub" : "sub";
        const query = (opts.query || opts.media?.englishTitle || opts.media?.romajiTitle || "").trim();
        if (!query) return [];
        const found = [], seen = {};
        let cursor;
        for (let page = 0; page < this.maxPages; page++) {
            const body = await this.json(await this.request("v1/anime", { q: query, limit: this.pageSize, cursor, ...(opts.year ? { season_year: opts.year } : {}) }));
            const items = Array.isArray(body.data) ? body.data : Array.isArray(body.data?.data) ? body.data.data : Array.isArray(body.data?.media) ? body.data.media : null;
            if (!items) throw new Error("Unexpected Miruro search response shape.");
            if (!items.length) break;
            for (const item of items) {
                const id = item.id ?? item.anilistId ?? item.anilist_id;
                if (id == null || seen[id]) continue;
                seen[id] = true;
                const anilistId = Number(item.external_ids?.anilist?.[0]);
                found.push({
                    id: this.encode({ id, mode }), title: this.title(item.title) || String(id), url: this.base + "/watch/" + id, subOrDub: mode,
                    metadata: { anilistId: Number.isFinite(anilistId) ? anilistId : undefined, titles: item.title, coverImage: item.cover_url, description: item.description, episodes: item.episode_count, episodeCounts: item.episode_counts, format: item.format, year: item.season_year, status: item.status }
                });
            }
            const hasMore = body.has_more ?? body.hasMore;
            const next = body.next_cursor ?? body.nextCursor;
            if (!hasMore || next == null) break;
            cursor = next;
        }
        return found.sort((a, b) => Number(b.metadata.anilistId === opts.media?.id) - Number(a.metadata.anilistId === opts.media?.id));
    }
    title(value) {
        if (typeof value === "string") return value;
        if (!value || typeof value !== "object") return "";
        return value.english || value.romaji || value.native || "";
    }

    async findEpisodes(id) {
        const selection = this.decode(id);
        const body = await this.json(await this.request("v1/anime/" + encodeURIComponent(selection.id) + "/episodes", { limit: 10000 }));
        const items = Array.isArray(body.data) ? body.data : Array.isArray(body.data?.episodes) ? body.data.episodes : Array.isArray(body.data?.data) ? body.data.data : [];
        const result = [], seen = {};
        for (const item of items) {
            const number = Number(item.episode_number ?? item.number ?? item.episode);
            if (!Number.isInteger(number) || number < 0 || seen[number]) continue;
            seen[number] = true;
            result.push({ id: this.encode({ ...selection, number }), number, title: item.title || "Episode " + number, url: this.base + "/watch/" + selection.id + "?ep=" + number });
        }
        return result.sort((a, b) => a.number - b.number);
    }

    async findEpisodeServer(episode, server) {
        const selection = this.decode(episode.id);
        if (!Number.isInteger(selection.number)) throw new Error("Invalid Miruro episode ID.");
        const play = await this.playback(selection.id, selection.number);
        const tracks = Array.isArray(play.tracks) ? play.tracks : Array.isArray(play.data?.tracks) ? play.data.tracks : [];
        const wanted = selection.mode === "dub" ? ["dub"] : ["sub", "ssub"];
        const requested = !server || server === "default" ? "Auto" : server;
        const backend = requested === "Auto" ? null : this.providerId(requested);
        if (requested !== "Auto" && !backend) throw new Error("Unknown Miruro server: " + requested);
        // Mirror the site's configured provider order so "Auto" agrees with Miruro.
        // Within a provider, prefer soft-subbed entries that carry external subtitles.
        const rank = new Map(this.providers.map((p, i) => [p.id, i]));
        const trackRank = selection.mode === "dub" ? { dub: 0 } : { ssub: 0, sub: 1 };
        const candidates = [];
        for (const track of tracks) {
            if (!wanted.includes(track.track)) continue;
            for (const entry of Array.isArray(track.providers) ? track.providers : []) {
                if (backend && entry.provider !== backend) continue;
                candidates.push({ track, entry, rank: rank.has(entry.provider) ? rank.get(entry.provider) : this.providers.length + 1, trackRank: trackRank[track.track] ?? 5 });
            }
        }
        candidates.sort((a, b) => a.rank - b.rank || a.trackRank - b.trackRank);
        const failures = [];
        for (const { track, entry } of candidates) {
            const label = this.providerLabel(entry.provider);
            for (const box of Array.isArray(entry.servers) ? entry.servers : []) {
                // Subtitle tracks may live on the provider or the server object.
                const subtitles = this.subtitles([...(entry.subtitles || []), ...(box.subtitles || [])], label, track.track);
                const sources = this.sources(box, label, track.track);
                if (!sources.length) { failures.push(label + "/" + (box.server || "server") + ": no playable stream"); continue; }
                return { server: label + " · " + track.track, headers: this.headers(box), videoSources: sources.map(s => ({ ...s, subtitles: s.subtitles.length ? s.subtitles : subtitles })) };
            }
        }
        if (backend) throw new Error("Miruro's " + requested + " server has no " + selection.mode + " stream for this episode.");
        throw new Error("Miruro has no " + selection.mode + " stream for this episode. " + failures.slice(0, 4).join("; "));
    }
    providerId(label) {
        const match = this.providers.find(p => p.label.toLowerCase() === String(label).toLowerCase());
        return match ? match.id : null;
    }
    providerLabel(id) {
        const match = this.providers.find(p => p.id === id);
        return match ? match.label : String(id || "Miruro");
    }
    sources(box, label, mode) {
        const sources = [], seen = {};
        for (const stream of Array.isArray(box.streams) ? box.streams : []) {
            const url = stream && (stream.url || stream.file);
            // A stream may expose both a direct media URL and an alternate embed URL;
            // only skip when there is no playable media URL.
            if (!url || stream.format === "embed") continue;
            const type = this.mediaType(url, stream.format);
            if (type === "unknown" || seen[url]) continue;
            seen[url] = true;
            const quality = String(stream.quality || stream.resolution || "auto");
            sources.push({ url, type, quality: quality + " · " + label + " · " + (box.server || "source"), label: label + " · " + mode, subtitles: this.subtitles(stream.subtitles, label, mode) });
        }
        return sources;
    }
    headers(box) {
        const result = {};
        const raw = box && box.headers;
        if (raw && typeof raw === "object") for (const key of Object.keys(raw)) result[this.headerName(key)] = raw[key];
        return result;
    }
    headerName(key) {
        return String(key).toLowerCase() === "referer" ? "Referer" : String(key).toLowerCase() === "origin" ? "Origin" : key;
    }
    subtitles(list, label, mode) {
        const result = [], seen = {};
        for (const item of Array.isArray(list) ? list : []) {
            const url = item && (item.file || item.url);
            if (!url) continue;
            // Miruro proxies some subtitle tracks behind extension-less/.jpeg URLs, so
            // trust the declared format as well as the file extension.
            const format = String(item.format || "").toLowerCase();
            if (!(format === "vtt" || format === "srt" || /\.(?:vtt|srt)(?:[?#]|$)/i.test(url))) continue;
            if (seen[url]) continue;
            seen[url] = true;
            let language = String(item.label || item.language || item.lang || "Unknown");
            if (item.default || item.isDefault) language += " (default)";
            result.push({ id: "miruro-" + label + "-" + mode + "-" + result.length, url, language, isDefault: Boolean(item.default || item.isDefault) });
        }
        return result;
    }
    mediaType(url, hint) {
        if (/\.m3u8(?:[?#]|$)/i.test(url) || /^(hls|m3u8|application\/x-mpegurl)/i.test(String(hint || ""))) return "m3u8";
        if (/\.mp4(?:[?#]|$)/i.test(url) || /^(mp4|video\/mp4)/i.test(String(hint || ""))) return "mp4";
        return "unknown";
    }

    key() { return this.utf8Bytes(this.catalogueKey); }
    async bytes(response) {
        if (typeof response.arrayBuffer === "function") return new Uint8Array(await response.arrayBuffer());
        // Seanime exposes the original Go byte slice as body; text is not a binary transport.
        if (response.body != null && typeof response.body.length === "number") return new Uint8Array(response.body);
        throw new Error("Miruro binary response requires raw bytes from this runtime.");
    }
    xor(data, key) {
        const out = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) out[i] = data[i] ^ key[i % key.length];
        return out;
    }
    gunzip(data) {
        if (data.length > 2 && data[0] === 0x1f && data[1] === 0x8b && data[2] === 0x08) {
            let offset = 10, flags = data[3];
            if (flags & 0x04) { offset += 2 + (data[offset] | (data[offset + 1] << 8)); }
            if (flags & 0x08) { while (offset < data.length && data[offset] !== 0) offset++; offset++; }
            if (flags & 0x10) { while (offset < data.length && data[offset] !== 0) offset++; offset++; }
            if (flags & 0x02) offset += 2;
            return this.inflate(data, offset);
        }
        return this.inflate(data, 0);
    }
    utf8(data) {
        let out = "";
        for (let i = 0; i < data.length;) {
            const byte = data[i];
            if (byte < 0x80) { out += String.fromCharCode(byte); i++; }
            else if (byte < 0xe0) { out += String.fromCharCode(((byte & 0x1f) << 6) | (data[i + 1] & 0x3f)); i += 2; }
            else if (byte < 0xf0) { out += String.fromCharCode(((byte & 0x0f) << 12) | ((data[i + 1] & 0x3f) << 6) | (data[i + 2] & 0x3f)); i += 3; }
            else { const cp = ((byte & 0x07) << 18) | ((data[i + 1] & 0x3f) << 12) | ((data[i + 2] & 0x3f) << 6) | (data[i + 3] & 0x3f); const v = cp - 0x10000; out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff)); i += 4; }
        }
        return out;
    }
    utf8Bytes(text) {
        const out = [];
        for (let i = 0; i < text.length; i++) {
            let code = text.charCodeAt(i);
            if (code < 0x80) out.push(code);
            else if (code < 0x800) { out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f)); }
            else if (code >= 0xd800 && code <= 0xdbff) { code = 0x10000 + ((code - 0xd800) << 10) + (text.charCodeAt(++i) - 0xdc00); out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f)); }
            else { out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f)); }
        }
        return new Uint8Array(out);
    }
    inflate(input, start) {
        let pos = start, bit = 0, out = [];
        const lengths = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
        const lengthExtra = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
        const distanceBase = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
        const distanceExtra = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
        const order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
        const bitReader = {
            get: () => { const value = (input[pos] >> bit) & 1; if (++bit === 8) { bit = 0; pos++; } return value; },
            bits: n => { let value = 0; for (let i = 0; i < n; i++) value |= bitReader.get() << i; return value; },
            align: () => { if (bit) { bit = 0; pos++; } }
        };
        const build = lens => {
            const count = new Array(16).fill(0);
            for (const len of lens) count[len]++;
            count[0] = 0;
            const offsets = new Array(16).fill(0);
            for (let len = 1; len < 16; len++) offsets[len + 1] = offsets[len] + count[len];
            const symbol = new Array(lens.length);
            for (let s = 0; s < lens.length; s++) if (lens[s]) symbol[offsets[lens[s]]++] = s;
            return { count, symbol };
        };
        const decode = huffman => {
            let code = 0, first = 0, index = 0;
            for (let len = 1; len <= 15; len++) {
                code |= bitReader.get();
                const count = huffman.count[len];
                if (code - count < first) return huffman.symbol[index + (code - first)];
                index += count; first += count; first <<= 1; code <<= 1;
            }
            throw new Error("Invalid Miruro compression data.");
        };
        const fixed = () => {
            const literal = new Array(288);
            for (let i = 0; i < 144; i++) literal[i] = 8;
            for (let i = 144; i < 256; i++) literal[i] = 9;
            for (let i = 256; i < 280; i++) literal[i] = 7;
            for (let i = 280; i < 288; i++) literal[i] = 8;
            return { literal: build(literal), distance: build(new Array(30).fill(5)), tree: null };
        };
        const dynamic = () => {
            const hlit = bitReader.bits(5) + 257, hdist = bitReader.bits(5) + 1, hclen = bitReader.bits(4) + 4;
            const codeLengths = new Array(19).fill(0);
            for (let i = 0; i < hclen; i++) codeLengths[order[i]] = bitReader.bits(3);
            const codeTree = build(codeLengths);
            const lens = [];
            while (lens.length < hlit + hdist) {
                const symbol = decode(codeTree);
                if (symbol < 16) lens.push(symbol);
                else if (symbol === 16) { const prev = lens[lens.length - 1], rep = 3 + bitReader.bits(2); for (let i = 0; i < rep; i++) lens.push(prev); }
                else if (symbol === 17) { const rep = 3 + bitReader.bits(3); for (let i = 0; i < rep; i++) lens.push(0); }
                else { const rep = 11 + bitReader.bits(7); for (let i = 0; i < rep; i++) lens.push(0); }
            }
            return { literal: build(lens.slice(0, hlit)), distance: build(lens.slice(hlit)), tree: null };
        };
        let last = 0;
        while (!last) {
            last = bitReader.get();
            const type = bitReader.bits(2);
            if (type === 0) {
                bitReader.align();
                const len = input[pos] | (input[pos + 1] << 8); pos += 4;
                for (let i = 0; i < len; i++) out.push(input[pos++]);
            } else if (type === 1 || type === 2) {
                const tree = type === 1 ? fixed() : dynamic();
                for (;;) {
                    const symbol = decode(tree.literal);
                    if (symbol < 256) out.push(symbol);
                    else if (symbol === 256) break;
                    else {
                        const length = lengths[symbol - 257] + bitReader.bits(lengthExtra[symbol - 257]);
                        const dist = decode(tree.distance);
                        const distance = distanceBase[dist] + bitReader.bits(distanceExtra[dist]);
                        for (let i = 0; i < length; i++) out.push(out[out.length - distance]);
                    }
                }
            } else { throw new Error("Invalid Miruro compression block."); }
        }
        return new Uint8Array(out);
    }
}
