export const PROMPT = `# ROLE
Act as a Principal Full-Stack Engineer, Senior UX/UI & Digital Audio Designer, and Senior Prompt Architect. You write production code only: no placeholders, no TODOs, no pseudo-code, no "rest of code here".

# OBJECTIVE
Deliver a commercial-grade, zero-build, portable Web Audio Player that runs directly from a USB Drive folder (file://) or GitHub Pages. No Node.js, no bundlers, no paid API keys, no external JS/CSS libraries.
Output EXACTLY 3 root files in the same folder: index.html, style.css, app.js.

# PRIORITY ORDER (when requirements conflict, the higher item wins)
1. Audio always audible (anti-mute rule)  2. Exact-artist verification and search relevance  3. Zero layout shift  4. Security (XSS)  5. Visual polish  6. Extra features.
If a feature cannot work under file:// (CORS), degrade gracefully and show a short status message; never throw uncaught errors and never leave a spinner running forever (every request has a timeout of 8s).

# 1. ARCHITECTURE & PATH CONSTRAINTS
- index.html references strictly ./style.css and ./app.js (relative, same folder).
- app.js is wrapped in a "use strict" IIFE. No globals except what is strictly needed for JSONP callbacks (namespaced, e.g. __jp_<random>, deleted after use).
- 100% DOM ID alignment: before writing, list every ID used in HTML, CSS and JS; every ID referenced in JS must exist in HTML (use a single const $ = id => document.getElementById(id) helper and a boot-time check that logs missing IDs to console.warn).
- All dynamic text is inserted with textContent / setAttribute on validated URLs. Never use innerHTML with remote data. Only allow http(s) URLs.

# 2. VISUAL DESIGN: WINAMP HERITAGE + LUXURY GLASSMORPHISM
- Fuse classic Winamp ergonomics (metallic titlebar with active LEDs and a live BEAT LED, glowing OLED digital clock, scrolling marquee, tactile Play/Pause/Stop/Loop/Mute/Volume/Speed controls) with modern glassmorphism (blur, specular borders), a beat-reactive artwork halo (CSS vars --beat-scale, --beat-glow) and a dynamic ambient backdrop (--aura-primary, --aura-secondary, derived from the cover or genre).
- Zero layout shift (CLS = 0): fixed deterministic heights for the LCD/OLED display, spectrum canvas stage, single-line ellipsis status bars and internally scrollable panels. Use scrollbar-gutter: stable, min-width: 0 on flex/grid children and [hidden]{display:none !important}. Async data must never move neighbouring elements (reserve space, swap content in place).
- Responsive: Desktop (>1024px), Tablet (<=1024px), Mobile (<=640px). Touch targets min-height 40px. Respect prefers-reduced-motion (reduce, not remove, animation).
- Accessibility: visible focus rings, aria-labels on icon buttons, aria-live="polite" on status/results messages, keyboard shortcuts (Space = play/pause, Esc = exit immersive mode).

# 3. AUDIO OUTPUT & VISUALIZERS
CRITICAL ANTI-MUTE RULE: NEVER call AudioContext.createMediaElementSource(). Keep native HTML5 <audio> output direct. On init AND on every Play: audio.defaultMuted = false; audio.muted = false; audio.volume = 0.95 (kept in sync with the volume slider).
Safe analysis: try audio.captureStream() (or mozCaptureStream) inside try/catch, connect ONLY to an AnalyserNode (never to destination). From the FFT extract in real time:
 (a) adaptive beat-kick detector on low bins (moving-average threshold + refractory period) -> flashes BEAT LED, pulses the cover halo, spawns shockwaves;
 (b) spectral centroid + mid-band energy (melody) -> wave elevation, angular rotation, phase velocity;
 (c) high-frequency shimmer -> orbital particles and upper LEDs.
Fallback when captureStream is unavailable or the stream is CORS-silent (all-zero data for 2s): drive 60fps visuals from a genre-calibrated BPM + melodic synthesis synchronised to audio.currentTime and playbackRate. HUD badge shows "FFT Ao Vivo" or "Sync Melódico".
Canvas 2D, HiDPI (devicePixelRatio, ResizeObserver, requestAnimationFrame, paused when the tab is hidden). 6 styles + "Genre Auto": (1) Winamp LED bars + floor reflection + peak-hold, (2) dual symmetrical glow (globalCompositeOperation "lighter"), (3) circular bass reactor (rotating vinyl cover + shockwaves + particles), (4) melodic aurora ribbons, (5) 3D cyber grid & tunnel, (6) CRT oscilloscope. Plus Expanded Immersion mode (Esc exits).

# 4. SEARCH UI WITH EXACT-ARTIST GATE (NEW)
## 4.1 Two-field search form (no single free-text box)
- Field A, #artistInput (required): label "Nome exato do cantor/artista". Placeholder: "Ex.: Roberto Carlos". Permanent helper text under the field (id #artistHint, linked via aria-describedby): "⚠ Digite o nome EXATO do cantor (com acentos e sobrenome). Nomes incompletos ou com erro não retornam resultados."
- Field B, #songInput (required, min 2 characters after trimming): label "Trecho da música (título ou parte da letra)". Placeholder: "Ex.: Detalhes, ou 'se alguém lhe perguntar'". Helper text: "Informe o título ou um trecho da letra para trazer as melhores respostas."
- Submit is blocked with an inline message (not alert()) if either field is empty or invalid. Enter key submits.
- Because artist and song are separate fields, hyphens never need to be parsed from a single string. Still sanitize BOTH fields before any API call: normalize Unicode (NFC), replace -, –, — and Lucene special characters (+ && || ! ( ) { } [ ] ^ " ~ * ? : / ) with spaces, collapse whitespace, trim. Keep the original display text for the UI.

## 4.2 Exact artist verification (runs BEFORE any media/lyrics search)
1. norm(s) = lowercase, NFD with diacritics removed, punctuation stripped, whitespace collapsed.
2. Query MusicBrainz artist search (JSONP/fetch, limit 10, fmt=json, query=artist:"<sanitized>"). Also query iTunes (entity=musicArtist) and Deezer (JSONP /search/artist) in parallel with Promise.allSettled to collect candidate names and aliases.
3. VERIFIED = a candidate whose norm(name) OR any norm(alias) strictly equals norm(input) and (MusicBrainz score >= 90 OR confirmed by a second source). Substring or fuzzy matches NEVER count as verified.
4. If VERIFIED: store canonicalName, MBID and alias set in state; show a green chip "✔ Artista verificado: <canonicalName>" in #artistStatus (fixed height, ellipsis).
5. If NOT verified: STOP. Do not call audio/video/M3U/lyrics search APIs. Render in #resultsBody a message in pt-BR: "Artista '<input>' não encontrado com esse nome exato. Você quis dizer:" followed by up to 5 clickable suggestion buttons (#suggestions). Suggestions come from the candidates of step 2, ranked by similarity (Dice coefficient on bigrams + Levenshtein distance on norm() strings; keep only similarity >= 0.5; de-duplicate by norm). Clicking a suggestion fills #artistInput with the canonical spelling and re-runs the search automatically. If there are zero candidates, show: "Nenhuma sugestão encontrada. Verifique a grafia e tente novamente."
6. If all verification sources fail due to network/CORS: show "Não foi possível verificar o artista agora (sem conexão com as bases de dados). Tente novamente." Do NOT fall back to unverified search.

## 4.3 Artist filter applied to every result
After verification, a result is kept ONLY if its artist metadata (uploader/creator/artist/title prefix/#EXTINF artist) has norm() equal to canonicalName or any alias, OR it comes from a source query constrained by the verified MBID. Everything else is discarded, including covers by other artists and compilations that merely mention the name in the description.

## 4.4 Song-content relevance filter and ranking
Tokenize norm(songInput) into tokens (drop stopwords in pt/en/es: a, o, de, da, do, the, of, la, el, e, y, and...). Score each candidate (0-100):
- +50 exact title equality with the song text; +35 title contains all tokens; +20 contains >= 60% of tokens;
- +25 if the song text (or >= 60% of its tokens) is found in the lyric text returned by LRCLIB /api/search?q=<song text>&artist_name=<canonicalName> for that track;
- +10 matching duration within 10% of the LRCLIB/MusicBrainz duration; +10 browser-playable format; -30 live/karaoke/instrumental/cover/tribute/remix patterns when the user did not ask for them.
Discard score < 40. Sort descending. Cap at 30 results. If nothing passes, show: "Nenhuma faixa de <canonicalName> contém '<song text>'. Tente outro trecho do título ou da letra." and show up to 5 title suggestions from MusicBrainz recordings by that MBID (clickable, they fill #songInput).
Each result row shows: title, artist, year (if known), format badge, source badge, relevance badge ("Título", "Letra" or "Título+Letra"), and an "Ouvir" button.

# 5. MULTI-SOURCE SEARCH, .M3U MINING & COLLAPSIBLE DRAWER
- file:// resilience: use JSONP first (with a fetch fallback) for APIs rejecting a null origin. Never surface "Failed to fetch"; map errors to friendly pt-BR messages. Run sources in parallel with Promise.allSettled and an 8s timeout each; one failing source must not block the others.
- Sources (always constrained by the verified artist): Audius, Internet Archive (audio + movies), Wikimedia Commons (audio + video), MusicBrainz url-rels. Support every extension: .mp3 .mp4 .m4a .flac .ogg .oga .opus .wav .aac .wma .rma .rm .rmvb .rmv .ram .webm .mkv .avi .3gp. Prioritise formats playable in <audio> (check audioTracks where supported, audio-only mode); flag legacy codecs (.rma .rmv .wma) as "Somente via .m3u (VLC/Winamp)".
- .m3u/.m3u8 mining: search public playlists (Internet Archive, Radio-Browser, open GitHub .m3u files) that mention the verified artist; parse #EXTINF lines and keep entries that pass 4.3 and 4.4.
- Anti-sample filter: reject previews/samples (duration < 45s or URL patterns like preview, sample, snippet, 30s, clip) in search, on loadedmetadata, and in the M3U builder.
- No-download streaming: controlsList="nodownload", block contextmenu on the player deck, hide internal search stream URLs from the direct-link input. Accept direct media/M3U URLs and official embeds (YouTube, SoundCloud, Spotify) via validated iframes.
- Preserved collapsible results: clicking "Ouvir" NEVER deletes the list. Collapse the body (fixed-height container), show a compact active-track bar and an "Expandir resultados (N)" button to reopen at any time with the scroll position preserved.

# 6. ORIGINAL RECORDING YEAR & COVER FALLBACK
- Original year: scan multiple MusicBrainz recordings (first-release-date, releases[].date), Wikidata (P577) and iTunes metadata (metadata only, never preview audio). Pick the earliest valid year between 1900 and the current year; ignore upload/reissue dates.
- Cover cascade when the media has no art: Cover Art Archive -> iTunes Artwork (replace 100x100 with 600x600) -> Deezer cover (JSONP) -> Wikipedia PageImage -> inline SVG fallback via onerror. Cover container has a fixed aspect ratio (no shift).

# 7. LYRICS (ORIGINAL LANGUAGE) + AUTO-TRANSLATION TO PT-BR
- Auto-fetch original lyrics from LRCLIB into an editable <textarea> (no language selector UI anywhere).
- Client-side language detection (PT, EN, ES, FR, IT, DE, JA, KO, RU, AR, EL) by Unicode script ranges + stopword frequency; show a detected-language badge.
- ALWAYS translate to Brazilian Portuguese through chunked MyMemory requests (<= 450 chars per chunk, split on line breaks, rejoin preserving blank lines), even if the source is Portuguese (use langpair pt-PT|pt-BR and normalise). Provide a Google Translate link (sl=auto&tl=pt) as fallback when MyMemory fails or rate-limits. Both panels are fixed-height and internally scrollable.

# 8. COMPOSITION, COMPOSER & LYRICIST HISTORY
- Cross-query MusicBrainz (recording -> work-rels -> work -> artist-rels + annotation), Wikidata (P86 composer, P676 lyricist) and Wikipedia (pt, en, es, fr, it). Separate Performer, Composer(s), Lyricist(s), Writer(s) and Arranger(s).
- Strict anti-filler: show a composition history/bio only if the text contains the song title AND at least one musical keyword (canção, música, song, composta, lyrics, álbum, single...) AND the performer, composer or lyricist name. Otherwise omit the section entirely (no generic or homonym articles). Auto-translate non-Portuguese extracts to pt-BR.

# 9. ENRICHED .M3U GENERATOR
Generate a playlist: #EXTM3U, then per track #EXTGENRE:<genre>, #EXTYEAR:<original_year>, #EXTINF:<duration>,<artist> - <title> [Gênero: <genre> | Ano: <year>], then the URL. Auto-enrich missing genre/year via MusicBrainz/iTunes metadata. Provide live preview (fixed-height <pre>), clipboard copy (navigator.clipboard with textarea/execCommand fallback for file://) and a playlist.m3u Blob download. The builder applies the same artist and anti-sample filters.

# 10. QUALITY GATES (self-audit BEFORE you output code)
Verify and fix silently, then print a 12-line checklist with PASS/FAIL:
1 No innerHTML with remote data (textContent only).  2 Zero createMediaElementSource occurrences.  3 Only ./style.css and ./app.js referenced.  4 Every JS-referenced ID exists in HTML.  5 Exact-artist gate blocks all searches when unverified.  6 Suggestions render and are clickable.  7 Artist hint visible under #artistInput.  8 Song relevance score >= 40 enforced.  9 Anti-sample filter in 3 places.  10 CLS-safe fixed heights.  11 Every network call has a timeout and a friendly error.  12 Syntax valid (no unmatched braces, no undefined variables).
Manual test cases that must pass: (a) "Roberto Carlos" + "Detalhes" -> verified, results; (b) "Roberto Carlo" + "Detalhes" -> not verified, suggestion "Roberto Carlos"; (c) "Roberto Carlos" + "xyzxyz" -> no-track message with title suggestions; (d) empty song field -> inline validation; (e) offline -> friendly verification error.

# 11. OUTPUT FORMAT
1) One-paragraph architecture summary. 2) The 3 files, each in its own fenced code block labelled with the file name (index.html, style.css, app.js), complete and ready to paste. 3) The PASS/FAIL checklist. 4) Short instructions: saving to a USB Drive (copy the three files into one folder, open index.html with a double-click) and publishing on GitHub Pages (create repo, upload the 3 files to the root, Settings > Pages > Deploy from branch > main / root). No other commentary.`;

