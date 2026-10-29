const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const zlib = require('node:zlib');
const path = require('node:path');
const code = fs.readFileSync(path.join(__dirname, '../provider.js'), 'utf8');
function provider(fetch = async () => { throw Error('unexpected request'); }) {
    const context = vm.createContext({ fetch, Uint8Array });
    return vm.runInContext(code + '\nnew Provider()', context);
}
const KEY = Buffer.from('miruro/catalog');
function xor(bytes) { const out = Buffer.alloc(bytes.length); for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ KEY[i % KEY.length]; return out; }
function octet(json) {
    const body = xor(zlib.gzipSync(Buffer.from(JSON.stringify(json))));
    return { ok: true, status: 200, headers: { get: () => 'application/octet-stream' }, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
}
const jsonResponse = body => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body });
const playItem = {
    tracks: [
        { track: 'sub', providers: [
            { provider: 'icarus', servers: [{ server: 'sun-1', headers: { referer: 'https://icarus.example/' }, streams: [{ url: 'https://media.example/icarus/master.m3u8', quality: '1080', format: 'hls' }, { url: 'https://media.example/icarus/embed', format: 'embed', embed: true }], subtitles: [{ file: 'https://media.example/icarus/en.vtt', label: 'English', default: true }, { file: 'https://media.example/icarus/en-forced.vtt', label: 'English Forced (signs & songs)' }] }] },
            { provider: 'anikoto', servers: [{ server: 'bee-1', streams: [{ url: 'https://media.example/anikoto/sub/master.m3u8', quality: '720', format: 'hls' }] }] }
        ] },
        { track: 'dub', providers: [
            { provider: 'anikoto', servers: [{ server: 'bee-2', streams: [{ url: 'https://media.example/anikoto/dub/master.m3u8', quality: '720', format: 'hls' }] }] }
        ] }
    ]
};
const episode = (p, mode = 'sub', number = 1) => ({ id: p.encode({ id: 177937, mode, number }), number, url: 'https://www.miruro.cx/watch/177937' });

test('search paginates by cursor, unwraps data, retains metadata and isolates sub/dub IDs', async () => {
    const calls = [];
    const p = provider(async url => {
        calls.push(url);
        const cursor = decodeURIComponent(url.split('cursor=')[1] || '');
        const first = !cursor;
        return jsonResponse({ data: [{ id: first ? 'anime-2' : 'anime-5', title: { english: 'Example', native: '例' }, external_ids: { anilist: [first ? '140960' : '5'] }, cover_url: 'https://img.example/c.jpg' }], has_more: first, next_cursor: first ? 'c2' : undefined });
    });
    const sub = await p.search({ query: 'Example', dub: false, media: { id: 2 }, year: 2025 });
    const dub = await p.search({ query: 'Example', dub: true });
    assert.equal(sub.length, 2); assert.equal(dub.length, 2);
    assert.equal(p.decode(sub[0].id).mode, 'sub'); assert.equal(p.decode(dub[0].id).mode, 'dub');
    assert.notEqual(sub[0].id, dub[0].id);
    assert.equal(sub[0].metadata.anilistId, 140960);
    assert.equal(sub[0].metadata.coverImage, 'https://img.example/c.jpg');
    assert.match(calls[0], /q=Example/); assert.match(calls[0], /season_year=2025/);
});

test('search returns empty without a query and never requests', async () => {
    const p = provider();
    assert.equal((await p.search({ media: {} })).length, 0);
});

test('episodes unwrap data, drop duplicates/invalid numbers and sort', async () => {
    const p = provider(async () => jsonResponse({ data: [{ episode_number: 2 }, { episode_number: 1, title: 'Start' }, { episode_number: 1 }, { episode_number: 1.5 }] }));
    const eps = await p.findEpisodes(p.encode({ id: 177937, mode: 'sub' }));
    assert.deepEqual(Array.from(eps, e => e.number), [1, 2]);
    assert.equal(eps[0].title, 'Start');
});

test('play decodes XOR+gzip and returns the sub track with real URLs and referer headers', async () => {
    const p = provider(async url => /\/play$/.test(url) ? octet(playItem) : jsonResponse({ data: [] }));
    const result = await p.findEpisodeServer(episode(p, 'sub'), 'Auto');
    assert.equal(result.server, 'Icarus · sub');
    assert.equal(result.headers.Referer, 'https://icarus.example/');
    assert.equal(result.videoSources.length, 1);
    assert.equal(result.videoSources[0].url, 'https://media.example/icarus/master.m3u8');
    assert.equal(result.videoSources[0].type, 'm3u8');
    assert.ok(result.videoSources[0].subtitles.length >= 1);
});

