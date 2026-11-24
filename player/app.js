/* HI-FI WEB PLAYER — app.js (zero-build, sem chaves pagas).
   Regras: nunca roteia o <audio> pelo grafo WebAudio; textContent para dados remotos; IIFE estrita. */
(function () {
  "use strict";

  /* =====================================================================
     1. HELPERS
  ===================================================================== */
  const $ = (id) => document.getElementById(id);
  const CUR_YEAR = new Date().getFullYear();
  const enc = encodeURIComponent;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const noop = function () {};

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function norm(s) {
    return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9\u0370-\u03ff\u0400-\u04ff\u0600-\u06ff\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af ]+/g, " ")
      .replace(/\s+/g, " ").trim();
  }

  /* remove hífens/travessões e operadores Lucene antes de chamar APIs */
  function sanitize(s) {
    return String(s || "").normalize("NFC")
      .replace(/&&|\|\||[-\u2013\u2014+!(){}\[\]^"~*?:\\\/]/g, " ")
      .replace(/\s+/g, " ").trim();
  }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  function hashStr(s) {
    let x = 0;
    for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) >>> 0;
    return x;
  }

  function safeUrl(u) {
    try {
      const x = new URL(String(u).trim());
      if (x.protocol !== "http:" && x.protocol !== "https:") return null;
      if (x.protocol === "http:" && /(archive\.org|wikimedia\.org|wikipedia\.org|audius\.co)$/.test(x.hostname)) x.protocol = "https:";
      return x.href;
    } catch (e) { return null; }
  }

  function htmlToText(s) {
    try { return (new DOMParser().parseFromString(String(s || ""), "text/html").documentElement.textContent || "").trim(); }
    catch (e) { return String(s || ""); }
  }

  const EXT_PLAY = ["mp3", "m4a", "aac", "flac", "ogg", "oga", "opus", "wav", "webm", "mp4", "3gp", "mkv", "avi"];
  const EXT_LEGACY = ["wma", "rma", "rm", "rmvb", "rmv", "ram"];
  const EXT_ALL = EXT_PLAY.concat(EXT_LEGACY);
  const PREVIEW_RE = /(preview|sample|snippet|[_\-. ]30s\b|\/clips?\/|previews?\.)/i;
  const MIN_DUR = 45;

  function extOf(u) {
    const m = String(u || "").split(/[?#]/)[0].match(/\.([a-z0-9]{2,4})$/i);
    return m ? m[1].toLowerCase() : "";
  }

  function parseDur(v) {
    if (v == null || v === "") return null;
    if (typeof v === "number") return isFinite(v) && v > 0 ? v : null;
    const s = String(v);
    if (s.indexOf(":") > -1) {
      const p = s.split(":").map(Number);
      if (p.some(isNaN)) return null;
      return p.reduce((a, b) => a * 60 + b, 0) || null;
    }
    const n = parseFloat(s);
    return isFinite(n) && n > 0 ? n : null;
  }

  const STOP = new Set(("a o as os um uma de da do das dos em no na nos nas e y the of to and in on la el los las le les il lo un une que se te me por para com").split(" "));

  function tokens(s) {
    const all = norm(s).split(" ").filter(Boolean);
    const t = all.filter((w) => !STOP.has(w) && w.length > 1);
    return t.length ? t : all;
  }

  /* similaridade para sugestões (Dice de bigramas + Levenshtein) */
  function bigrams(s) { s = s.replace(/ /g, ""); const a = []; for (let i = 0; i < s.length - 1; i++) a.push(s.substr(i, 2)); return a; }
  function dice(a, b) {
    if (a === b) return 1;
    const x = bigrams(a), y = bigrams(b);
    if (!x.length || !y.length) return 0;
    const m = new Map();
    x.forEach((g) => m.set(g, (m.get(g) || 0) + 1));
    let hit = 0;
    y.forEach((g) => { const c = m.get(g); if (c > 0) { hit++; m.set(g, c - 1); } });
    return (2 * hit) / (x.length + y.length);
  }
  function lev(a, b) {
    const dp = [];
    for (let i = 0; i <= a.length; i++) dp[i] = [i];
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return dp[a.length][b.length];
  }
  function similarity(a, b) {
    const na = norm(a), nb = norm(b);
    if (!na || !nb) return 0;
    let s = Math.max(dice(na, nb), 1 - lev(na, nb) / Math.max(na.length, nb.length));
    if (Math.min(na.length, nb.length) >= 3 && (nb.indexOf(na) === 0 || na.indexOf(nb) === 0)) s = Math.max(s, 0.7);
    return s;
  }

  /* =====================================================================
     2. REDE (timeout 8s, JSONP com fallback fetch, fila MusicBrainz)
  ===================================================================== */
  function fetchJSON(url, ms) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms || 8000);
    return fetch(url, { signal: ac.signal })
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .finally(() => clearTimeout(t));
  }
  function fetchText(url, ms) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms || 8000);
    return fetch(url, { signal: ac.signal })
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
      .finally(() => clearTimeout(t));
  }
  let jpN = 0;
  function jsonp(url, param, ms) {
    return new Promise((resolve, reject) => {
      const name = "__jp_" + Date.now().toString(36) + "_" + (jpN++);
      const s = document.createElement("script");
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; window[name] = noop; s.remove(); reject(new Error("timeout")); } }, ms || 8000);
      window[name] = function (d) { if (done) return; done = true; clearTimeout(t); s.remove(); delete window[name]; resolve(d); };
      s.onerror = function () { if (!done) { done = true; clearTimeout(t); window[name] = noop; s.remove(); reject(new Error("jsonp")); } };
      s.src = url + (url.indexOf("?") > -1 ? "&" : "?") + (param || "callback") + "=" + name;
      document.head.appendChild(s);
    });
  }
  /* opts.jp = nome do parâmetro JSONP; opts.fb = sufixo para o fallback fetch */
  async function getJSON(url, opts) {
    opts = opts || {};
    if (opts.jp) { try { return await jsonp(url, opts.jp, opts.ms); } catch (e) { /* tenta fetch */ } }
    return fetchJSON(url + (opts.fb || ""), opts.ms);
  }

  let mbChain = Promise.resolve(), mbLast = 0;
  function mb(path) {
    const run = () => {
      const wait = Math.max(0, 1100 - (Date.now() - mbLast));
      return new Promise((r) => setTimeout(r, wait)).then(() => {
        mbLast = Date.now();
        return fetchJSON("https://musicbrainz.org/ws/2/" + path + (path.indexOf("?") > -1 ? "&" : "?") + "fmt=json");
      });
    };
    const p = mbChain.then(run, run);
    mbChain = p.catch(noop);
    return p;
  }

  const memo = new Map();
  function memoize(key, fn) {
    if (!memo.has(key)) memo.set(key, fn().catch((e) => { memo.delete(key); throw e; }));
    return memo.get(key);
  }

  /* =====================================================================
     3. ESTADO
  ===================================================================== */
  const audio = $("audio");
  const S = {
    token: 0, artist: "", aliases: new Set(), mbid: null, confirmed: "",
    song: "", toks: [], mbRecs: [], lyricTitles: [], refDur: null, lrTitles: [],
    results: [], current: null, collapsed: false, busy: false,
    style: "auto", autoStyle: 3, genre: "", hue1: 255, hue2: 190,
    embedActive: false, enrichToken: 0, m3u: [], remaining: false
  };

  function artistMatches(name) { return !!name && S.aliases.has(norm(name)); }
  function sameArtist(a, b) { return norm(a) === norm(b) || similarity(a, b) >= 0.85; }

  function setStatus(msg, kind) {
    const el = $("statusBar");
    el.textContent = msg; el.title = msg; el.dataset.kind = kind || "";
  }
  function setArtistStatus(msg, kind) {
    const el = $("artistStatus");
    el.textContent = msg; el.title = msg;
    el.className = "statusline" + (kind ? " " + kind : "");
  }

  /* =====================================================================
     4. VERIFICAÇÃO DO NOME EXATO DO ARTISTA
  ===================================================================== */
  async function verifyArtist(input) {
    const q = sanitize(input), n = norm(input);
    const res = await Promise.allSettled([
      mb("artist/?query=" + enc('artist:"' + q + '" OR alias:"' + q + '"') + "&limit=10"),
      getJSON("https://itunes.apple.com/search?media=music&entity=musicArtist&limit=10&term=" + enc(q), { jp: "callback" }),
      getJSON("https://api.deezer.com/search/artist?limit=10&output=jsonp&q=" + enc(q), { jp: "callback" })
    ]);
    const cands = [];
    let ok = 0;
    if (res[0].status === "fulfilled") {
      ok++;
      (res[0].value.artists || []).forEach((a) => cands.push({
        name: a.name, aliases: (a.aliases || []).map((x) => x.name), score: a.score || 0, mbid: a.id, src: "MusicBrainz"
      }));
    }
    if (res[1].status === "fulfilled") {
      ok++;
      (res[1].value.results || []).forEach((a) => a.artistName && cands.push({ name: a.artistName, aliases: [], score: 0, mbid: null, src: "iTunes" }));
    }
    if (res[2].status === "fulfilled") {
      ok++;
      (res[2].value.data || []).forEach((a) => a.name && cands.push({ name: a.name, aliases: [], score: 0, mbid: null, src: "Deezer" }));
    }
    if (!ok) return { netFail: true, hit: null, sugg: [] };

    const eq = (c) => norm(c.name) === n || c.aliases.some((x) => norm(x) === n);
    const exact = cands.filter(eq);
    const mbExact = exact.filter((c) => c.src === "MusicBrainz").sort((a, b) => b.score - a.score);
    const srcs = new Set(exact.map((c) => c.src));
    let hit = null;
    if (mbExact.length && mbExact[0].score >= 90) hit = mbExact[0];
    else if (srcs.size >= 2) hit = mbExact[0] || exact[0];
    else if (S.confirmed === n && exact.length) hit = mbExact[0] || exact[0];

    let sugg = [];
    if (!hit) {
      const seen = new Set();
      cands.forEach((c) => {
        const k = norm(c.name);
        if (!k || seen.has(k)) return;
        const sim = Math.max(similarity(input, c.name), ...c.aliases.map((a) => similarity(input, a) * 0.95));
        if (sim >= 0.5) { seen.add(k); sugg.push({ name: c.name, sim: sim + (c.src === "MusicBrainz" ? 0.01 : 0) }); }
      });
      sugg.sort((a, b) => b.sim - a.sim);
      sugg = sugg.slice(0, 5);
    } else {
      S.aliases = new Set([norm(hit.name)]);
      hit.aliases.forEach((a) => S.aliases.add(norm(a)));
      exact.forEach((c) => S.aliases.add(norm(c.name)));
      S.aliases.add(n);
    }
    return { netFail: false, hit: hit, sugg: sugg };
  }

  /* =====================================================================
     5. PONTUAÇÃO DE RELEVÂNCIA (título + letra) E FILTRO DE ARTISTA
  ===================================================================== */
  function titleScore(title) {
    const tt = norm(title), st = norm(S.song);
    if (!tt || !st) return 0;
    if (tt === st) return 50;
    const toks = S.toks;
    if (!toks.length) return 0;
    const hits = toks.filter((t) => tt.indexOf(t) > -1).length;
    if (hits === toks.length) return 35;
    if (hits / toks.length >= 0.6) return 20;
    return 0;
  }

  const BAD_VERSION = /\b(live|ao vivo|karaoke|karaok[eê]|instrumental|cover|tribute|tributo|remix|playback|medley)\b/;

  function scoreResult(r) {
    const nt = norm(r.title + " " + (r.extraTitle || ""));
    let sc = titleScore(r.title), byTitle = sc > 0;
    if (!byTitle && r.extraTitle) { const s2 = titleScore(r.extraTitle); if (s2 > 0) { sc = Math.max(sc, s2 - 10); byTitle = true; } }
    let byLyric = false;
    const n = norm(r.title);
    if (S.lyricTitles.some((lt) => lt && (n === lt || (lt.length > 3 && n.indexOf(lt) > -1) || (n.length > 3 && lt.indexOf(n) > -1)))) { sc += 25; byLyric = true; }
    if (r.duration && S.refDur && Math.abs(r.duration - S.refDur) / S.refDur <= 0.1) sc += 10;
    if (r.kind === "audio" || r.kind === "embed") sc += 10;
    if (BAD_VERSION.test(nt) && !BAD_VERSION.test(norm(S.song))) sc -= 30;
    r.score = sc;
    r.badge = byTitle && byLyric ? "Título+Letra" : byLyric ? "Letra" : byTitle ? "Título" : "";
    return sc;
  }

  /* =====================================================================
     6. FONTES DE MÍDIA
  ===================================================================== */
  function cleanTitle(t) {
    return String(t || "").replace(/\.(mp3|m4a|aac|flac|ogg|oga|opus|wav|webm|mp4|3gp|mkv|avi|wma|rma|rm|rmvb|rmv|ram)$/i, "")
      .replace(/_/g, " ").replace(/^\s*\d{1,2}[\s.\-–]+(?=\D)/, "").replace(/\s+/g, " ").trim();
  }
  function splitArtistTitle(str) {
    const m = String(str).match(/^(.{2,70}?)\s+[-\u2013\u2014]\s+(.+)$/);
    return m ? { artist: m[1].trim(), title: m[2].trim() } : null;
  }

  function embedFor(u) {
    let m = u.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
    if (m) return { provider: "YouTube", embedUrl: "https://www.youtube.com/embed/" + m[1] + "?autoplay=1&rel=0", pageUrl: "https://www.youtube.com/watch?v=" + m[1] };
    m = u.match(/^https?:\/\/(?:www\.|m\.)?soundcloud\.com\/[^\s]+/i);
    if (m) return { provider: "SoundCloud", embedUrl: "https://w.soundcloud.com/player/?auto_play=true&url=" + enc(u), pageUrl: u };
    m = u.match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?(track|album|playlist|episode)\/(\w+)/);
    if (m) return { provider: "Spotify", embedUrl: "https://open.spotify.com/embed/" + m[1] + "/" + m[2], pageUrl: u };
    return null;
  }

  function makeResult(raw) {
    const title = cleanTitle(raw.title);
    if (!title) return null;
    const r = {
      title: title, extraTitle: raw.extraTitle || "", artist: raw.artist || "", src: raw.src || "", duration: parseDur(raw.duration),
      cover: raw.cover ? safeUrl(raw.cover) : null, genre: raw.genre || "", year: raw.year || "", live: !!raw.live,
      url: "", embedUrl: "", pageUrl: "", ext: "", kind: "audio", provider: ""
    };
    if (raw.embedUrl) {
      const eu = safeUrl(raw.embedUrl);
      if (!eu) return null;
      r.kind = "embed"; r.embedUrl = eu; r.pageUrl = safeUrl(raw.pageUrl || raw.embedUrl) || eu; r.provider = raw.provider || "Embed"; r.ext = "embed";
    } else {
      const u = safeUrl(raw.url);
      if (!u) return null;
      r.url = u; r.pageUrl = u; r.ext = (raw.ext || extOf(u) || "mp3").toLowerCase();
      if (EXT_LEGACY.indexOf(r.ext) > -1) r.kind = "legacy";
    }
    return r;
  }

  /* finaliza resultados de busca: filtro de artista + anti-sample */
  function finalize(raw) {
    let title = String(raw.title || "").trim();
    if (!title) return null;
    const artists = (raw.artists || []).filter(Boolean);
    const sp = splitArtistTitle(cleanTitle(title));
    if (sp && artistMatches(sp.artist)) { artists.push(sp.artist); title = sp.title; }
    if (!artists.some((a) => artistMatches(a))) return null;
    raw.title = title; raw.artist = S.artist;
    const r = makeResult(raw);
    if (!r) return null;
    if (PREVIEW_RE.test(r.url + " " + r.title) && !r.embedUrl) return null;
    if (r.duration && !r.live && r.duration < MIN_DUR) return null;
    return r;
  }

  async function srcAudius(q) {
    const d = await getJSON("https://api.audius.co/v1/tracks/search?app_name=HiFiWebPlayer&limit=20&query=" + enc(S.artist + " " + q));
    return (d.data || []).map((t) => ({
      title: t.title, artists: [t.user && t.user.name], src: "Audius", ext: "mp3", duration: t.duration, genre: t.genre,
      cover: t.artwork && (t.artwork["480x480"] || t.artwork["150x150"]),
      url: "https://api.audius.co/v1/tracks/" + t.id + "/stream?app_name=HiFiWebPlayer"
    }));
  }

  async function iaFiles(id, doc) {
    const d = await fetchJSON("https://archive.org/metadata/" + enc(id));
    const md = d.metadata || {};
    const creators = [].concat(md.creator || doc.creator || []);
    const out = [];
    (d.files || []).forEach((f) => {
      const ext = extOf(f.name);
      if (EXT_ALL.indexOf(ext) < 0 || /thumb|sample|preview/i.test(f.name)) return;
      const path = String(f.name).split("/").map(enc).join("/");
      out.push({
        title: f.title || f.name.split("/").pop(), extraTitle: [].concat(md.title || "").join(" "),
        artists: [].concat(f.creator || [], creators), ext: ext, duration: f.length,
        url: "https://archive.org/download/" + enc(id) + "/" + path, src: "Internet Archive",
        cover: "https://archive.org/services/img/" + enc(id)
      });
    });
    return out;
  }

  async function srcIA(q) {
    const base = "https://archive.org/advancedsearch.php?fl%5B%5D=identifier&fl%5B%5D=creator&fl%5B%5D=title&rows=12&output=json&q=";
    const a = S.artist;
    let docs = [];
    const qs = [
      'creator:("' + a + '") AND mediatype:(audio OR movies) AND (title:(' + q + ') OR description:(' + q + ') OR subject:(' + q + '))',
      'creator:("' + a + '") AND mediatype:(audio OR movies)'
    ];
    for (let i = 0; i < qs.length && !docs.length; i++) {
      try {
        const d = await getJSON(base + enc(qs[i]), { jp: "callback" });
        docs = ((d.response && d.response.docs) || []).filter((x) => [].concat(x.creator || []).some(artistMatches));
      } catch (e) { /* próxima */ }
    }
    const lists = await Promise.allSettled(docs.slice(0, 8).map((x) => iaFiles(x.identifier, x)));
    return lists.flatMap((l) => (l.status === "fulfilled" ? l.value : []));
  }

  function parseM3U(text, base) {
    const out = [];
    let info = null;
    String(text).split(/\r?\n/).forEach((line) => {
      line = line.trim();
      if (!line) return;
      if (line.indexOf("#EXTINF:") === 0) {
        const m = line.match(/^#EXTINF:(-?[\d.]+)[^,]*,(.*)$/);
        info = m ? { dur: parseFloat(m[1]), name: m[2].trim() } : null;
        return;
      }
      if (line[0] === "#") return;
      let u;
      try { u = new URL(line, base).href; } catch (e) { return; }
      out.push({ url: u, info: info });
      info = null;
    });
    return out;
  }

  async function srcIAm3u() {
    const q = '("' + S.artist + '") AND (format:(M3U) OR format:("VBR M3U") OR format:("64Kbps M3U"))';
    const d = await getJSON("https://archive.org/advancedsearch.php?fl%5B%5D=identifier&fl%5B%5D=creator&rows=6&output=json&q=" + enc(q), { jp: "callback" });
    const docs = (d.response && d.response.docs) || [];
    const out = [];
    await Promise.allSettled(docs.map(async (doc) => {
      const md = await fetchJSON("https://archive.org/metadata/" + enc(doc.identifier));
      const f = (md.files || []).find((x) => /\.m3u8?$/i.test(x.name));
      if (!f) return;
      const base = "https://archive.org/download/" + enc(doc.identifier) + "/" + String(f.name).split("/").map(enc).join("/");
      const txt = await fetchText(base);
      parseM3U(txt, base).forEach((e) => {
        const nm = e.info ? e.info.name : "";
        const sp = splitArtistTitle(nm);
        out.push({ title: sp ? sp.title : (nm || e.url.split("/").pop()), artists: sp ? [sp.artist] : [].concat(doc.creator || []),
          url: e.url, duration: e.info && e.info.dur > 0 ? e.info.dur : null, src: "M3U (Internet Archive)" });
      });
    }));
    return out;
  }

  async function srcCommons(q) {
    const url = "https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=20&gsrsearch=" +
      enc("filetype:audio|video " + S.artist + " " + q) + "&prop=imageinfo&iiprop=url%7Cmime%7Cextmetadata&iiextmetadatafilter=Artist%7CObjectName";
    const d = await getJSON(url, { jp: "callback", fb: "&origin=*" });
    const pages = (d.query && d.query.pages) || {};
    return Object.keys(pages).map((k) => {
      const p = pages[k], ii = p.imageinfo && p.imageinfo[0];
      if (!ii) return null;
      const em = ii.extmetadata || {};
      const title = String(p.title || "").replace(/^File:/i, "");
      return { title: title, artists: [htmlToText(em.Artist && em.Artist.value)], url: ii.url, src: "Wikimedia Commons", ext: extOf(ii.url) };
    }).filter(Boolean).filter((x) => EXT_ALL.indexOf(x.ext) > -1);
  }

  async function srcMBRels() {
    const out = [];
    const recs = S.mbRecs.slice(0, 3);
    for (let i = 0; i < recs.length; i++) {
      try {
        const d = await mb("recording/" + recs[i].id + "?inc=url-rels");
        (d.relations || []).forEach((rel) => {
          const u = rel.url && rel.url.resource;
          if (!u) return;
          const emb = embedFor(u);
          const base = { title: recs[i].title, artists: [S.artist], src: "MusicBrainz", duration: recs[i].length ? recs[i].length / 1000 : null };
          if (emb) out.push(Object.assign({}, base, emb));
          else if (EXT_ALL.indexOf(extOf(u)) > -1) out.push(Object.assign({}, base, { url: u }));
        });
      } catch (e) { /* ignora */ }
    }
    return out;
  }

  async function srcRadio() {
    const d = await fetchJSON("https://de1.api.radio-browser.info/json/stations/byname/" + enc(S.artist) + "?limit=10&hidebroken=true");
    return (d || []).filter((s) => norm(s.name).indexOf(norm(S.artist)) > -1 && s.url_resolved)
      .map((s) => ({ title: s.name, artists: [S.artist], url: s.url_resolved, ext: "mp3", src: "Radio-Browser", live: true }));
  }

  /* títulos candidatos: LRCLIB (letra) + MusicBrainz (gravações) */
  async function gatherTitles(song) {
    const A = S.artist;
    const reqs = [
      getJSON("https://lrclib.net/api/search?track_name=" + enc(song) + "&artist_name=" + enc(A)),
      getJSON("https://lrclib.net/api/search?q=" + enc(A + " " + song)),
      getJSON("https://lrclib.net/api/search?q=" + enc(A)),
      mb("recording/?query=" + enc((S.mbid ? "arid:" + S.mbid : 'artist:"' + A + '"') + ' AND recording:"' + song + '"') + "&limit=15")
    ];
    const r = await Promise.allSettled(reqs);
    const lr = [r[0], r[1], r[2]].flatMap((x) => (x.status === "fulfilled" && Array.isArray(x.value) ? x.value : []))
      .filter((it) => artistMatches(it.artistName));
    const ns = norm(song);
    const map = new Map();
    lr.forEach((it) => {
      const nl = norm(it.plainLyrics || "");
      let lyric = false;
      if (nl) {
        if (nl.indexOf(ns) > -1) lyric = true;
        else if (S.toks.length > 1) lyric = S.toks.filter((t) => nl.indexOf(t) > -1).length / S.toks.length >= 0.6;
        else if (S.toks.length === 1) lyric = (" " + nl + " ").indexOf(" " + S.toks[0] + " ") > -1;
      }
      const k = norm(it.trackName);
      if (!k) return;
      const cur = map.get(k) || { title: it.trackName, lyric: false, dur: null, tScore: titleScore(it.trackName) };
      cur.lyric = cur.lyric || lyric;
      cur.dur = cur.dur || it.duration || null;
      map.set(k, cur);
    });
    S.lrTitles = Array.from(map.values()).map((x) => x.title);
    S.mbRecs = [];
    if (r[3].status === "fulfilled") {
      (r[3].value.recordings || []).forEach((rec) => {
        const okArtist = S.mbid || (rec["artist-credit"] || []).some((c) => artistMatches(c.name || (c.artist && c.artist.name)));
        if (!okArtist) return;
        S.mbRecs.push({ id: rec.id, title: rec.title, length: rec.length || null });
        const k = norm(rec.title);
        const cur = map.get(k) || { title: rec.title, lyric: false, dur: null, tScore: titleScore(rec.title) };
        cur.dur = cur.dur || (rec.length ? rec.length / 1000 : null);
        map.set(k, cur);
      });
    }
    const all = Array.from(map.values());
    S.lyricTitles = all.filter((x) => x.lyric).map((x) => norm(x.title)).slice(0, 8);
    const chosen = all.filter((x) => x.lyric || x.tScore >= 35)
      .sort((a, b) => (b.lyric ? 40 : 0) + b.tScore - ((a.lyric ? 40 : 0) + a.tScore)).slice(0, 3);
    const ref = chosen.find((x) => x.dur);
    S.refDur = ref ? ref.dur : null;
    const queries = [song];
    chosen.forEach((c) => { const q = sanitize(c.title); if (q && queries.map(norm).indexOf(norm(q)) < 0) queries.push(q); });
    return queries.slice(0, 4);
  }

  /* =====================================================================
     7. FLUXO DE BUSCA + RENDER
  ===================================================================== */
  function setBusy(b) {
    S.busy = b;
    $("btnSearch").disabled = b;
    $("btnSearch").textContent = b ? "Buscando…" : "Buscar";
  }
  function setFormMsg(m) { $("formMsg").textContent = m || ""; $("formMsg").title = m || ""; }

  function setCollapsed(c) {
    S.collapsed = c;
    $("resultsPanel").classList.toggle("collapsed", c);
    $("resultsBody").hidden = c;
    const b = $("btnToggleResults");
    b.hidden = !S.results.length;
    b.textContent = c ? "Expandir resultados (" + S.results.length + ")" : "Recolher lista";
  }

  function updateActiveBar() {
    const r = S.current;
    $("activeTitle").textContent = r ? "▶ " + r.title + (r.artist ? " — " + r.artist : "") : "Nenhuma faixa ativa";
  }

  function bodyMessage(lines) {
    const body = $("resultsBody");
    body.textContent = "";
    const box = h("div", "msgbox");
    lines.forEach((l) => box.appendChild(h("p", null, l)));
    body.appendChild(box);
    return box;
  }

  function chipsInto(box, names, onClick) {
    const wrap = h("div", "chips");
    names.forEach((n) => {
      const b = h("button", "btn small", n);
      b.type = "button";
      b.addEventListener("click", () => onClick(n));
      wrap.appendChild(b);
    });
    box.appendChild(wrap);
  }

  function showNotFound(input, sugg) {
    S.results = [];
    $("resultsCount").textContent = "0";
    setCollapsed(false);
    $("btnToggleResults").hidden = true;
    setArtistStatus("✖ Artista não verificado: " + input, "err");
    if (!sugg.length) {
      bodyMessage(["Artista '" + input + "' não encontrado com esse nome exato.", "Nenhuma sugestão encontrada. Verifique a grafia e tente novamente."]);
      return;
    }
    const box = bodyMessage(["Artista '" + input + "' não encontrado com esse nome exato.", "Você quis dizer:"]);
    chipsInto(box, sugg.map((s) => s.name), (n) => {
      S.confirmed = norm(n);
      $("artistInput").value = n;
      doSearch();
    });
    box.lastChild.id = "suggestions";
  }

  function showNoTrack() {
    S.results = [];
    $("resultsCount").textContent = "0";
    $("btnToggleResults").hidden = true;
    setCollapsed(false);
    const box = bodyMessage(["Nenhuma faixa de " + S.artist + " contém '" + $("songInput").value.trim() + "'. Tente outro trecho do título ou da letra."]);
    const seen = new Set(), names = [];
    S.mbRecs.map((x) => x.title).concat(S.lrTitles).forEach((t) => { const k = norm(t); if (k && !seen.has(k) && names.length < 5) { seen.add(k); names.push(t); } });
    const show = (list) => {
      if (!list.length) return;
      box.appendChild(h("p", null, "Sugestões de títulos de " + S.artist + ":"));
      chipsInto(box, list, (t) => { $("songInput").value = t; doSearch(); });
    };
    if (names.length || !S.mbid) { show(names); return; }
    mb("recording/?query=" + enc("arid:" + S.mbid) + "&limit=25").then((d) => {
      (d.recordings || []).forEach((x) => { const k = norm(x.title); if (k && !seen.has(k) && names.length < 5) { seen.add(k); names.push(x.title); } });
      show(names);
    }).catch(noop);
  }

  function renderResults() {
    const body = $("resultsBody");
    body.textContent = "";
    $("resultsCount").textContent = String(S.results.length);
    if (!S.results.length) { body.appendChild(h("p", "empty", "Nenhum resultado.")); return; }
    S.results.forEach((r) => {
      const row = h("div", "res" + (S.current === r ? " active" : ""));
      const info = h("div", "info");
      info.appendChild(h("div", "t", r.title));
      const meta = [r.artist, r.year, r.duration ? fmtTime(r.duration) : r.live ? "ao vivo" : ""].filter(Boolean).join(" · ");
      info.appendChild(h("div", "s", meta || "—"));
      const badges = h("div", "badges");
      if (r.badge) badges.appendChild(h("span", "badge rel", r.badge));
      badges.appendChild(h("span", "badge", r.src));
      badges.appendChild(h("span", "badge" + (r.kind === "legacy" ? " legacy" : ""), r.kind === "embed" ? r.provider : "." + r.ext));
      if (r.kind === "legacy") badges.appendChild(h("span", "badge legacy", "só via .m3u"));
      info.appendChild(badges);
      const act = h("div", "act");
      const bl = h("button", "btn small", r.kind === "legacy" ? "Externo" : "Ouvir");
      bl.type = "button";
      bl.disabled = r.kind === "legacy";
      bl.addEventListener("click", () => playResult(r));
      const bm = h("button", "btn small ghost", "+ M3U");
      bm.type = "button";
      bm.addEventListener("click", () => addToM3U(r));
      act.appendChild(bl); act.appendChild(bm);
      row.appendChild(info); row.appendChild(act);
      body.appendChild(row);
    });
  }

  async function doSearch(ev) {
    if (ev) ev.preventDefault();
    if (S.busy) return;
    const artistRaw = $("artistInput").value.trim();
    const songRaw = $("songInput").value.trim();
    if (artistRaw.length < 2) { setFormMsg("Informe o nome exato do cantor/artista."); $("artistInput").focus(); return; }
    if (sanitize(songRaw).length < 2) { setFormMsg("Informe o título ou um trecho da música (mín. 2 caracteres)."); $("songInput").focus(); return; }
    setFormMsg("");
    const tk = ++S.token;
    setBusy(true);
    S.results = []; S.current = null; updateActiveBar();
    $("btnToggleResults").hidden = true;
    setCollapsed(false);
    setArtistStatus("Verificando artista nas bases MusicBrainz, iTunes e Deezer…");
    bodyMessage(["Verificando o nome exato do artista…"]);
    try {
      const ver = await verifyArtist(artistRaw);
      if (tk !== S.token) return;
      if (ver.netFail) {
        setArtistStatus("Não foi possível verificar o artista agora.", "err");
        bodyMessage(["Não foi possível verificar o artista agora (sem conexão com as bases de dados). Tente novamente."]);
        return;
      }
      if (!ver.hit) { showNotFound(artistRaw, ver.sugg); return; }
      S.artist = ver.hit.name; S.mbid = ver.hit.mbid || null; S.confirmed = "";
      S.song = sanitize(songRaw); S.toks = tokens(S.song);
      $("artistInput").value = S.artist;
      setArtistStatus("✔ Artista verificado: " + S.artist, "ok");
      bodyMessage(["Buscando faixas de " + S.artist + " com “" + S.song + "”…"]);

      const queries = await gatherTitles(S.song);
      if (tk !== S.token) return;
      const jobs = [];
      queries.forEach((q) => { jobs.push(srcAudius(q), srcIA(q), srcCommons(q)); });
      jobs.push(srcMBRels(), srcRadio(), srcIAm3u());
      const settled = await Promise.allSettled(jobs);
      if (tk !== S.token) return;
      const failed = settled.filter((x) => x.status === "rejected").length;
      const seen = new Set();
      const list = [];
      settled.forEach((x) => {
        if (x.status !== "fulfilled") return;
        x.value.forEach((raw) => {
          const r = finalize(raw);
          if (!r) return;
          const key = r.url || r.embedUrl;
          if (seen.has(key)) return;
          seen.add(key);
          if (scoreResult(r) >= 40) list.push(r);
        });
      });
      list.sort((a, b) => b.score - a.score || (a.kind === "legacy") - (b.kind === "legacy"));
      S.results = list.slice(0, 30);
      if (!S.results.length) {
        if (failed === settled.length) { bodyMessage(["Falha de rede ao consultar as fontes. Verifique sua conexão e tente novamente."]); return; }
        showNoTrack();
        return;
      }
      setCollapsed(false);
      renderResults();
      setStatus(S.results.length + " resultado(s) para " + S.artist + (failed ? " (" + failed + " fonte(s) indisponível(is))" : ""), "ok");
    } catch (e) {
      bodyMessage(["Erro inesperado na busca. Tente novamente."]);
    } finally {
      if (tk === S.token) setBusy(false);
    }
  }

  /* =====================================================================
     8. PLAYER (áudio nativo direto, sem roteamento WebAudio)
  ===================================================================== */
  let coverImg = null;
  const SVG_FALLBACK = "data:image/svg+xml;utf8," + enc(
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#3a2fa8"/><stop offset="1" stop-color="#0a8aa8"/></linearGradient></defs><rect width="240" height="240" fill="url(#g)"/>' +
    '<circle cx="120" cy="120" r="78" fill="#0b0d18"/><circle cx="120" cy="120" r="60" fill="none" stroke="#2a2f4a" stroke-width="2"/>' +
    '<circle cx="120" cy="120" r="42" fill="none" stroke="#2a2f4a" stroke-width="2"/><circle cx="120" cy="120" r="22" fill="#4dc8ff"/><circle cx="120" cy="120" r="5" fill="#0b0d18"/></svg>');

  function forceAudible() {
    audio.defaultMuted = false;
    audio.muted = false;
    audio.volume = parseFloat($("vol").value) || 0.95;
    $("btnMute").setAttribute("aria-pressed", "false");
    $("btnMute").textContent = "🔊";
  }

  function isPlaying() { return S.embedActive || (!audio.paused && !audio.ended); }

  function resumeCtx() { if (actx && actx.state === "suspended") actx.resume().catch(noop); }

  async function play() {
    if (S.embedActive) return;
    if (!audio.getAttribute("src")) { setStatus("Escolha uma faixa nos resultados ou cole um link direto.", "warn"); return; }
    forceAudible();
    resumeCtx();
    try { await audio.play(); }
    catch (e) { setStatus("Reprodução bloqueada pelo navegador — toque em ▶ novamente.", "warn"); }
  }
  function pause() { if (!S.embedActive) audio.pause(); }
  function stop() {
    if (S.embedActive) { hideEmbed(); setStatus("Reprodução embutida encerrada."); return; }
    audio.pause();
    try { audio.currentTime = 0; } catch (e) { /* stream ao vivo */ }
    syncClock();
  }

  function showEmbed(r) {
    const box = $("embedBox");
    box.textContent = "";
    const f = document.createElement("iframe");
    f.src = r.embedUrl;
    f.title = "Player " + r.provider;
    f.allow = "autoplay; encrypted-media; fullscreen";
    f.setAttribute("sandbox", "allow-scripts allow-same-origin allow-presentation allow-popups");
    f.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    box.appendChild(f);
    box.hidden = false;
    S.embedActive = true;
  }
  function hideEmbed() {
    const box = $("embedBox");
    box.textContent = "";
    box.hidden = true;
    S.embedActive = false;
  }

  function setMarquee(text) { $("marqueeText").textContent = text; }

  function updateDeck(r) {
    setMarquee(r.title + (r.artist ? " — " + r.artist : "") + "  ·  " + r.src + (r.genre ? "  ·  " + r.genre : ""));
    $("hudFmt").textContent = r.kind === "embed" ? r.provider : "." + r.ext.toUpperCase();
    $("hudYear").textContent = r.year ? "Ano " + r.year : "Ano —";
    $("hudGenre").textContent = r.genre ? "Gênero " + r.genre : "Gênero —";
    S.genre = r.genre || "";
    setAura(r.title + r.artist);
    $("timeDur").textContent = r.duration ? fmtTime(r.duration) : "0:00";
    $("seek").value = 0;
    $("clock").textContent = "00:00";
    updateActiveBar();
  }

  function playResult(r) {
    S.current = r;
    if (r.kind === "legacy") {
      setStatus("Formato proprietário (." + r.ext + "): adicione à .m3u e abra no VLC/Winamp.", "warn");
      return;
    }
    forceAudible();
    if (r.kind === "embed") {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      showEmbed(r);
      setStatus("Reproduzindo via player oficial " + r.provider + ".", "ok");
    } else {
      hideEmbed();
      audio.src = r.url;
      audio.load();
      audio.playbackRate = parseFloat($("speed").value) || 1;
      setStatus("Carregando " + r.title + "…");
      play();
    }
    updateDeck(r);
    if (S.results.indexOf(r) > -1) { renderResults(); setCollapsed(true); }
    enrich(r);
  }

  function rejectCurrent(msg) {
    const r = S.current;
    setStatus(msg, "err");
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    if (r) {
      S.results = S.results.filter((x) => x !== r);
      S.current = null;
      updateActiveBar();
      if (S.results.length) { renderResults(); setCollapsed(false); } else { setCollapsed(false); bodyMessage(["Todas as faixas foram descartadas. Faça uma nova busca."]); $("btnToggleResults").hidden = true; }
    }
  }

  let seeking = false;
  function syncClock() {
    const d = audio.duration, c = audio.currentTime || 0;
    const t = S.remaining && isFinite(d) ? d - c : c;
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    $("clock").textContent = (S.remaining ? "-" : "") + (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
    $("timeCur").textContent = fmtTime(c);
    if (isFinite(d) && d > 0) {
      $("timeDur").textContent = fmtTime(d);
      if (!seeking) $("seek").value = Math.round((c / d) * 1000);
    }
  }

  audio.setAttribute("controlsList", "nodownload");
  audio.addEventListener("timeupdate", syncClock);
  audio.addEventListener("loadedmetadata", () => {
    const d = audio.duration;
    if (S.current && isFinite(d) && d > 0 && !S.current.live) {
      if (d < MIN_DUR) { rejectCurrent("Faixa descartada: prévia/amostra detectada (" + Math.round(d) + "s < " + MIN_DUR + "s)."); return; }
      S.current.duration = d;
    }
    if (audio.videoTracks && audio.videoTracks.length && audio.audioTracks && audio.audioTracks.length === 0) {
      rejectCurrent("Arquivo sem faixa de áudio — descartado.");
      return;
    }
    syncClock();
  });
  audio.addEventListener("playing", () => { $("ledPlay").classList.add("on"); setStatus("Tocando: " + (S.current ? S.current.title : ""), "ok"); setupAnalyser(); });
  audio.addEventListener("pause", () => $("ledPlay").classList.remove("on"));
  audio.addEventListener("ended", () => {
    $("ledPlay").classList.remove("on");
    const i = S.results.indexOf(S.current);
    const next = i > -1 ? S.results.slice(i + 1).find((x) => x.kind !== "legacy") : null;
    if (next) playResult(next);
  });
  audio.addEventListener("error", () => {
    if (!audio.getAttribute("src")) return;
    const ext = S.current ? S.current.ext : "";
    setStatus("Não foi possível tocar este arquivo no navegador" + (ext ? " (." + ext + ")" : "") + ". Tente outro resultado ou use a .m3u no VLC.", "err");
  });

  $("btnPlay").addEventListener("click", play);
  $("btnPause").addEventListener("click", pause);
  $("btnStop").addEventListener("click", stop);
  $("btnLoop").addEventListener("click", () => {
    audio.loop = !audio.loop;
    $("btnLoop").setAttribute("aria-pressed", String(audio.loop));
  });
  $("btnMute").addEventListener("click", () => {
    audio.muted = !audio.muted;
    $("btnMute").setAttribute("aria-pressed", String(audio.muted));
    $("btnMute").textContent = audio.muted ? "🔇" : "🔊";
  });
  $("vol").addEventListener("input", () => { audio.volume = parseFloat($("vol").value); });
  $("speed").addEventListener("change", () => { audio.playbackRate = parseFloat($("speed").value) || 1; });
  $("seek").addEventListener("input", () => { seeking = true; });
  $("seek").addEventListener("change", () => {
    seeking = false;
    if (isFinite(audio.duration)) audio.currentTime = (parseFloat($("seek").value) / 1000) * audio.duration;
  });
  $("clock").addEventListener("click", () => { S.remaining = !S.remaining; syncClock(); });
  $("deck").addEventListener("contextmenu", (e) => e.preventDefault());

  /* =====================================================================
     9. ANÁLISE MUSICAL SEGURA (captureStream -> AnalyserNode, nunca destination)
  ===================================================================== */
  const NB = 48;
  const sig = { bars: new Float32Array(NB), wave: new Float32Array(128), bass: 0, mid: 0, high: 0, cent: 0.4, kick: 0, kickNow: false, live: false };
  let actx = null, analyser = null, freq = null, td = null, srcNode = null, fftOK = true, capturedKey = "";
  let silent = 0, avgBass = 0, lastKick = 0, lastBeat = -1;

  function connectStream(stream) {
    try {
      if (!stream.getAudioTracks().length) return false;
      if (srcNode) { try { srcNode.disconnect(); } catch (e) { /* ok */ } }
      srcNode = actx.createMediaStreamSource(stream);
      if (!analyser) {
        analyser = actx.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.78;
        freq = new Uint8Array(analyser.frequencyBinCount);
        td = new Uint8Array(analyser.fftSize);
      }
      srcNode.connect(analyser); /* somente analisador — sem saída para o destino */
      return true;
    } catch (e) { return false; }
  }

  function setupAnalyser() {
    if (!fftOK || S.embedActive) return;
    const key = audio.currentSrc || audio.src;
    if (key === capturedKey) { resumeCtx(); return; }
    capturedKey = key;
    try {
      const stream = audio.captureStream ? audio.captureStream() : (audio.mozCaptureStream ? audio.mozCaptureStream() : null);
      if (!stream) throw new Error("sem captureStream");
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error("sem AudioContext");
      if (!actx) actx = new AC();
      resumeCtx();
      if (!connectStream(stream)) stream.addEventListener("addtrack", () => connectStream(stream));
    } catch (e) { fftOK = false; }
  }

  function genreBpm() {
    const gn = norm(S.genre);
    const tbl = [[/metal/, 140], [/rock|punk/, 122], [/electro|dance|house|techno|disco/, 126], [/hip|rap|trap/, 92], [/reggae/, 76],
      [/jazz/, 104], [/blues/, 84], [/bossa/, 78], [/samba|pagode/, 98], [/mpb|brazil|brasil/, 90], [/pop/, 112],
      [/forro|sertanej|country|folk/, 100], [/classic|ambient|new age/, 68], [/soul|funk|r b/, 100], [/latin|salsa/, 96]];
    for (let i = 0; i < tbl.length; i++) if (tbl[i][0].test(gn)) return tbl[i][1];
    return 100;
  }

  function synth(t) {
    const bpm = genreBpm(), beat = t * bpm / 60, idx = Math.floor(beat), ph = beat - idx;
    const env = Math.exp(-ph * 5.5), accent = idx % 4 === 0 ? 1 : 0.78;
    const step = Math.floor(beat * 2) % 8, note = [0, 2, 4, 7, 9, 7, 4, 2][step];
    sig.bass = 0.12 + 0.82 * env * accent;
    sig.mid = clamp(0.3 + 0.25 * Math.sin(t * 2.3) + 0.2 * Math.sin(t * 5.1 + note) + 0.1 * env, 0, 1);
    sig.cent = clamp(0.2 + 0.5 * (note / 9) + 0.15 * Math.sin(t * 0.7), 0, 1);
    sig.high = clamp(0.15 + 0.3 * Math.abs(Math.sin(beat * Math.PI * 2)) + 0.1 * Math.sin(t * 7), 0, 1);
    if (idx !== lastBeat) { lastBeat = idx; sig.kick = 1; sig.kickNow = true; }
    for (let i = 0; i < NB; i++) {
      const x = i / NB;
      let v = sig.bass * Math.exp(-x * 7) * 1.15 + sig.mid * Math.exp(-Math.pow((x - (0.28 + note * 0.025)) / 0.16, 2)) +
        sig.high * Math.exp(-Math.pow((x - 0.8) / 0.18, 2)) * 0.9;
      v *= 0.85 + 0.15 * Math.sin(t * 4 + i * 0.7);
      sig.bars[i] = Math.max(clamp(v, 0, 1), sig.bars[i] * 0.8);
    }
    for (let i = 0; i < 128; i++) {
      const k = i / 128;
      sig.wave[i] = Math.sin(k * Math.PI * 2 * (2 + note * 0.4) + t * 8) * 0.45 * (0.3 + sig.mid) + Math.sin(k * Math.PI * 2 + t * 3) * 0.3 * sig.bass;
    }
  }

  function analyse(now, dt) {
    sig.kickNow = false;
    const playing = isPlaying();
    let live = false;
    if (playing && !S.embedActive && analyser && fftOK) {
      analyser.getByteFrequencyData(freq);
      let tot = 0;
      for (let i = 0; i < freq.length; i++) tot += freq[i];
      if (tot === 0) silent++; else silent = 0;
      if (silent < 90 && tot > 0) {
        live = true;
        const binHz = actx.sampleRate / analyser.fftSize;
        const avg = (f1, f2) => {
          const a = Math.max(1, Math.floor(f1 / binHz)), b = Math.min(freq.length - 1, Math.max(a + 1, Math.floor(f2 / binHz)));
          let s = 0; for (let i = a; i < b; i++) s += freq[i];
          return s / (b - a) / 255;
        };
        sig.bass = avg(30, 160); sig.mid = avg(250, 4000); sig.high = avg(6000, 16000);
        let num = 0, den = 0;
        for (let i = 1; i < freq.length; i++) { num += i * freq[i]; den += freq[i]; }
        sig.cent = clamp(Math.log2(1 + (num / den) * binHz / 200) / 5, 0, 1);
        for (let i = 0; i < NB; i++) {
          const lo = 20 * Math.pow(900, i / NB), hi = 20 * Math.pow(900, (i + 1) / NB);
          sig.bars[i] = Math.max(clamp(Math.pow(avg(lo, hi), 1.25) * 1.25, 0, 1), sig.bars[i] * 0.82);
        }
        analyser.getByteTimeDomainData(td);
        for (let i = 0; i < 128; i++) sig.wave[i] = (td[i * 16] - 128) / 128;
        avgBass = avgBass * 0.96 + sig.bass * 0.04;
        if (sig.bass > avgBass * 1.3 + 0.04 && sig.bass > 0.22 && now - lastKick > 200) { lastKick = now; sig.kick = 1; sig.kickNow = true; }
      }
    }
    if (!live) {
      if (playing) synth(S.embedActive ? now / 1000 : audio.currentTime);
      else {
        const d = Math.pow(0.9, dt * 60);
        for (let i = 0; i < NB; i++) sig.bars[i] *= d;
        sig.bass *= d; sig.mid *= d; sig.high *= d;
        for (let i = 0; i < 128; i++) sig.wave[i] *= d;
      }
    }
    sig.live = live;
    sig.kick *= Math.pow(0.88, dt * 60);
    $("hudMode").textContent = !playing ? "PARADO" : live ? "FFT Ao Vivo" : "Sync Melódico";
  }

  /* =====================================================================
     10. VISUALIZADORES (Canvas 2D HiDPI, 60fps)
  ===================================================================== */
  const cv = $("viz"), g = cv.getContext("2d");
  let W = 300, H = 200;
  function resizeCanvas() {
    const r = cv.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(10, r.width); H = Math.max(10, r.height);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  if (window.ResizeObserver) new ResizeObserver(resizeCanvas).observe(cv);
  window.addEventListener("resize", resizeCanvas);

  const peaks = new Float32Array(NB);
  const hsl = (hu, s, l, a) => "hsla(" + Math.round(hu) + "," + s + "%," + l + "%," + (a == null ? 1 : a) + ")";
  let rot = 0, phaseAcc = 0, gridOff = 0, tunOff = 0;
  const waves = [];
  const parts = [];
  for (let i = 0; i < 40; i++) parts.push({ a: Math.random() * 6.283, r: 1.25 + Math.random() * 0.8, s: (0.2 + Math.random() * 0.6) * (Math.random() > 0.5 ? 1 : -1) });

  function drawLED(t, dt) {
    const base = H * 0.74, bw = W / NB, segH = 5, gap = 2, segs = Math.max(4, Math.floor(base / (segH + gap)));
    for (let i = 0; i < NB; i++) {
      const v = sig.bars[i], n = Math.round(v * segs), x = i * bw + 1;
      for (let s = 0; s < n; s++) { const f = s / segs; g.fillStyle = "hsl(" + (125 - 125 * f) + ",95%," + (46 + 10 * f) + "%)"; g.fillRect(x, base - (s + 1) * (segH + gap), bw - 2, segH); }
      if (v > peaks[i]) peaks[i] = v; else peaks[i] = Math.max(0, peaks[i] - 0.35 * dt);
      if (peaks[i] > 0.03) { g.fillStyle = "#fff"; g.fillRect(x, base - (Math.round(peaks[i] * segs) + 1) * (segH + gap), bw - 2, 2); }
      const rn = Math.min(n, Math.floor(segs * 0.35));
      for (let s = 0; s < rn; s++) { g.globalAlpha = 0.28 * (1 - s / rn); g.fillStyle = "hsl(" + (125 - 125 * (s / segs)) + ",95%,50%)"; g.fillRect(x, base + 4 + s * (segH + gap) * 0.8, bw - 2, segH * 0.7); }
      g.globalAlpha = 1;
    }
    g.fillStyle = "rgba(255,255,255,.22)"; g.fillRect(0, base + 1, W, 1);
  }

  function drawGlow() {
    const mid = H / 2;
    g.globalCompositeOperation = "lighter";
    [[S.hue1, -1], [S.hue2, 1]].forEach((p) => {
      const col = hsl(p[0], 100, 60), dir = p[1];
      g.shadowColor = col; g.shadowBlur = 16; g.strokeStyle = col; g.lineWidth = 2.4;
      g.beginPath();
      let px = 0, py = mid;
      for (let i = 0; i < NB; i++) {
        const x = (i / (NB - 1)) * W, y = mid + dir * (4 + sig.bars[i] * H * 0.42);
        if (i === 0) g.moveTo(x, y); else g.quadraticCurveTo(px, py, (x + px) / 2, (y + py) / 2);
        px = x; py = y;
      }
      g.stroke();
      g.shadowBlur = 0;
      g.lineTo(W, mid); g.lineTo(0, mid); g.closePath();
      const gr = g.createLinearGradient(0, mid, 0, mid + dir * H / 2);
      gr.addColorStop(0, hsl(p[0], 100, 60, 0)); gr.addColorStop(1, hsl(p[0], 100, 60, 0.35));
      g.fillStyle = gr; g.fill();
    });
    g.globalCompositeOperation = "source-over";
  }

  function drawReactor(t, dt) {
    const cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.24 * (1 + sig.bass * 0.09);
    rot += dt * (0.3 + sig.cent * 1.4);
    if (sig.kickNow) waves.push({ r: R, a: 0.8 });
    for (let i = waves.length - 1; i >= 0; i--) {
      const w = waves[i]; w.r += dt * 190; w.a -= dt * 0.9;
      if (w.a <= 0) { waves.splice(i, 1); continue; }
      g.strokeStyle = hsl(S.hue2, 100, 65, w.a); g.lineWidth = 2; g.beginPath(); g.arc(cx, cy, w.r, 0, 6.283); g.stroke();
    }
    g.lineWidth = 2;
    for (let i = 0; i < NB * 2; i++) {
      const v = sig.bars[i % NB], a = (i / (NB * 2)) * 6.283 + rot * 0.4, r0 = R + 6, r1 = r0 + 3 + v * R * 0.9;
      g.strokeStyle = hsl(S.hue1 + (i / (NB * 2)) * (S.hue2 - S.hue1), 95, 60, 0.9);
      g.beginPath(); g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); g.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); g.stroke();
    }
    parts.forEach((p) => {
      p.a += p.s * dt * (0.5 + sig.high * 3);
      const rr = R * p.r + sig.high * 10;
      g.fillStyle = hsl(S.hue2, 100, 75, 0.7);
      g.beginPath(); g.arc(cx + Math.cos(p.a) * rr, cy + Math.sin(p.a) * rr, 1.2 + sig.high * 2.6, 0, 6.283); g.fill();
    });
    g.save();
    g.translate(cx, cy); g.rotate(rot);
    g.beginPath(); g.arc(0, 0, R, 0, 6.283); g.clip();
    if (coverImg && coverImg.complete && coverImg.naturalWidth) g.drawImage(coverImg, -R, -R, R * 2, R * 2);
    else { const gr = g.createRadialGradient(0, 0, 2, 0, 0, R); gr.addColorStop(0, hsl(S.hue2, 90, 50)); gr.addColorStop(1, hsl(S.hue1, 80, 25)); g.fillStyle = gr; g.fillRect(-R, -R, R * 2, R * 2); }
    g.strokeStyle = "rgba(0,0,0,.35)"; g.lineWidth = 1;
    for (let k = 0.25; k < 1; k += 0.15) { g.beginPath(); g.arc(0, 0, R * k, 0, 6.283); g.stroke(); }
    g.fillStyle = "#05060c"; g.beginPath(); g.arc(0, 0, R * 0.09, 0, 6.283); g.fill();
    g.restore();
    g.strokeStyle = "rgba(255,255,255,.35)"; g.lineWidth = 1.5; g.beginPath(); g.arc(cx, cy, R, 0, 6.283); g.stroke();
  }

  function drawAurora(t, dt) {
    phaseAcc += dt * (0.6 + sig.cent * 3);
    g.save();
    g.globalCompositeOperation = "lighter";
    g.translate(W / 2, H / 2); g.rotate((sig.cent - 0.5) * 0.25 + Math.sin(t * 0.2) * 0.05); g.translate(-W / 2, -H / 2);
    for (let k = 0; k < 5; k++) {
      const baseY = H * (0.28 + 0.11 * k), amp = H * (0.05 + sig.mid * 0.22) * (1 - k * 0.08), hu = S.hue1 + k * ((S.hue2 - S.hue1) / 4);
      g.beginPath();
      for (let x = -10; x <= W + 10; x += 8) {
        const y = baseY + Math.sin(x * 0.012 + phaseAcc + k) * amp + Math.sin(x * 0.027 - phaseAcc * 1.3 + k * 2) * amp * 0.5 - sig.bars[Math.floor(clamp(x / W, 0, 0.999) * NB)] * H * 0.12;
        if (x === -10) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.lineTo(W + 10, baseY + H * 0.22); g.lineTo(-10, baseY + H * 0.22); g.closePath();
      const gr = g.createLinearGradient(0, baseY - amp, 0, baseY + H * 0.22);
      gr.addColorStop(0, hsl(hu, 100, 60, 0.5)); gr.addColorStop(1, hsl(hu, 100, 50, 0));
      g.fillStyle = gr; g.fill();
    }
    g.restore();
  }

  function drawCyber(t, dt) {
    const hz = H * 0.5, vx = W / 2;
    gridOff = (gridOff + dt * (0.6 + sig.bass * 3)) % 1;
    tunOff = (tunOff + dt * (0.25 + sig.mid * 1.2)) % 1;
    for (let j = 0; j < 8; j++) {
      const p = (j + tunOff) / 8, w = W * p * 0.95, hh = hz * p * 1.5;
      g.strokeStyle = hsl(S.hue1 + j * 8, 100, 60, 0.15 + p * 0.55 + sig.kick * 0.2); g.lineWidth = 1 + p * 2;
      g.strokeRect(vx - w / 2, hz * 0.85 - hh / 2, w, hh);
    }
    g.strokeStyle = hsl(S.hue2, 100, 60, 0.7); g.lineWidth = 1;
    for (let j = 0; j < 12; j++) {
      const z = (j + gridOff) / 12, y = hz + (H - hz) * z * z;
      g.globalAlpha = 0.15 + z * 0.7; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
    }
    g.globalAlpha = 0.5;
    for (let i = -12; i <= 12; i++) { g.beginPath(); g.moveTo(vx, hz); g.lineTo(vx + i * W * 0.14, H); g.stroke(); }
    g.globalAlpha = 1;
    g.lineWidth = 2;
    for (let i = 0; i < NB; i++) {
      const x = (i + 0.5) * (W / NB), v = sig.bars[i] * hz * 0.7;
      g.strokeStyle = hsl(S.hue1 + (i / NB) * (S.hue2 - S.hue1), 100, 62, 0.95);
      g.beginPath(); g.moveTo(x, hz); g.lineTo(x, hz - v); g.stroke();
    }
    g.fillStyle = hsl(S.hue2, 100, 60, 0.9); g.fillRect(0, hz - 1, W, 2);
  }

  let scopeFresh = true;
  function drawScope() {
    if (scopeFresh) { g.fillStyle = "#020a05"; g.fillRect(0, 0, W, H); scopeFresh = false; }
    g.fillStyle = "rgba(0,12,4,.28)"; g.fillRect(0, 0, W, H);
    g.strokeStyle = "rgba(60,255,150,.09)"; g.lineWidth = 1;
    for (let i = 1; i < 10; i++) { g.beginPath(); g.moveTo((W / 10) * i, 0); g.lineTo((W / 10) * i, H); g.stroke(); }
    for (let i = 1; i < 6; i++) { g.beginPath(); g.moveTo(0, (H / 6) * i); g.lineTo(W, (H / 6) * i); g.stroke(); }
    g.strokeStyle = "#3dff9a"; g.shadowColor = "#3dff9a"; g.shadowBlur = 10; g.lineWidth = 2;
    g.beginPath();
    for (let i = 0; i < 128; i++) { const x = (i / 127) * W, y = H / 2 + sig.wave[i] * H * 0.42; if (i === 0) g.moveTo(x, y); else g.lineTo(x, y); }
    g.stroke(); g.shadowBlur = 0;
    g.fillStyle = "rgba(0,0,0,.18)";
    for (let y = 0; y < H; y += 3) g.fillRect(0, y, W, 1);
  }

  const STYLE_NAMES = ["Winamp LED", "Glow Simétrico", "Reator de Graves", "Aurora Melódica", "Cyber Grid", "Osciloscópio CRT"];
  function styleForGenre(genre, seed) {
    const gn = norm(genre);
    if (/metal|rock|punk|blues/.test(gn)) return 1;
    if (/hip|rap|trap|pop/.test(gn)) return 2;
    if (/mpb|samba|bossa|romant|latin|soul|brasil|brazil|pagode|sertanej/.test(gn)) return 3;
    if (/jazz|classic|ambient|new age/.test(gn)) return 4;
    if (/electro|dance|techno|house|disco/.test(gn)) return 5;
    if (/folk|country|acoustic|reggae/.test(gn)) return 6;
    return (hashStr(seed || "x") % 6) + 1;
  }
  function setAura(seed) {
    const hh = hashStr(String(seed || "x")) % 360;
    S.hue1 = hh; S.hue2 = (hh + 70) % 360;
    const root = document.documentElement.style;
    root.setProperty("--aura-primary", hsl(S.hue1, 85, 52));
    root.setProperty("--aura-secondary", hsl(S.hue2, 90, 50));
  }

  let lastT = 0, lastStyleDrawn = 0;
  const rootStyle = document.documentElement.style;
  function frame(now) {
    requestAnimationFrame(frame);
    if (document.hidden) return;
    const dt = Math.min(0.05, (now - lastT) / 1000 || 0.016);
    lastT = now;
    analyse(now, dt);
    rootStyle.setProperty("--beat-scale", (1 + sig.kick * 0.07).toFixed(3));
    rootStyle.setProperty("--beat-glow", (0.18 + sig.kick * 0.75).toFixed(2));
    $("ledBeat").classList.toggle("on", sig.kick > 0.5);
    $("ledHi").classList.toggle("on", sig.high > 0.45 && isPlaying());
    $("ledFft").classList.toggle("on", sig.live);
    const st = S.style === "auto" ? S.autoStyle : parseInt(S.style, 10);
    if (st !== lastStyleDrawn) {
      lastStyleDrawn = st; scopeFresh = true; g.clearRect(0, 0, W, H);
      $("hudStyle").textContent = "Visual: " + STYLE_NAMES[st - 1];
    }
    if (st !== 6) g.clearRect(0, 0, W, H);
    const t = now / 1000;
    switch (st) {
      case 1: drawLED(t, dt); break;
      case 2: drawGlow(t, dt); break;
      case 3: drawReactor(t, dt); break;
      case 4: drawAurora(t, dt); break;
      case 5: drawCyber(t, dt); break;
      default: drawScope(t, dt);
    }
  }

  $("vizStyle").addEventListener("change", () => { S.style = $("vizStyle").value; });
  function setImmersive(on) {
    $("stage").classList.toggle("immersive", on);
    $("btnExit").hidden = !on;
    setTimeout(resizeCanvas, 30);
  }
  $("btnImmersive").addEventListener("click", () => setImmersive(true));
  $("btnExit").addEventListener("click", () => setImmersive(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setImmersive(false);
    const tg = e.target && e.target.tagName;
    if (e.code === "Space" && tg !== "INPUT" && tg !== "TEXTAREA" && tg !== "SELECT" && tg !== "BUTTON" && tg !== "A") {
      e.preventDefault();
      if (isPlaying()) pause(); else play();
    }
  });

  /* =====================================================================
     11. METADADOS: ANO ORIGINAL, GÊNERO, CAPAS (cascata multi-fonte)
  ===================================================================== */
  const WD = "https://www.wikidata.org/w/api.php";
  const WD_OPT = { jp: "callback", fb: "&origin=*" };

  function wdSong(title, artist) {
    return memoize("wd|" + norm(artist) + "|" + norm(title), async () => {
      const out = { years: [], composers: [], lyricists: [] };
      const s = await getJSON(WD + "?action=wbsearchentities&format=json&type=item&limit=10&language=pt&uselang=pt&search=" + enc(sanitize(title)), WD_OPT);
      const na = norm(artist), nt = norm(title);
      const ids = (s.search || []).filter((e) => norm(e.label || "").indexOf(nt) > -1 &&
        /(song|can[cç]|m[uú]sica|single|canci|chanson|canzone|lied)/i.test(e.description || "") && norm(e.description || "").indexOf(na) > -1)
        .map((e) => e.id).slice(0, 3);
      if (!ids.length) return out;
      const d = await getJSON(WD + "?action=wbgetentities&format=json&props=claims&ids=" + ids.join("%7C"), WD_OPT);
      const comp = new Set(), lyr = new Set();
      Object.keys(d.entities || {}).forEach((k) => {
        const cl = d.entities[k].claims || {};
        (cl.P577 || []).forEach((c) => {
          const tm = c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value && c.mainsnak.datavalue.value.time;
          const y = tm ? parseInt(String(tm).slice(1, 5), 10) : 0;
          if (y >= 1900 && y <= CUR_YEAR) out.years.push(y);
        });
        (cl.P86 || []).forEach((c) => { const v = c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value; if (v && v.id) comp.add(v.id); });
        (cl.P676 || []).forEach((c) => { const v = c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value; if (v && v.id) lyr.add(v.id); });
      });
      const all = Array.from(new Set([].concat(Array.from(comp), Array.from(lyr)))).slice(0, 10);
      if (all.length) {
        try {
          const l = await getJSON(WD + "?action=wbgetentities&format=json&props=labels&languages=pt%7Cen&ids=" + all.join("%7C"), WD_OPT);
          const lab = (id) => { const e = (l.entities || {})[id]; const lb = e && e.labels; return lb ? (lb.pt || lb.en || {}).value : ""; };
          out.composers = Array.from(comp).map(lab).filter(Boolean);
          out.lyricists = Array.from(lyr).map(lab).filter(Boolean);
        } catch (e) { /* sem rótulos */ }
      }
      return out;
    });
  }

  function fetchMeta(artist, title) {
    return memoize("meta|" + norm(artist) + "|" + norm(title), async () => {
      const out = { year: null, genre: "", releases: [], covers: [], recId: null };
      const q = sanitize(title), a = sanitize(artist), nt = norm(title);
      const useMbid = S.mbid && S.artist && sameArtist(S.artist, artist);
      const res = await Promise.allSettled([
        mb("recording/?query=" + enc('recording:"' + q + '" AND ' + (useMbid ? "arid:" + S.mbid : 'artist:"' + a + '"')) + "&limit=15"),
        getJSON("https://itunes.apple.com/search?media=music&entity=song&limit=10&term=" + enc(a + " " + q), { jp: "callback" }),
        getJSON("https://api.deezer.com/search/track?limit=5&output=jsonp&q=" + enc('artist:"' + a + '" track:"' + q + '"'), { jp: "callback" }),
        wdSong(title, artist)
      ]);
      const years = [];
      const addY = (v) => { const y = parseInt(String(v || "").slice(0, 4), 10); if (y >= 1900 && y <= CUR_YEAR) years.push(y); };
      if (res[0].status === "fulfilled") {
        const recs = (res[0].value.recordings || []).filter((r) => {
          const n = norm(r.title);
          if (n !== nt && n.indexOf(nt) !== 0) return false;
          return useMbid || (r["artist-credit"] || []).some((c) => sameArtist(c.name || "", artist));
        });
        recs.forEach((r) => {
          addY(r["first-release-date"]);
          (r.releases || []).forEach((rl) => { addY(rl.date); if (out.releases.length < 4 && rl.id) out.releases.push(rl.id); });
        });
        if (recs[0]) {
          out.recId = recs[0].id;
          const tag = (recs[0].tags || []).slice().sort((x, y) => y.count - x.count)[0];
          if (tag) out.genre = tag.name;
        }
      }
      if (res[1].status === "fulfilled") {
        (res[1].value.results || []).filter((x) => x.artistName && sameArtist(x.artistName, artist) && norm(x.trackName).indexOf(nt) === 0).forEach((x) => {
          addY(x.releaseDate); /* somente metadados — nunca previewUrl */
          if (x.primaryGenreName) out.genre = x.primaryGenreName;
          if (x.artworkUrl100) out.covers.push(x.artworkUrl100.replace(/\d+x\d+bb/, "600x600bb"));
        });
      }
      if (res[2].status === "fulfilled") {
        (res[2].value.data || []).filter((x) => x.artist && sameArtist(x.artist.name, artist)).forEach((x) => { if (x.album && x.album.cover_big) out.covers.push(x.album.cover_big); });
      }
      if (res[3].status === "fulfilled") res[3].value.years.forEach(addY);
      out.year = years.length ? Math.min.apply(null, years) : null;
      return out;
    });
  }

  let coverFallback = true;
  function setCover(url) {
    const img = $("cover");
    if (!url) { coverFallback = true; img.src = SVG_FALLBACK; coverImg = null; return; }
    coverFallback = false;
    img.src = url;
    const im = new Image();
    im.src = url;
    coverImg = im;
  }
  $("cover").addEventListener("error", () => { if (!coverFallback) { coverFallback = true; $("cover").src = SVG_FALLBACK; coverImg = null; } });

  function probe(url) {
    return new Promise((resolve) => {
      const i = new Image();
      let done = false;
      const fin = (ok) => { if (!done) { done = true; clearTimeout(t); resolve(ok ? url : null); } };
      const t = setTimeout(() => fin(false), 6000);
      i.onload = () => fin(i.naturalWidth > 40);
      i.onerror = () => fin(false);
      i.src = url;
    });
  }

  async function wikiCover(r) {
    const url = "https://en.wikipedia.org/w/api.php?action=query&format=json&generator=search&gsrlimit=3&gsrnamespace=0&prop=pageimages&piprop=thumbnail&pithumbsize=500&gsrsearch=" +
      enc(sanitize(r.title) + " " + sanitize(r.artist) + " song");
    const d = await getJSON(url, WD_OPT);
    const pages = Object.values((d.query && d.query.pages) || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
    const p = pages.find((x) => x.thumbnail && (norm(x.title).indexOf(norm(r.title)) > -1 || norm(x.title).indexOf(norm(r.artist)) > -1));
    return p ? p.thumbnail.source : null;
  }

  async function coverCascade(r, meta, tk) {
    const cands = [];
    if (r.cover) cands.push(r.cover);
    if (meta) {
      meta.releases.slice(0, 3).forEach((id) => cands.push("https://coverartarchive.org/release/" + id + "/front-500"));
      meta.covers.forEach((c) => cands.push(c));
    }
    for (let i = 0; i < cands.length; i++) {
      const ok = await probe(cands[i]);
      if (tk !== S.enrichToken) return;
      if (ok) { setCover(ok); return; }
    }
    if (r.artist) {
      try {
        const w = await wikiCover(r);
        if (tk !== S.enrichToken) return;
        if (w && (await probe(w))) { setCover(w); return; }
      } catch (e) { /* segue */ }
    }
    if (tk === S.enrichToken) setCover(null);
  }

  /* =====================================================================
     12. LETRA + DETECÇÃO DE IDIOMA + TRADUÇÃO SEMPRE PARA pt-BR
  ===================================================================== */
  const LANG_NAMES = { pt: "Português", en: "Inglês", es: "Espanhol", fr: "Francês", it: "Italiano", de: "Alemão", ja: "Japonês", ko: "Coreano", ru: "Russo", ar: "Árabe", el: "Grego" };
  const SW = {
    pt: "de que o a os as um uma nao com para por em voce eu meu minha ele ela mais mas como esta foi so se te me nos tem ja muito amor coracao".split(" "),
    en: "the and you to of in is it that for on with this my your me be are was love i im dont baby".split(" "),
    es: "el la los las de que y en un una por con para mi tu te lo se es no mas pero como esta yo corazon".split(" "),
    fr: "le la les des et en un une pour que qui dans je tu il elle nous vous est pas mon ma avec".split(" "),
    it: "il lo la gli le di che e un una per con non mi ti sono come piu ma cuore".split(" "),
    de: "der die das und ich du nicht ist ein eine zu mit den dem mein dich auf nicht".split(" ")
  };

  function detectLang(text) {
    const s = String(text || "").slice(0, 4000);
    if (s.trim().length < 8) return null;
    const cnt = (re) => (s.match(re) || []).length;
    const scripts = [["ja", /[\u3040-\u30ff]/g], ["ko", /[\uac00-\ud7af]/g], ["ru", /[\u0400-\u04ff]/g], ["ar", /[\u0600-\u06ff]/g], ["el", /[\u0370-\u03ff]/g]];
    let best = null, bn = 0;
    scripts.forEach((x) => { const n = cnt(x[1]); if (n > bn) { bn = n; best = x[0]; } });
    if (bn >= 6) return best;
    if (cnt(/[\u4e00-\u9fff]/g) > 10) return "ja";
    const words = norm(s).split(" ");
    const score = {};
    Object.keys(SW).forEach((l) => { const set = new Set(SW[l]); score[l] = words.filter((w) => set.has(w)).length; });
    const low = s.toLowerCase();
    score.pt += cnt(/[ãõ]/g) * 3 + (low.match(/ç/g) || []).length;
    score.es += cnt(/[ñ¿¡]/g) * 3;
    score.fr += cnt(/[èêàùœ]/g) * 1.5;
    score.de += cnt(/[ßü]/g) * 3;
    score.it += (low.match(/\b(gli|perché|più)\b/g) || []).length * 2;
    let top = "en", tv = -1;
    Object.keys(score).forEach((l) => { if (score[l] > tv) { tv = score[l]; top = l; } });
    return tv >= 2 ? top : null;
  }

  function setBadge(l) { $("langBadge").textContent = "Idioma: " + (l ? LANG_NAMES[l] + " (" + l.toUpperCase() + ")" : "—"); }
  function updateGt(text) {
    $("gtLink").setAttribute("href", "https://translate.google.com/?sl=auto&tl=pt&op=translate&text=" + enc(String(text || "").slice(0, 3000)));
  }

  function splitChunks(text, max) {
    const chunks = [];
    let cur = "";
    const push = (line) => {
      if (cur && (cur + "\n" + line).length > max) { chunks.push(cur); cur = line; }
      else cur = cur ? cur + "\n" + line : line;
    };
    String(text).replace(/\r/g, "").split("\n").forEach((line) => {
      if (line.length <= max) { push(line); return; }
      (line.match(/[^.!?]+[.!?]*\s*/g) || [line]).forEach((p) => push(p.trim()));
    });
    if (cur) chunks.push(cur);
    return chunks;
  }

  const PTBR = [[/\bautocarro\b/gi, "ônibus"], [/\bcomboio\b/gi, "trem"], [/\btelemóvel\b/gi, "celular"], [/\bmiúdo(s)?\b/gi, "garoto$1"], [/\braparigas?\b/gi, "garota"], [/\bpequeno-almoço\b/gi, "café da manhã"]];

  async function translateChunk(chunk, lang) {
    if (!chunk.trim()) return chunk;
    const pair = lang === "pt" ? "pt-PT|pt-BR" : (lang ? lang + "|pt-BR" : "Autodetect|pt-BR");
    const d = await getJSON("https://api.mymemory.translated.net/get?q=" + enc(chunk) + "&langpair=" + enc(pair));
    let t = d && d.responseData && d.responseData.translatedText;
    if (!t || /MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID/i.test(t) || (d.responseStatus && Number(d.responseStatus) !== 200)) throw new Error("mymemory");
    t = htmlToText(t);
    if (lang === "pt") PTBR.forEach((p) => { t = t.replace(p[0], p[1]); });
    return t;
  }

  async function translateText(text, lang) {
    const parts = [];
    const chunks = splitChunks(text, 450);
    for (let i = 0; i < chunks.length; i++) parts.push(await translateChunk(chunks[i], lang));
    return parts.join("\n");
  }

  let trTok = 0;
  async function translateNow() {
    const text = $("lyricsOrig").value;
    const tk = ++trTok;
    const lang = detectLang(text);
    setBadge(lang);
    updateGt(text);
    const out = $("lyricsPt");
    out.textContent = "";
    if (!text.trim()) { $("trStatus").textContent = "Sem letra para traduzir."; return; }
    const chunks = splitChunks(text, 450);
    const res = [];
    for (let i = 0; i < chunks.length; i++) {
      $("trStatus").textContent = "Traduzindo… " + (i + 1) + "/" + chunks.length;
      try {
        const tr = await translateChunk(chunks[i], lang);
        if (tk !== trTok) return;
        res.push(tr);
        out.textContent = res.join("\n");
      } catch (e) {
        if (tk !== trTok) return;
        $("trStatus").textContent = "Tradução parcial (limite do MyMemory) — use o Google Tradutor.";
        return;
      }
    }
    $("trStatus").textContent = "✔ Traduzido para pt-BR";
  }

  async function loadLyrics(r, tk) {
    $("lyricsOrig").value = ""; $("lyricsPt").textContent = "";
    setBadge(null); updateGt("");
    $("trStatus").textContent = "Buscando letra…";
    let d = null;
    try { d = await getJSON("https://lrclib.net/api/get?artist_name=" + enc(r.artist) + "&track_name=" + enc(r.title)); } catch (e) { d = null; }
    if (!d || !(d.plainLyrics || d.syncedLyrics)) {
      try {
        const arr = await getJSON("https://lrclib.net/api/search?track_name=" + enc(sanitize(r.title)) + "&artist_name=" + enc(sanitize(r.artist)));
        d = (arr || []).find((x) => (x.plainLyrics || x.syncedLyrics) && sameArtist(x.artistName, r.artist)) || null;
      } catch (e) { d = null; }
    }
    if (tk !== S.enrichToken) return;
    if (!d) { $("trStatus").textContent = "Letra não encontrada no LRCLIB — cole a letra manualmente e clique em Traduzir."; return; }
    $("lyricsOrig").value = d.plainLyrics || String(d.syncedLyrics).replace(/\[[^\]]*\]\s*/g, "");
    translateNow();
  }

  /* =====================================================================
     13. CRÉDITOS (intérprete, compositor, letrista, autor, arranjador) + HISTÓRIA
  ===================================================================== */
  function setCredit(id, set) { const l = Array.from(set); $(id).textContent = l.length ? l.join(", ") : "—"; $(id).title = $(id).textContent; }

  async function loadCredits(r, meta, tk) {
    const roles = { composer: new Set(), lyricist: new Set(), writer: new Set(), arranger: new Set() };
    let annotation = "";
    if (meta && meta.recId) {
      try {
        const rec = await mb("recording/" + meta.recId + "?inc=work-rels");
        const ids = (rec.relations || []).filter((x) => x.work).map((x) => x.work.id).slice(0, 2);
        for (let i = 0; i < ids.length; i++) {
          const w = await mb("work/" + ids[i] + "?inc=artist-rels+annotation");
          (w.relations || []).forEach((x) => {
            if (!x.artist) return;
            const t = String(x.type || "");
            if (t === "composer" || t === "lyricist" || t === "writer") roles[t].add(x.artist.name);
            else if (/arranger|orchestrator/.test(t)) roles.arranger.add(x.artist.name);
          });
          if (w.annotation) annotation += String(w.annotation).replace(/\[\[|\]\]|'''|''/g, "") + " ";
        }
      } catch (e) { /* segue com Wikidata */ }
    }
    try {
      const wd = await wdSong(r.title, r.artist);
      wd.composers.forEach((n) => roles.composer.add(n));
      wd.lyricists.forEach((n) => roles.lyricist.add(n));
    } catch (e) { /* segue */ }
    if (tk !== S.enrichToken) return;
    $("infoPerformer").textContent = r.artist || "—";
    setCredit("infoComposer", roles.composer); setCredit("infoLyricist", roles.lyricist);
    setCredit("infoWriter", roles.writer); setCredit("infoArranger", roles.arranger);
    const names = [r.artist].concat(Array.from(roles.composer), Array.from(roles.lyricist), Array.from(roles.writer));
    loadHistory(r, names, annotation, tk);
  }

  async function loadHistory(r, names, annotation, tk) {
    const box = $("historyText"), link = $("historyLink");
    box.textContent = "Procurando registro histórico verificado…";
    link.hidden = true;
    const nt = norm(r.title), nameN = names.filter(Boolean).map(norm);
    const KW = /(cancao|cancion|song|chanson|canzone|musica|music|musique|composta|composed|composit|compuesta|composee|lyrics|letra|single|album|gravada|recorded|grabada|enregistr|registrata)/;
    const valid = (title, extract) => {
      const ne = norm(extract);
      return ne.length > 60 && (norm(title).indexOf(nt) > -1 || norm(extract.slice(0, 400)).indexOf(nt) > -1) && KW.test(ne) && nameN.some((n) => n && ne.indexOf(n) > -1);
    };
    const langs = ["pt", "en", "es", "fr", "it"];
    const qs = enc('"' + sanitize(r.title) + '" ' + sanitize(r.artist));
    const res = await Promise.allSettled(langs.map((l) => getJSON("https://" + l + ".wikipedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=0&gsrlimit=3&gsrsearch=" + qs +
      "&prop=extracts%7Cinfo&inprop=url&exintro=1&explaintext=1&exlimit=3", WD_OPT)));
    if (tk !== S.enrichToken) return;
    let found = null;
    for (let i = 0; i < langs.length && !found; i++) {
      if (res[i].status !== "fulfilled") continue;
      const pages = Object.values((res[i].value.query && res[i].value.query.pages) || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
      const p = pages.find((x) => valid(x.title || "", x.extract || ""));
      if (p) found = { lang: langs[i], extract: p.extract, url: p.fullurl };
    }
    if (!found && annotation && valid("", annotation)) found = { lang: "en", extract: annotation.trim(), url: null };
    if (!found) { box.textContent = "Nenhum registro histórico verificado para esta composição."; return; }
    let text = found.extract.trim();
    if (text.length > 900) { const cut = text.slice(0, 900); const k = cut.lastIndexOf("."); text = k > 300 ? cut.slice(0, k + 1) : cut + "…"; }
    if (found.lang !== "pt") {
      box.textContent = text + "\n\n(traduzindo para pt-BR…)";
      try { text = await translateText(text, found.lang); } catch (e) { text += "\n\n[Tradução automática indisponível]"; }
      if (tk !== S.enrichToken) return;
    }
    box.textContent = text;
    const u = found.url && safeUrl(found.url);
    if (u) { link.href = u; link.textContent = "Fonte: Wikipédia (" + found.lang + ")"; link.hidden = false; }
  }

  /* orquestra o enriquecimento da faixa atual */
  async function enrich(r) {
    const tk = ++S.enrichToken;
    S.autoStyle = styleForGenre(r.genre, r.title + r.artist);
    setCover(r.cover || null);
    $("infoPerformer").textContent = r.artist || "—";
    ["infoComposer", "infoLyricist", "infoWriter", "infoArranger"].forEach((id) => { $(id).textContent = "—"; });
    $("historyText").textContent = "Procurando registro histórico verificado…";
    $("historyLink").hidden = true;
    if (!r.artist) {
      $("lyricsOrig").value = ""; $("lyricsPt").textContent = ""; setBadge(null);
      $("trStatus").textContent = "Artista não identificado no link — cole a letra e clique em Traduzir.";
      $("historyText").textContent = "Sem artista identificado — história indisponível.";
      return;
    }
    loadLyrics(r, tk);
    let meta = null;
    try { meta = await fetchMeta(r.artist, r.title); } catch (e) { meta = null; }
    if (tk !== S.enrichToken) return;
    if (meta) {
      if (meta.year) { r.year = meta.year; $("hudYear").textContent = "Ano " + meta.year; }
      if (meta.genre && !r.genre) { r.genre = meta.genre; }
      if (r.genre) { $("hudGenre").textContent = "Gênero " + r.genre; S.genre = r.genre; S.autoStyle = styleForGenre(r.genre, r.title + r.artist); }
      renderResults();
    }
    coverCascade(r, meta, tk);
    loadCredits(r, meta, tk);
  }

  /* =====================================================================
     14. GERADOR .M3U ENRIQUECIDO
  ===================================================================== */
  const oneLine = (s) => String(s == null ? "" : s).replace(/[\r\n]+/g, " ").trim();

  function buildM3U() {
    const lines = ["#EXTM3U"];
    S.m3u.forEach((e) => {
      const gn = oneLine(e.genre) || "Desconhecido", yr = e.year ? String(e.year) : "N/D";
      lines.push("#EXTGENRE:" + gn);
      if (e.year) lines.push("#EXTYEAR:" + e.year);
      lines.push("#EXTINF:" + (e.duration > 0 ? Math.round(e.duration) : -1) + "," + oneLine(e.artist) + " - " + oneLine(e.title) + " [Gênero: " + gn + " | Ano: " + yr + "]");
      lines.push(oneLine(e.url));
    });
    return lines.join("\n");
  }
  function renderM3U() {
    $("m3uPreview").textContent = buildM3U();
    $("m3uCount").textContent = String(S.m3u.length);
  }
  async function enrichEntry(e) {
    if ((e.genre && e.year) || !e.artist || e.artist === "Desconhecido") return;
    try {
      const m = await fetchMeta(e.artist, e.title);
      if (!e.genre && m.genre) e.genre = m.genre;
      if (!e.year && m.year) e.year = m.year;
      renderM3U();
    } catch (x) { /* mantém sem enriquecer */ }
  }
  function addToM3U(r) {
    if (!r) { setStatus("Nenhuma faixa ativa para adicionar.", "warn"); return; }
    const url = r.pageUrl || r.url;
    if (r.kind !== "embed" && PREVIEW_RE.test(url + " " + r.title)) { setStatus("Não adicionado: prévia/amostra detectada.", "err"); return; }
    if (r.duration && !r.live && r.duration < MIN_DUR) { setStatus("Não adicionado: duração menor que " + MIN_DUR + "s.", "err"); return; }
    if (S.m3u.some((e) => e.url === url)) { setStatus("Faixa já está na playlist.", "warn"); return; }
    const e = { artist: r.artist || "Desconhecido", title: r.title, url: url, duration: r.duration ? Math.round(r.duration) : -1, genre: r.genre || "", year: r.year || "" };
    S.m3u.push(e);
    renderM3U();
    setStatus("Adicionado à playlist .m3u (" + S.m3u.length + ").", "ok");
    enrichEntry(e);
  }
  async function copyM3U() {
    const txt = buildM3U();
    try { await navigator.clipboard.writeText(txt); }
    catch (e) {
      const ta = document.createElement("textarea");
      ta.value = txt; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch (x) { /* sem suporte */ }
      ta.remove();
    }
    setStatus("Playlist copiada para a área de transferência.", "ok");
  }
  function downloadM3U() {
    const blob = new Blob([buildM3U() + "\n"], { type: "audio/x-mpegurl;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "playlist.m3u";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  /* =====================================================================
     15. LINK DIRETO (mídia, .m3u/.m3u8, YouTube/SoundCloud/Spotify)
  ===================================================================== */
  async function loadDirect() {
    const u = safeUrl($("urlInput").value);
    if (!u) { setStatus("Link inválido — use um endereço http(s).", "err"); return; }
    const emb = embedFor(u);
    if (emb) {
      const r = makeResult({ title: "Link externo (" + emb.provider + ")", embedUrl: emb.embedUrl, pageUrl: emb.pageUrl, provider: emb.provider, src: "Link direto" });
      S.results = []; playResult(r);
      return;
    }
    if (/\.m3u8?($|[?#])/i.test(u)) {
      setStatus("Lendo playlist…");
      try {
        const txt = await fetchText(u);
        if (/#EXT-X-/.test(txt)) {
          const r = makeResult({ title: decodeURIComponent(u.split("/").pop().split(/[?#]/)[0] || "Stream"), url: u, ext: "m3u8", live: true, src: "Stream HLS" });
          S.results = []; playResult(r);
          return;
        }
        const list = [];
        parseM3U(txt, u).forEach((e) => {
          const nm = e.info ? e.info.name : "";
          const sp = splitArtistTitle(nm);
          const r = makeResult({ title: sp ? sp.title : (nm || decodeURIComponent(e.url.split("/").pop().split(/[?#]/)[0])), artist: sp ? sp.artist : "", url: e.url,
            duration: e.info && e.info.dur > 0 ? e.info.dur : null, src: "M3U direto" });
          if (!r) return;
          if (PREVIEW_RE.test(r.url + " " + r.title)) return;
          if (r.duration && r.duration < MIN_DUR) return;
          list.push(r);
        });
        S.results = list.slice(0, 100);
        S.current = null; updateActiveBar();
        $("resultsTitle").textContent = "Playlist carregada";
        setCollapsed(false);
        renderResults();
        setStatus(S.results.length ? S.results.length + " faixa(s) na playlist." : "Nenhuma faixa válida na playlist.", S.results.length ? "ok" : "warn");
      } catch (e) {
        setStatus("Não foi possível ler a playlist (CORS ou link inválido).", "err");
      }
      return;
    }
    let nm = "Faixa";
    try { nm = decodeURIComponent(u.split("/").pop().split(/[?#]/)[0] || "Faixa"); } catch (e) { /* mantém */ }
    const sp = splitArtistTitle(cleanTitle(nm));
    const r = makeResult({ title: sp ? sp.title : nm, artist: sp ? sp.artist : "", url: u, src: "Link direto" });
    if (!r) { setStatus("Link inválido.", "err"); return; }
    S.results = []; playResult(r);
  }

  /* =====================================================================
     16. INICIALIZAÇÃO
  ===================================================================== */
  $("searchForm").addEventListener("submit", doSearch);
  $("btnToggleResults").addEventListener("click", () => setCollapsed(!S.collapsed));
  $("btnLoadUrl").addEventListener("click", loadDirect);
  $("urlInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); loadDirect(); } });
  $("btnTranslate").addEventListener("click", translateNow);
  $("btnM3uAdd").addEventListener("click", () => addToM3U(S.current));
  $("btnM3uCopy").addEventListener("click", copyM3U);
  $("btnM3uDownload").addEventListener("click", downloadM3U);
  $("btnM3uClear").addEventListener("click", () => { S.m3u = []; renderM3U(); });
  $("artistInput").addEventListener("input", () => { S.confirmed = ""; setFormMsg(""); });
  $("songInput").addEventListener("input", () => setFormMsg(""));

  forceAudible();
  setCover(null);
  setAura("hifi");
  renderM3U();
  resizeCanvas();
  requestAnimationFrame(frame);
})();