export const CHANGES = [
  {
    n: "1",
    title: "Verificação do nome exato do cantor",
    items: [
      "Portão de verificação antes de qualquer busca (MusicBrainz + iTunes + Deezer em paralelo).",
      "Só aceita igualdade exata após normalização (acentos, caixa, pontuação) ou alias oficial.",
      "Resultados filtrados: só faixas cujo artista é o verificado (ou MBID).",
      "Se não encontrar: mensagem em pt-BR com até 5 sugestões clicáveis (Dice + Levenshtein) que refazem a busca.",
    ],
  },
  {
    n: "2",
    title: "Campo de busca com aviso e filtro por conteúdo",
    items: [
      "Dois campos: artista (nome exato) e trecho da música (título ou letra).",
      "Aviso permanente sob o campo, com aria-describedby e placeholder de exemplo.",
      "Pontuação de relevância 0–100 (título, letra via LRCLIB, duração, formato) com corte em 40.",
      "Selos 'Título', 'Letra' ou 'Título+Letra' e sugestões de títulos quando nada passa.",
    ],
  },
  {
    n: "3",
    title: "Prompt mais eficaz",
    items: [
      "Ordem de prioridade explícita para resolver conflitos entre requisitos.",
      "Seções numeradas, regras testáveis, timeouts e erros amigáveis definidos.",
      "Checklist de auditoria PASS/FAIL e 5 casos de teste manuais.",
      "Formato de saída fechado: 3 arquivos completos, sem placeholders, mais instruções USB/GitHub.",
    ],
  },
];
