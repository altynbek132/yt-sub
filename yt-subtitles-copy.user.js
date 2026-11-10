// ==UserScript==
// @name         YouTube: copy subtitles to clipboard
// @namespace    yt-sub-copy
// @version      1.0.0
// @description  Кнопка "📋 Subs" под видео: копирует субтитры в буфер. Shift+клик — с таймкодами. Хоткей Alt+S (Alt+Shift+S — с таймкодами).
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  'use strict';

  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- 1. Перехват запросов плеера к /api/timedtext ----------
  // YouTube часто требует токен "pot" — прямой запрос по baseUrl отдаёт пусто.
  // Поэтому запоминаем URL, который запросил сам плеер (в нём токен уже есть).
  const captured = new Map(); // videoId -> url
  const remember = (url) => {
    try {
      const u = new URL(String(url), location.href);
      if (!u.pathname.includes('/api/timedtext')) return;
      const v = u.searchParams.get('v');
      if (v) captured.set(v, u.href);
    } catch (_) {}
  };
  const origOpen = W.XMLHttpRequest.prototype.open;
  W.XMLHttpRequest.prototype.open = function (method, url) {
    remember(url);
    return origOpen.apply(this, arguments);
  };
  const origFetch = W.fetch;
  W.fetch = function (input) {
    remember(typeof input === 'string' ? input : input && input.url);
    return origFetch.apply(this, arguments);
  };

  // ---------- helpers ----------
  const getVideoId = () => new URL(location.href).searchParams.get('v');
  const getPlayer = () => W.document.getElementById('movie_player');

  function getPlayerResponse() {
    const p = getPlayer();
    try {
      const r = p && p.getPlayerResponse && p.getPlayerResponse();
      if (r && r.videoDetails && r.videoDetails.videoId === getVideoId()) return r;
    } catch (_) {}
    const r = W.ytInitialPlayerResponse;
    if (r && r.videoDetails && r.videoDetails.videoId === getVideoId()) return r;
    return null;
  }

  function pickTrack(tracks) {
    if (!tracks || !tracks.length) return null;
    const manual = tracks.filter((t) => t.kind !== 'asr');
    const prefLangs = [...new Set([...(navigator.languages || []), 'ru', 'en'].map((l) => l.split('-')[0]))];
    for (const lang of prefLangs) {
      const t = manual.find((t) => t.languageCode.split('-')[0] === lang);
      if (t) return t;
    }
    return manual[0] || tracks[0];
  }

  const fmtTime = (ms) => {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const mm = String(m).padStart(h ? 2 : 1, '0'), ss = String(sec).padStart(2, '0');
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  };

  // json3 -> [{t, text}]
  function parseJson3(data) {
    return (data.events || [])
      .filter((e) => e.segs)
      .map((e) => ({ t: e.tStartMs || 0, text: e.segs.map((s) => s.utf8).join('').replace(/\s+/g, ' ').trim() }))
      .filter((l) => l.text);
  }

  async function fetchJson3(url, lang) {
    const u = new URL(url, location.href);
    u.searchParams.set('fmt', 'json3');
    if (lang) u.searchParams.set('lang', lang);
    u.searchParams.delete('tlang');
    const res = await origFetch.call(W, u.href, { credentials: 'include' });
    const txt = await res.text();
    if (!txt) return null;
    const lines = parseJson3(JSON.parse(txt));
    return lines.length ? lines : null;
  }

  // ---------- способ A: baseUrl из playerResponse ----------
  async function viaBaseUrl(track) {
    return fetchJson3(track.baseUrl);
  }

  // ---------- способ B: включить CC, поймать URL плеера (с pot) ----------
  async function viaCapturedUrl(track) {
    const vid = getVideoId();
    const fromPerf = () => W.performance.getEntriesByType('resource').forEach((e) => remember(e.name));
    fromPerf();
    if (!captured.has(vid)) {
      const p = getPlayer();
      if (!p) return null;
      const wasOn = !!(p.getOption && p.getOption('captions', 'track') && p.getOption('captions', 'track').languageCode);
      try { p.toggleSubtitlesOn ? p.toggleSubtitlesOn() : p.loadModule('captions'); } catch (_) {}
      for (let i = 0; i < 30 && !captured.has(vid); i++) { await sleep(150); fromPerf(); }
      if (!wasOn) try { p.toggleSubtitles && p.toggleSubtitles(); } catch (_) {}
    }
    const url = captured.get(vid);
    if (!url) return null;
    return fetchJson3(url, track && track.languageCode);
  }

  // ---------- способ C: панель "Показать расшифровку" ----------
  async function viaTranscriptPanel() {
    const d = W.document;
    const segSel = 'ytd-transcript-segment-renderer, transcript-segment-view-model';
    if (!d.querySelector(segSel)) {
      const btn = d.querySelector('ytd-video-description-transcript-section-renderer button, button[aria-label*="ranscript"], button[aria-label*="асшифровк"]');
      if (!btn) return null;
      btn.click();
      for (let i = 0; i < 40 && !d.querySelector(segSel); i++) await sleep(200);
    }
    const segs = [...d.querySelectorAll(segSel)];
    if (!segs.length) return null;
    return segs.map((s) => {
      const ts = s.querySelector('.segment-timestamp, [class*="imestamp" i]');
      const tx = s.querySelector('.segment-text, span[role="text"], yt-formatted-string:not([class*="timestamp"])');
      const tStr = ts ? ts.textContent.trim() : '';
      const t = tStr.split(':').reduce((a, n) => a * 60 + (+n || 0), 0) * 1000;
      return { t, text: (tx ? tx.textContent : s.textContent.replace(tStr, '')).replace(/\s+/g, ' ').trim() };
    }).filter((l) => l.text);
  }

  // ---------- main ----------
  async function copySubtitles(withTimestamps) {
    if (!getVideoId()) return toast('Это не страница видео');
    toast('Достаю субтитры…');
    const pr = getPlayerResponse();
    const tracks = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer &&
      pr.captions.playerCaptionsTracklistRenderer.captionTracks;
    const track = pickTrack(tracks);

    let lines = null, err, usedPanel = false;
    // A: прямой URL (дёшево, но часто пусто из-за pot) → C: панель расшифровки (надёжно) → B: включить CC и перехватить
    const methods = track ? [() => viaBaseUrl(track), viaTranscriptPanel, () => viaCapturedUrl(track)] : [viaTranscriptPanel];
    for (const m of methods) {
      try { lines = await m(); } catch (e) { err = e; console.warn('[yt-sub-copy]', e); }
      if (lines && lines.length) { usedPanel = m === viaTranscriptPanel; break; }
    }
    if (!lines || !lines.length) return toast('Субтитры не найдены' + (err ? ': ' + err.message : ''), true);

    const title = (pr && pr.videoDetails && pr.videoDetails.title) || d0().title;
    const body = withTimestamps
      ? lines.map((l) => `[${fmtTime(l.t)}] ${l.text}`).join('\n')
      : lines.map((l) => l.text).join(' ').replace(/\s+/g, ' ').trim();
    const text = `${title}\n${location.href}\n\n${body}\n`;

    if (typeof GM_setClipboard === 'function') GM_setClipboard(text, 'text');
    else await navigator.clipboard.writeText(text);
    const lang = usedPanel ? 'расшифровка' : track ? `${track.languageCode}${track.kind === 'asr' ? ' (авто)' : ''}` : '?';
    toast(`Скопировано: ${lines.length} строк, ${text.length} симв. [${lang}]`);
  }
  const d0 = () => W.document;

  // ---------- UI ----------
  let toastEl;
  function toast(msg, isErr) {
    const d = d0();
    if (!toastEl) {
      toastEl = d.createElement('div');
      Object.assign(toastEl.style, {
        position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)', zIndex: 99999,
        padding: '10px 16px', borderRadius: '8px', font: '14px Roboto, Arial, sans-serif', color: '#fff',
        boxShadow: '0 4px 12px rgba(0,0,0,.3)', transition: 'opacity .3s', pointerEvents: 'none',
      });
      d.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.style.background = isErr ? '#c62828' : '#323232';
    toastEl.style.opacity = '1';
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => (toastEl.style.opacity = '0'), 3000);
  }

  function addButton() {
    const d = d0();
    if (!getVideoId() || d.getElementById('yt-sub-copy-btn')) return;
    const host = d.querySelector('#top-level-buttons-computed') || d.querySelector('ytd-watch-metadata #actions');
    if (!host) return;
    const b = d.createElement('button');
    b.id = 'yt-sub-copy-btn';
    b.textContent = '📋 Subs';
    b.title = 'Копировать субтитры (Shift+клик — с таймкодами)';
    Object.assign(b.style, {
      marginLeft: '8px', padding: '0 14px', height: '36px', borderRadius: '18px', border: 'none', cursor: 'pointer',
      font: '500 14px Roboto, Arial, sans-serif', background: 'var(--yt-spec-badge-chip-background, #f2f2f2)',
      color: 'var(--yt-spec-text-primary, #0f0f0f)', whiteSpace: 'nowrap',
    });
    b.addEventListener('click', (e) => copySubtitles(e.shiftKey));
    host.appendChild(b);
  }

  W.document.addEventListener('keydown', (e) => {
    if (e.altKey && e.code === 'KeyS' && !e.ctrlKey && !e.metaKey) {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
      e.preventDefault();
      copySubtitles(e.shiftKey);
    }
  }, true);

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Копировать субтитры', () => copySubtitles(false));
    GM_registerMenuCommand('Копировать субтитры с таймкодами', () => copySubtitles(true));
  }

  setInterval(addButton, 1000);
  W.document.addEventListener('yt-navigate-finish', () => setTimeout(addButton, 500));
})();
