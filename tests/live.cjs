// Optional network integration check; never downloads a video segment.
// Miruro's catalogue API is behind Cloudflare bot management, so this check is
// expected to SKIP (not fail) from hosts that Cloudflare does not trust.
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
const runtimeFetch = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout((options.timeout || 20) * 1000) });
const context = vm.createContext({ fetch: runtimeFetch, Uint8Array });
const p = vm.runInContext(fs.readFileSync(path.join(__dirname, '../provider.js'), 'utf8') + '\nnew Provider()', context);
const ANILIST_ID = 140960;
function skip(error) {
    if (/rejected the request|Cloudflare|HTTP 40[03]/.test(error.message)) {
        console.log('SKIP: Miruro rejected the request from this host: ' + error.message);
        process.exit(0);
    }
    throw error;
}
// A provider may front several CDNs and only some are reachable from any given
// host, so probe each returned source until one serves a playlist.
async function reachable(server) {
    for (const source of server.videoSources) {
        try {
            const response = await runtimeFetch(source.url, { headers: server.headers });
            if (!response.ok) continue;
            const body = await response.text();
            if (/^#EXTM3U/.test(body)) return { source, hls: true };
            if (source.type === 'mp4' || /video\//.test(response.headers.get('content-type') || '')) return { source, hls: false };
        } catch { /* try the next source */ }
    }
    return null;
}
(async () => {
    for (const dub of [false, true]) {
        let results;
        try { results = await p.search({ query: 'spy family', dub, media: { id: ANILIST_ID } }); }
        catch (error) { skip(error); }
        const show = results.find(r => r.metadata && r.metadata.anilistId === ANILIST_ID) || results[0];
        assert.ok(show, 'Search must return results');
        const episodes = await p.findEpisodes(show.id);
        assert.ok(episodes.length, 'Episode listing must not be empty');
        let resolved = null;
        for (const name of ['Auto', 'Anikoto', 'Icarus', 'KickAssAnime']) {
            const server = await p.findEpisodeServer(episodes[0], name);
            assert.ok(server.videoSources.length, name + ' resolver must return media');
            const hit = await reachable(server);
            if (hit) { resolved = { name, ...hit }; break; }
        }
        assert.ok(resolved, 'At least one returned source must serve a playlist from this host');
        const subtitleTracks = resolved.source.subtitles.length;
        console.log((dub ? 'Dub' : 'Sub') + ': search (' + results.length + '), episodes (' + episodes.length + '), resolved via ' + resolved.name +
            ', ' + (resolved.hls ? 'HLS master' : 'MP4') + ' reachable, ' + subtitleTracks + ' subtitle tracks');
    }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