test('dub selection resolves the dub track and never crosses into sub', async () => {
    const p = provider(async () => octet(playItem));
    const result = await p.findEpisodeServer(episode(p, 'dub'), 'Auto');
    assert.equal(result.server, 'Anikoto · dub');
    assert.equal(result.videoSources[0].url, 'https://media.example/anikoto/dub/master.m3u8');
});

test('explicit server filters providers, embeds are skipped, unknown servers rejected', async () => {
    const p = provider(async () => octet(playItem));
    const result = await p.findEpisodeServer(episode(p, 'sub'), 'Anikoto');
    assert.equal(result.server, 'Anikoto · sub');
    assert.equal(result.videoSources[0].url, 'https://media.example/anikoto/sub/master.m3u8');
    await assert.rejects(p.findEpisodeServer(episode(p, 'sub'), 'Nope'), /Unknown Miruro server/);
});

test('subtitle tracks keep full vs forced distinct with stable ids', () => {
    const p = provider();
    const subtitles = p.subtitles([{ file: 'https://m.example/full.vtt', label: 'English', default: true }, { file: 'https://m.example/forced.vtt', label: 'English Forced (signs & songs)' }, { file: 'https://m.example/full.vtt', label: 'English' }, { file: 'https://m.example/thumbs.jpg' }], 'Icarus', 'sub');
    assert.equal(subtitles.length, 2);
    assert.equal(new Set(subtitles.map(s => s.id)).size, 2);
    assert.equal(subtitles[0].isDefault, true);
    assert.equal(subtitles[1].language, 'English Forced (signs & songs)');
});

test('a rejected catalogue request is surfaced as an explicit error', async () => {
    const p = provider(async () => ({ ok: false, status: 400, headers: { get: () => 'application/json' }, json: async () => ({ title: 'Bad Request', detail: 'Unsupported catalog request.' }) }));
    await assert.rejects(p.search({ query: 'Example' }), /rejected the request.*Unsupported catalog request/);
});

test('invalid ids and non-octet responses fail explicitly', () => {
    const p = provider();
    assert.throws(() => p.decode('not-json'), /Invalid Miruro ID/);
    assert.throws(() => p.decode(encodeURIComponent(JSON.stringify({ mode: 'sub' }))), /Invalid Miruro selection/);
});

test('catalogue lists served as octet-stream are decoded like play responses', async () => {
    const p = provider(async () => octet({ data: [{ id: 'anime-9', title: { english: 'Encoded' }, external_ids: { anilist: ['99'] } }], has_more: false }));
    const results = await p.search({ query: 'Encoded' });
    assert.equal(results.length, 1);
    assert.equal(results[0].title, 'Encoded');
    assert.equal(p.decode(results[0].id).id, 'anime-9');
});

test('decode output round-trips through a real gzip stream', () => {
    const p = provider();
    const payload = { tracks: [{ track: 'ssub', providers: [] }], note: 'héllo — 日本語' };
    const bytes = xor(zlib.gzipSync(Buffer.from(JSON.stringify(payload))));
    const text = p.utf8(p.gunzip(p.xor(new Uint8Array(bytes), p.key())));
    assert.equal(text, JSON.stringify(payload));
});

test('manifest references this repository and a loadable Provider payload', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../Manifest.json')));
    assert.equal(manifest.type, 'onlinestream-provider'); assert.equal(manifest.language, 'javascript');
    assert.equal(manifest.payloadURI, 'https://raw.githubusercontent.com/DefnoJae/Miruro-V2/main/provider.js');
    assert.equal(provider().getSettings().supportsDub, true);
    assert.ok(provider().getSettings().episodeServers.includes('Auto'));
});

function seanimeOctet(value, headerOnly = false) {
    const body = Array.from(xor(zlib.gzipSync(Buffer.from(JSON.stringify(value)))));
    return { ok: true, status: 200, ...(headerOnly ? {} : { contentType: 'application/octet-stream' }),
        headers: { 'Content-Type': 'application/octet-stream' }, body,
        json: () => null, text: () => { throw Error('binary text must not be used'); } };
}

test('Seanime raw-byte responses support search, episodes and playback', async () => {
    const p = provider(async (url, options) => {
        assert.equal(options.noCloudflareBypass, true);
        if (/\/play$/.test(url)) return seanimeOctet(playItem);
        if (url.includes('/episodes?')) return seanimeOctet({ data: [{ episode_number: 1 }] });
        assert.match(url, /season_year=2021/);
        return seanimeOctet({ data: [{ id: 'douki', title: 'Ganbare, Douki-chan', external_ids: { anilist: ['137877'] } }], has_more: false });
    });
    const results = await p.search({ query: 'Ganbare, Douki-chan', year: 2021, media: { id: 137877 } });
    assert.equal(results.length, 1);
    assert.equal(results[0].metadata.anilistId, 137877);
    const episodes = await p.findEpisodes(results[0].id);
    assert.equal(episodes.length, 1);
    assert.equal((await p.findEpisodeServer(episodes[0], 'Auto')).videoSources.length, 1);
});

test('header maps decode binary without contentType and match names case-insensitively', async () => {
    const p = provider(async () => seanimeOctet({ data: [{ id: '9', title: 'Encoded' }] }, true));
    assert.equal((await p.search({ query: 'Encoded' })).length, 1);
    assert.equal(p.contentType({ headers: { 'cOnTeNt-TyPe': 'application/json' } }), 'application/json');
});

test('invalid catalogue bodies fail explicitly while an empty list remains valid', async () => {
    const p = provider();
    await assert.rejects(p.body({ status: 200, contentType: 'text/html' }), /returned HTML/);
    await assert.rejects(p.body({ status: 200, contentType: 'application/json', json: () => null }), /invalid catalogue JSON/);
    await assert.rejects(p.bytes({ text: () => 'unsafe' }), /requires raw bytes/);
    await assert.rejects(provider(async () => jsonResponse({ unexpected: [] })).search({ query: 'Example' }), /search response shape/);
    assert.equal((await provider(async () => jsonResponse({ data: [] })).search({ query: 'Example' })).length, 0);
});


test('HTTP 403 stops without bypass or mirror retries and preserves the Goja error message', async () => {
    let calls = 0;
    const p = provider(async (url, options) => {
        calls++;
        assert.equal(options.noCloudflareBypass, true);
        return { ok: false, status: 403, contentType: 'application/json', json: () => ({ detail: 'Blocked' }) };
    });
    await assert.rejects(p.search({query: 'Overgeared', year: 2026}), error => {
        const exported = JSON.parse(JSON.stringify(error));
        assert.match(exported.message, /Miruro search:.*HTTP 403 Blocked/);
        return true;
    });
    assert.equal(calls, 1);
});

test('transport rejections retain string and object reasons in exported errors', async () => {
    for (const rejection of ['DNS unavailable', {message: 'TLS connection failed'}]) {
        const p = provider(async (url, options) => {
            assert.equal(options.noCloudflareBypass, true);
            throw rejection;
        });
        await assert.rejects(p.search({query: 'Overgeared'}), error => {
            assert.match(JSON.parse(JSON.stringify(error)).message, /transport error: (DNS unavailable|TLS connection failed)/);
            return true;
        });
    }
});

test('decode failures remain readable at the public search boundary', async () => {
    const p = provider(async () => ({ok:true,status:200,contentType:'application/json',json:()=>{throw new SyntaxError('Malformed JSON');}}));
    await assert.rejects(p.search({query:'Example'}), error => {
        assert.match(JSON.parse(JSON.stringify(error)).message, /Miruro search: Malformed JSON/);
        return true;
    });
});

test('HTTP 400 and rate limiting are terminal', async () => {
    for (const status of [400,429]) {
        let calls=0;
        const p = provider(async () => { calls++; return {ok:false,status,contentType:'application/json',json:()=>({detail:'Rejected'})}; });
        await assert.rejects(p.search({query:'Example'}), new RegExp('HTTP '+status));
        assert.equal(calls,1);
    }
});

test('uses the primary domain without www for requests, headers and watch URLs', async () => {
    const p = provider(async (url, options) => {
        assert.equal(new URL(url).origin, 'https://miruro.cx');
        assert.equal(options.headers.Origin, 'https://miruro.cx');
        assert.equal(options.headers.Referer, 'https://miruro.cx/');
        assert.equal(options.noCloudflareBypass, true);
        return jsonResponse({data:[{id:'test',title:'Example'}]});
    });
    const results = await p.search({query:'Example'});
    assert.equal(results[0].url, 'https://miruro.cx/watch/test');
    assert.equal(JSON.parse(fs.readFileSync(path.join(__dirname,'../Manifest.json'))).website, 'https://miruro.cx/');
});
