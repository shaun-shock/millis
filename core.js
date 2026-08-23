/* ============================================================
   ERROR MARGIN — core engine

   Note: localStorage keys stay on the "millis.*" prefix from the
   original name. They are invisible to players, and renaming them
   would wipe every saved best, roster and daily result on upgrade.
   Screens, mode registry, timing helpers, audio, results, bests.
   Modes register themselves via TT.mode({...}) and drive the
   play screen through the ctx object handed to start().
   ============================================================ */
window.TT = (function () {

  /* ---------- element refs ---------- */
  const $ = (id) => document.getElementById(id);
  const el = {};
  const screens = {};

  /* ---------- mode registry ---------- */
  const modes = [];
  let current = null;      // { def, api } of the running mode
  let cleanups = [];       // teardown fns for the running mode

  /* ---------- persistence ---------- */
  const STORE = 'millis.bests.v1';
  function loadBests() {
    try { return JSON.parse(localStorage.getItem(STORE)) || {}; }
    catch (e) { return {}; }
  }
  function saveBests(b) {
    try { localStorage.setItem(STORE, JSON.stringify(b)); } catch (e) {}
  }
  let bests = loadBests();

  /* ---------- roster (pass-and-play) ---------- */
  const ROSTER = 'millis.roster.v1';
  const MAX_PLAYERS = 6;
  function loadRoster() {
    try {
      const r = JSON.parse(localStorage.getItem(ROSTER));
      if (Array.isArray(r) && r.length) return r.slice(0, MAX_PLAYERS);
    } catch (e) {}
    return ['You'];
  }
  function saveRoster() {
    try { localStorage.setItem(ROSTER, JSON.stringify(roster)); } catch (e) {}
  }
  let roster = loadRoster();

  /* ---------- seeded RNG ----------
     Every player in a match must face the identical challenge, so the
     randomness modes pull from is seeded once per match and replayed
     for each player. Solo play seeds from Math.random and never repeats. */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  let rng = mulberry32((Math.random() * 4294967295) >>> 0);

  /* ---------- daily challenge ----------
     One challenge a day, identical for everyone on earth, because the
     seed is derived from the date rather than from Math.random. */
  const EPOCH = Date.UTC(2026, 7, 22);      /* day #1 — 22 Aug 2026 */
  const DAY_MS = 86400000;
  const DAILY_STORE = 'millis.daily.v1';

  /* local calendar date, so "today" matches the player's day */
  function todayKey(d) {
    const t = d || new Date();
    const m = String(t.getMonth() + 1).padStart(2, '0');
    const day = String(t.getDate()).padStart(2, '0');
    return t.getFullYear() + '-' + m + '-' + day;
  }
  function dayNumber(d) {
    const t = d || new Date();
    const local = Date.UTC(t.getFullYear(), t.getMonth(), t.getDate());
    return Math.max(1, Math.round((local - EPOCH) / DAY_MS) + 1);
  }
  /* hash the date string so consecutive days aren't neighbouring seeds */
  function dailySeed(key) {
    let h = 2166136261;
    const s = key || todayKey();
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  /* The daily is always hard — one attempt, no practice run, so it
     should be the version worth bragging about. The mode rotates so
     it doesn't go stale. */
  const DAILY_ROTATION = [
    { id: 'blindstop', opts: { diff: 'hard' } },
    { id: 'interval', opts: { diff: 'hard' } },
    { id: 'estimate', opts: { diff: 'hard' } }
  ];
  function dailyPick(n) { return DAILY_ROTATION[(n - 1) % DAILY_ROTATION.length]; }

  function loadDaily() {
    try { return JSON.parse(localStorage.getItem(DAILY_STORE)) || {}; }
    catch (e) { return {}; }
  }
  function saveDaily(d) {
    try { localStorage.setItem(DAILY_STORE, JSON.stringify(d)); } catch (e) {}
  }
  let daily = loadDaily();
  const playedToday = () => daily[todayKey()] || null;

  /* ---------- wake lock ----------
     A 60s Split has long gaps between taps; without this the screen
     can dim mid-run, which is both ugly and a distraction. */
  let wakeLock = null;
  function keepAwake(on) {
    try {
      if (on) {
        if (wakeLock || !navigator.wakeLock) return;
        navigator.wakeLock.request('screen').then((wl) => {
          wakeLock = wl;
          wl.addEventListener('release', () => { wakeLock = null; });
        }).catch(() => {});
      } else if (wakeLock) {
        wakeLock.release().catch(() => {});
        wakeLock = null;
      }
    } catch (e) {}
  }

  /* best is "lower score is better" unless the mode says otherwise.
     key is usually the mode id, but a mode with difficulties passes
     its own ("blindstop:hard") so variants keep separate records. */
  function recordBest(key, score, higherIsBetter) {
    if (score == null || !isFinite(score)) return { best: null, isNew: false };
    const prev = bests[key];
    const better = prev == null || (higherIsBetter ? score > prev : score < prev);
    if (better) { bests[key] = score; saveBests(bests); }
    return { best: bests[key], isNew: better && prev != null ? true : prev == null };
  }

  /* ---------- audio (lazy, one shared context) ---------- */
  let actx = null, master = null;
  function audio() {
    if (!actx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      actx = new AC();
      /* everything runs through one bus, with a limiter so the loud
         cues can sit high without clipping into distortion */
      master = actx.createGain();
      master.gain.value = 0.9;
      let out = master;
      if (actx.createDynamicsCompressor) {
        const comp = actx.createDynamicsCompressor();
        comp.threshold.value = -8;
        comp.ratio.value = 12;
        comp.attack.value = 0.002;
        comp.release.value = 0.12;
        master.connect(comp);
        out = comp;
      }
      out.connect(actx.destination);
    }
    if (actx.state === 'suspended') actx.resume();
    return actx;
  }

  /* Short percussive tone. A square through a lowpass reads far louder
     than a sine at the same amplitude — more harmonics for the ear to
     grab — while the filter keeps it from sounding harsh. */
  function tone(freq, dur, gain, type, when) {
    const c = audio(); if (!c) return;
    const t = (when == null ? c.currentTime : when);
    const d = dur || 0.09;
    const peak = gain == null ? 0.6 : gain;
    const f = freq || 880;

    const osc = c.createOscillator();
    osc.type = type || 'square';
    osc.frequency.setValueAtTime(f, t);

    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(Math.min(9000, f * 4.5), t);

    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.005);
    g.gain.setValueAtTime(peak, t + d * 0.55);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);

    osc.connect(lp).connect(g).connect(master);
    osc.start(t);
    osc.stop(t + d + 0.02);
  }

  /* general purpose blip — louder than it used to be */
  function blip(freq, dur, gain) {
    tone(freq, dur || 0.09, gain == null ? 0.55 : gain, 'square');
  }

  /* THE start signal: two rising tones, long and loud enough to hear
     across a room with the phone flat on a table. */
  function beep() {
    const c = audio(); if (!c) return;
    const t = c.currentTime;
    tone(880, 0.11, 0.75, 'square', t);
    tone(1320, 0.20, 0.85, 'square', t + 0.12);
  }
  function buzz(ms) {
    if (navigator.vibrate) { try { navigator.vibrate(ms || 12); } catch (e) {} }
  }

  /* ---------- formatting ---------- */
  function fmtMs(ms) {
    const v = Math.round(ms);
    return (v >= 0 ? '' : '-') + Math.abs(v) + 'ms';
  }
  function fmtSigned(ms) {
    const v = Math.round(ms);
    return (v > 0 ? '+' : v < 0 ? '-' : '±') + Math.abs(v) + 'ms';
  }
  /* 5.000 style clock from milliseconds */
  function fmtClock(ms) {
    const s = Math.max(0, ms) / 1000;
    return s.toFixed(3);
  }

  /* rating band shared by every mode: tighter = better */
  function band(errMs, goodMs, warnMs) {
    const e = Math.abs(errMs);
    if (e <= (goodMs == null ? 60 : goodMs)) return 'good';
    if (e <= (warnMs == null ? 180 : warnMs)) return 'warn';
    return 'bad';
  }
  const BAND_CLASS = { good: 'is-good', warn: 'is-warn', bad: 'is-bad' };
  const BAND_WORD = { good: 'Locked in', warn: 'Close', bad: 'Off' };

  /* ---------- sheet: how-to-play and confirmations ----------
     One overlay serves both. It sits above the tap surface, so a run
     can't register taps through it. */
  let sheetOpen = false;

  function openSheet(title, buildBody, actions) {
    const s = $('sheet');
    $('sheet-title').textContent = title;
    const body = $('sheet-body');
    body.innerHTML = '';
    buildBody(body);
    const act = $('sheet-actions');
    act.innerHTML = '';
    actions.forEach((a, i) => {
      const b = document.createElement('button');
      b.className = 'btn ' + (a.primary ? 'btn-primary' : 'btn-ghost');
      b.textContent = a.label;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        closeSheet();
        if (a.run) a.run();
      });
      act.appendChild(b);
    });
    s.hidden = false;
    sheetOpen = true;
  }

  function closeSheet() {
    $('sheet').hidden = true;
    sheetOpen = false;
  }

  /* which modes the player has already been shown the rules for */
  const SEEN = 'millis.seen.v1';
  function loadSeen() {
    try { return JSON.parse(localStorage.getItem(SEEN)) || {}; } catch (e) { return {}; }
  }
  let seen = loadSeen();
  function markSeen(id) {
    seen[id] = 1;
    try { localStorage.setItem(SEEN, JSON.stringify(seen)); } catch (e) {}
  }

  function showHow(def, firstTime) {
    if (!def || !def.how || !def.how.length) return;
    openSheet('How to play · ' + def.name, (body) => {
      def.how.forEach((line, i) => {
        const row = document.createElement('div');
        row.className = 'step';
        const n = document.createElement('div');
        n.className = 'step-n';
        n.textContent = String(i + 1);
        const t = document.createElement('div');
        t.className = 'step-t';
        t.textContent = line;
        row.appendChild(n); row.appendChild(t);
        body.appendChild(row);
      });
    }, [{ label: firstTime ? 'Got it' : 'Back to the game', primary: true }]);
    markSeen(def.id);
  }

  function confirmQuit() {
    const inMatch = match && match.names.length > 1;
    openSheet('Leave this game?', (body) => {
      const p = document.createElement('p');
      p.textContent = inMatch
        ? 'This match is not finished. Everyone\'s scores so far will be lost.'
        : 'This run is not finished. Your progress in it will be lost.';
      body.appendChild(p);
    }, [
      { label: 'Keep playing', primary: true },
      /* where people abandon is as informative as where they finish */
      { label: 'Leave', run: () => {
        if (window.Track && current) Track.event('quit_run', { mode: current.def.id });
        home();
      } }
    ]);
  }

  /* ---------- screens ---------- */
  /* Single choke point for the ad layer: entering the play screen
     freezes all ad activity, and only the calm screens may show one.
     Keeping this here means no mode can accidentally run an ad. */
  function show(name) {
    if (sheetOpen) closeSheet();   /* never carry a sheet across screens */
    Object.keys(screens).forEach((k) => screens[k].classList.toggle('active', k === name));
    keepAwake(name === 'play');
    if (window.Track) Track.setPlaying(name === 'play');
    if (!window.Ads) return;
    Ads.setPlaying(name === 'play');
    if (name === 'home' || name === 'result' || name === 'board') Ads.showBanner(name);
    else Ads.hideBanner();
  }

  /* ---------- mode colours ----------
     Each mode gets an identity colour, deliberately drawn from cyan →
     pink and never green/amber/red, because those three are reserved
     for good/close/miss feedback and must not become decorative. */
  const DEFAULT_MODE_COLOR = '#8B8B95';

  function hexRgba(hex, a) {
    const h = (hex || DEFAULT_MODE_COLOR).replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  function paint(el2, def) {
    const c = def && def.color ? def.color : DEFAULT_MODE_COLOR;
    el2.style.setProperty('--mode', c);
    el2.style.setProperty('--mode-dim', hexRgba(c, 0.16));
    el2.style.setProperty('--mode-glow', hexRgba(c, 0.30));
  }

  /* ---------- home ---------- */
  function bestNote(def, key, label) {
    const v = bests[key];
    if (v == null) return '';
    return 'best ' + def.formatBest(v) + (label ? ' ' + label : '');
  }

  function rosterLabel() {
    const names = roster.map((n, i) => (n || '').trim() || ('Player ' + (i + 1)));
    if (names.length === 1) return 'Solo — ' + names[0];
    return names.length + ' players — ' + names.join(', ');
  }

  function renderPartyBar() {
    const bar = $('party-bar');
    bar.innerHTML = '';
    const box = document.createElement('div');
    box.style.minWidth = '0';
    const k = document.createElement('div');
    k.className = 'pb-k';
    k.textContent = roster.length > 1 ? 'Pass and play' : 'Playing';
    const v = document.createElement('div');
    v.className = 'pb-v';
    v.textContent = rosterLabel();
    box.appendChild(k); box.appendChild(v);
    const e = document.createElement('div');
    e.className = 'pb-edit';
    e.textContent = 'Edit';
    bar.appendChild(box); bar.appendChild(e);
  }

  /* ---------- players screen ---------- */
  function renderRoster() {
    const list = $('roster');
    list.innerHTML = '';
    roster.forEach((name, i) => {
      const row = document.createElement('div');
      row.className = 'roster-row';

      const num = document.createElement('div');
      num.className = 'rr-num';
      num.textContent = String(i + 1);

      const input = document.createElement('input');
      input.type = 'text';
      input.value = name;
      input.placeholder = 'Player ' + (i + 1);
      input.maxLength = 14;
      input.autocomplete = 'off';
      input.addEventListener('input', () => { roster[i] = input.value; saveRoster(); });

      row.appendChild(num);
      row.appendChild(input);

      /* the last player standing can't be removed */
      if (roster.length > 1) {
        const del = document.createElement('button');
        del.className = 'rr-del';
        del.type = 'button';
        del.setAttribute('aria-label', 'Remove player ' + (i + 1));
        del.textContent = '✕';
        del.addEventListener('click', () => {
          roster.splice(i, 1);
          saveRoster();
          renderRoster();
        });
        row.appendChild(del);
      }

      list.appendChild(row);
    });
    $('add-player').style.display = roster.length >= MAX_PLAYERS ? 'none' : '';
  }

  function party() {
    teardown();
    renderRoster();
    show('party');
  }

  /* ---------- daily card ---------- */
  function renderDailyCard() {
    const card = $('daily-card');
    const n = dayNumber();
    const pick = dailyPick(n);
    const def = modes.find((m) => m.id === pick.id);
    const done = playedToday();

    card.innerHTML = '';
    card.classList.toggle('done', !!done);

    const k = document.createElement('div');
    k.className = 'dc-k';
    k.textContent = 'Daily challenge · #' + n + ' · beta';

    const v = document.createElement('div');
    v.className = 'dc-v';
    v.textContent = def ? def.name + (pick.opts.diff === 'hard' ? ' · Hard' : '') : 'Today';

    const s = document.createElement('div');
    s.className = 'dc-s';
    s.textContent = done
      ? 'Done — ' + done.hero + ' ' + (done.unitShort || '') + ' · tap to see your result'
      : 'One attempt.';

    const box = document.createElement('div');
    box.style.minWidth = '0';
    box.appendChild(k); box.appendChild(v); box.appendChild(s);

    const chev = document.createElement('div');
    chev.className = 'dc-chev';
    chev.textContent = done ? '↺' : '▶';

    card.appendChild(box);
    card.appendChild(chev);
  }

  /* ---------- share text ----------
     Wordle's lesson: the shareable artifact matters more than the score.
     Blocks give a shape people recognise without spoiling the answer. */
  const MARK_EMOJI = { good: '🟩', warn: '🟨', bad: '⬜' };

  function shareTextFor(entry) {
    const lines = [];
    lines.push('ERROR MARGIN #' + entry.day + ' — ' + entry.title);
    lines.push(entry.hero + ' ' + (entry.unitShort || ''));
    if (entry.marks && entry.marks.length) {
      lines.push(entry.marks.map((m) => MARK_EMOJI[m] || '⬜').join(''));
    }
    lines.push(SHARE_URL);
    return lines.join('\n');
  }
  const SHARE_URL = 'errormarg.in';

  function renderHome() {
    renderDailyCard();
    renderPartyBar();
    el.modeList.innerHTML = '';
    modes.forEach((def) => {
      const card = document.createElement('button');
      card.className = 'mode-card';
      card.type = 'button';
      paint(card, def);

      const glyph = document.createElement('div');
      glyph.className = 'glyph';
      glyph.textContent = def.glyph || '●';

      const body = document.createElement('div');
      body.className = 'mc-body';
      const name = document.createElement('div');
      name.className = 'mc-name';
      name.textContent = def.name;
      const tag = document.createElement('div');
      tag.className = 'mc-tag';
      /* modes with difficulties describe their own best line */
      /* party modes care about who's in the room, not about bests */
      const note = def.homeBest ? def.homeBest(bests, roster.length) : bestNote(def, def.id);
      tag.textContent = def.tag + (note ? '  ·  ' + note : '');
      body.appendChild(name);
      body.appendChild(tag);

      const chev = document.createElement('div');
      chev.className = 'chev';
      chev.textContent = '›';

      card.appendChild(glyph);
      card.appendChild(body);
      card.appendChild(chev);
      card.addEventListener('click', () => play(def.id));
      el.modeList.appendChild(card);
    });
  }

  /* ---------- play ---------- */
  function teardown() {
    cleanups.forEach((fn) => { try { fn(); } catch (e) {} });
    cleanups = [];
    current = null;
    /* wipe the stage so no mode leaks into the next */
    el.prompt.textContent = '';
    el.display.textContent = '';
    el.display.className = 'stage-display';
    el.sub.textContent = '';
    el.extra.innerHTML = '';
    el.foot.textContent = '';
    if (el.tapzone && el.tapzone.parentNode) el.tapzone.parentNode.removeChild(el.tapzone);
    el.tapzone = null;
  }

  /* A match is one pass of the roster through one mode. Solo is just
     a match of one, so there is a single code path either way. */
  let match = null;

  function play(id, opts) {
    const def = modes.find((m) => m.id === id);
    if (!def) return;
    const o = opts || {};
    match = {
      id: id,
      opts: o,
      /* the daily is a solo record, so it never runs the whole roster */
      /* a singleRun mode drives its own turn order, so core must not
         also loop the roster around it */
      names: (o.daily || def.singleRun)
        ? ['You']
        : roster.map((n, i) => (n || '').trim() || ('Player ' + (i + 1))),
      i: 0,
      results: [],
      seed: o.daily ? dailySeed() : (Math.random() * 4294967295) >>> 0,
      daily: !!o.daily
    };
    launch();
  }

  /* start (or re-show) today's challenge */
  function playDaily() {
    const done = playedToday();
    if (done) { showDailyResult(done); return; }
    const pick = dailyPick(dayNumber());
    const o = {};
    Object.keys(pick.opts).forEach((k) => { o[k] = pick.opts[k]; });
    o.daily = true;
    play(pick.id, o);
  }

  /* run the mode for whichever player is up, on the match's seed */
  function launch() {
    const def = modes.find((m) => m.id === match.id);
    teardown();
    show('play');
    audio(); /* unlock on the tap that started the mode */
    rng = mulberry32(match.seed);
    if (window.Track && match.i === 0) {
      Track.event('mode_start', {
        mode: match.id,
        diff: match.opts.diff || 'n/a',
        daily: !!match.daily,
        players: match.names.length
      });
    }
    paint(el.play, def);          /* the mode's colour follows it into play */
    current = { def: def, opts: match.opts };
    def.start(makeCtx(def), match.opts);
    /* first time you meet a mode, the rules come to you */
    if (!seen[def.id]) showHow(def, true);
  }

  function showHandoff() {
    teardown();
    show('handoff');
    const n = match.names.length;
    $('handoff-kicker').textContent = 'Pass the phone to';
    $('handoff-name').textContent = match.names[match.i];
    $('handoff-sub').textContent =
      'Player ' + (match.i + 1) + ' of ' + n + '  ·  same challenge, no peeking at the scores.';
    blip(880, 0.08);
  }

  /* ctx: everything a mode is allowed to touch */
  function makeCtx(def) {
    const ctx = {
      /* --- stage writers --- */
      prompt(t) { el.prompt.textContent = t == null ? '' : t; },
      display(t, cls) {
        const txt = t == null ? '' : String(t);
        el.display.textContent = txt;
        /* an empty display still reserves a full line of that huge type,
           which leaves a hole above panels — collapse it instead */
        el.display.className = 'stage-display' + (cls ? ' ' + cls : '') + (txt ? '' : ' is-empty');
      },
      displayClass(cls) { el.display.className = 'stage-display' + (cls ? ' ' + cls : ''); },
      sub(t) { el.sub.textContent = t == null ? '' : t; },
      foot(t) { el.foot.textContent = t == null ? '' : t; },
      extra: el.extra,

      /* --- feedback --- */
      blip: blip,
      beep: beep,      /* the loud "go now" signal */
      tone: tone,
      buzz: buzz,
      flash(color) {
        el.flash.style.background = color || 'var(--accent)';
        el.flash.classList.remove('go');
        void el.flash.offsetWidth; /* restart the animation */
        el.flash.classList.add('go');
      },

      /* --- input --- */
      /* full-screen tap surface; handler gets the precise event timestamp */
      tap(handler) {
        const zone = document.createElement('div');
        zone.className = 'tapzone';
        const fire = (e) => {
          e.preventDefault();
          handler(now(), e);
        };
        zone.addEventListener('pointerdown', fire);
        el.play.appendChild(zone);
        el.tapzone = zone;
        cleanups.push(() => { if (zone.parentNode) zone.parentNode.removeChild(zone); });
        return zone;
      },

      /* --- timing --- */
      now: now,
      after(ms, fn) {
        const t = setTimeout(fn, ms);
        cleanups.push(() => clearTimeout(t));
        return t;
      },
      every(ms, fn) {
        const t = setInterval(fn, ms);
        cleanups.push(() => clearInterval(t));
        return t;
      },
      /* rAF loop; fn(elapsedMs) — return false to stop */
      loop(fn) {
        const t0 = now();
        let raf = 0, live = true;
        const step = () => {
          if (!live) return;
          if (fn(now() - t0) === false) { live = false; return; }
          raf = requestAnimationFrame(step);
        };
        raf = requestAnimationFrame(step);
        const stop = () => { live = false; cancelAnimationFrame(raf); };
        cleanups.push(stop);
        return stop;
      },
      onCleanup(fn) { cleanups.push(fn); },

      /* --- difficulty / setup picker, shown before a run starts --- */
      /* opts: [{ label, note, value }] — cb gets the chosen value */
      choose(title, opts, cb) {
        el.prompt.textContent = title;
        el.display.textContent = '';
        el.display.className = 'stage-display';
        el.sub.textContent = '';
        el.foot.textContent = '';
        el.extra.innerHTML = '';
        el.extra.style.position = 'relative';
        el.extra.style.zIndex = '4';   /* sit above any tapzone */

        opts.forEach((o, i) => {
          const b = document.createElement('button');
          b.className = 'btn ' + (i === 0 ? 'btn-primary' : 'btn-ghost');
          b.style.cssText = 'width:100%;margin-bottom:10px;text-align:center;';
          b.innerHTML = '<div>' + o.label + '</div>' +
            (o.note ? '<div style="font-size:12px;font-weight:400;opacity:.7;margin-top:4px">' + o.note + '</div>' : '');
          b.addEventListener('click', (e) => {
            e.stopPropagation();
            el.extra.innerHTML = '';
            el.extra.style.position = '';
            el.extra.style.zIndex = '';
            cb(o.value);
          });
          el.extra.appendChild(b);
        });
        cleanups.push(() => { el.extra.style.position = ''; el.extra.style.zIndex = ''; });
      },

      /* --- roster, for modes that run the room themselves --- */
      get roster() {
        return roster.map((n, i) => (n || '').trim() || ('Player ' + (i + 1)));
      },
      openPlayers() { party(); },

      /* --- helpers --- */
      fmtMs: fmtMs, fmtSigned: fmtSigned, fmtClock: fmtClock,
      band: band, BAND_CLASS: BAND_CLASS, BAND_WORD: BAND_WORD,
      /* seeded — identical for every player in a match */
      rand(min, max) { return min + rng() * (max - min); },
      randInt(min, max) { return Math.floor(min + rng() * (max - min + 1)); },
      mean(a) { return a.reduce((x, y) => x + y, 0) / (a.length || 1); },

      /* --- finish --- */
      done(result) { finish(def, result); }
    };
    return ctx;
  }

  const now = () => performance.now();

  /* ---------- result ---------- */
  function finish(def, result) {
    const r = result || {};
    /* "Play again" should hand back the same difficulty, not the picker */
    const replay = r.replay || (current && current.opts) || {};
    lastMode = def.id;
    lastOpts = replay;

    if (window.Track) {
      Track.event('run_finish', {
        mode: def.id,
        diff: replay.diff || 'n/a',
        daily: !!(match && match.daily),
        score: r.score == null ? null : Math.round(r.score),
        outcome: r.hero == null ? '' : String(r.hero)
      });
    }

    if (match) {
      match.opts = replay;
      match.results.push({ name: match.names[match.i], r: r });
      match.i++;
      /* between players is NOT a break — the handoff rhythm is the
         good part, so no ad counter moves here */
      if (match.i < match.names.length) { showHandoff(); return; }
      if (window.Ads) Ads.matchEnded();
      if (match.names.length > 1) { showBoard(def); return; }
    } else if (window.Ads) {
      Ads.matchEnded();
    }

    /* the daily is recorded once and only once per calendar day */
    const isDaily = !!(match && match.daily);
    let dailyEntry = null;
    if (isDaily && !playedToday()) {
      dailyEntry = {
        day: dayNumber(),
        date: todayKey(),
        title: r.headline || def.name,
        hero: String(r.hero),
        unit: r.unit || '',
        unitShort: (r.unit || '').toLowerCase()
          .replace('average', 'avg').replace('per interval', 'per tap').trim(),
        marks: r.marks || [],
        score: r.score
      };
      daily[dailyEntry.date] = dailyEntry;
      saveDaily(daily);
    }

    /* solo: personal best + the mode's own breakdown */
    const { best, isNew } = recordBest(r.scoreKey || def.id, r.score, def.higherIsBetter);

    teardown();
    show('result');
    renderShare(isDaily ? (dailyEntry || playedToday()) : null);
    /* the daily is one attempt — no replay button on it */
    $('again-btn').style.display = isDaily ? 'none' : '';

    el.resultHeadline.textContent = r.headline || def.name;
    el.resultHero.textContent = r.hero == null ? '—' : r.hero;
    el.resultHero.className = 'result-hero' + (r.band ? ' ' + BAND_CLASS[r.band] : '');
    el.resultUnit.textContent = r.unit || '';

    el.resultLines.innerHTML = '';
    const lines = (r.lines || []).slice();
    if (best != null) {
      lines.push([isNew ? 'Best — new!' : 'Best', def.formatBest(best)]);
    }
    lines.forEach(([k, v]) => {
      const row = document.createElement('div');
      row.className = 'rline';
      const kk = document.createElement('span'); kk.className = 'rl-k'; kk.textContent = k;
      const vv = document.createElement('span'); vv.className = 'rl-v'; vv.textContent = v;
      row.appendChild(kk); row.appendChild(vv);
      el.resultLines.appendChild(row);
    });

    if (isNew && best != null) { blip(1320, 0.10); setTimeout(() => blip(1760, 0.14), 110); }
  }
  let lastMode = null;
  let lastOpts = {};

  /* ---------- share ---------- */
  let shareEntry = null;

  function renderShare(entry) {
    shareEntry = entry;
    const block = $('share-block');
    if (!entry) { block.style.display = 'none'; return; }
    block.style.display = '';
    $('share-text').textContent = shareTextFor(entry);
    $('share-btn').textContent = 'Share result';
  }

  function doShare() {
    if (!shareEntry) return;
    const text = shareTextFor(shareEntry);
    /* the share rate is the growth number — if this stays near zero,
       the share card is not pulling its weight */
    if (window.Track) Track.event('share_click', { day: shareEntry.day });
    /* native sheet where it exists, clipboard everywhere else */
    if (navigator.share) {
      navigator.share({ text: text }).catch(() => {});
      return;
    }
    const done = () => { $('share-btn').textContent = 'Copied!'; };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(fallbackCopy);
    } else {
      fallbackCopy();
    }
    function fallbackCopy() {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) {}
      document.body.removeChild(ta);
    }
  }

  /* re-open today's finished daily without replaying it */
  function showDailyResult(entry) {
    teardown();
    show('result');
    $('result-headline').textContent = 'Daily #' + entry.day + ' · ' + entry.title;
    $('result-hero').textContent = entry.hero;
    $('result-hero').className = 'result-hero';
    $('result-hero-unit').textContent = entry.unit;
    const list = $('result-lines');
    list.innerHTML = '';
    [['Played', entry.date], ['Next challenge', 'tomorrow']].forEach(([k, v]) => {
      const row = document.createElement('div');
      row.className = 'rline';
      const kk = document.createElement('span'); kk.className = 'rl-k'; kk.textContent = k;
      const vv = document.createElement('span'); vv.className = 'rl-v'; vv.textContent = v;
      row.appendChild(kk); row.appendChild(vv);
      list.appendChild(row);
    });
    renderShare(entry);
    /* no replaying the daily — practice lives in the normal modes */
    $('again-btn').style.display = 'none';
    lastMode = null;
  }

  /* ---------- leaderboard ---------- */
  function showBoard(def) {
    const higher = !!def.higherIsBetter;
    const rows = match.results.slice().sort((a, b) => {
      const x = a.r.score, y = b.r.score;
      if (x == null) return 1;
      if (y == null) return -1;
      return higher ? y - x : x - y;
    });
    /* Rank on the number people actually see. Two raw floats a hair apart
       both render as "468", and calling one of them second is a lie. */
    const shown = (row) => String(row.r.hero);
    const ranks = [];
    rows.forEach((row, i) => {
      ranks[i] = (i > 0 && shown(row) === shown(rows[i - 1])) ? ranks[i - 1] : i + 1;
    });
    const winner = rows[0];

    teardown();
    show('board');

    $('board-title').textContent = (match.results[0].r.headline || def.name);
    $('board-unit').textContent = match.results[0].r.unit || '';

    const list = $('board-list');
    list.innerHTML = '';
    rows.forEach((row, i) => {
      const el2 = document.createElement('div');
      el2.className = 'board-row' + (ranks[i] === 1 ? ' win' : '');

      const rk = document.createElement('div');
      rk.className = 'br-rank';
      rk.textContent = String(ranks[i]);

      const nm = document.createElement('div');
      nm.className = 'br-name';
      nm.textContent = row.name;

      const sc = document.createElement('div');
      sc.style.textAlign = 'right';
      const v = document.createElement('div');
      v.className = 'br-score';
      v.textContent = row.r.hero == null ? '—' : String(row.r.hero);
      sc.appendChild(v);
      if (i > 0 && winner.r.score != null && row.r.score != null) {
        const gap = document.createElement('div');
        gap.className = 'br-gap';
        const d = Math.abs(row.r.score - winner.r.score);
        /* sub-unit gaps are noise once the hero number is rounded */
        gap.textContent = ranks[i] === 1 ? 'tied' : '+' + (d < 10 ? d.toFixed(1) : Math.round(d));
        sc.appendChild(gap);
      }

      el2.appendChild(rk); el2.appendChild(nm); el2.appendChild(sc);
      list.appendChild(el2);
    });

    blip(1320, 0.10); setTimeout(() => blip(1760, 0.14), 120);
  }

  function home() {
    teardown();
    match = null;          /* abandoning a match drops the half-finished scores */
    renderHome();
    show('home');
  }

  /* ---------- boot ---------- */
  function boot() {
    screens.home = $('screen-home');
    screens.play = $('screen-play');
    screens.result = $('screen-result');
    screens.party = $('screen-party');
    screens.handoff = $('screen-handoff');
    screens.board = $('screen-board');

    el.play = screens.play;
    el.modeList = $('mode-list');
    el.prompt = $('stage-prompt');
    el.display = $('stage-display');
    el.sub = $('stage-sub');
    el.extra = $('stage-extra');
    el.foot = $('stage-foot');
    el.resultHeadline = $('result-headline');
    el.resultHero = $('result-hero');
    el.resultUnit = $('result-hero-unit');
    el.resultLines = $('result-lines');

    /* flash overlay lives on the play screen, under the quit button */
    el.flash = document.createElement('div');
    el.flash.className = 'flash';
    el.play.appendChild(el.flash);

    if (window.Ads) Ads.init({ debugSlots: false });
    /* fill in cfBeaconToken (Cloudflare Web Analytics) and/or endpoint
       once you've created them — inert until then */
    if (window.Track) Track.init({ cfBeaconToken: '', endpoint: '', debug: false });

    /* post-match buttons are the only ad boundary: a finished match,
       a player deciding what's next, nothing being timed */
    const afterMatch = (fn) => () => {
      if (window.Ads) Ads.maybeInterstitial(fn); else fn();
    };
    const replayLast = () => { if (lastMode) play(lastMode, lastOpts); else home(); };

    /* back always asks first — a stray tap must not bin a match */
    $('quit-btn').addEventListener('click', confirmQuit);   /* quitting mid-run: never an ad */
    $('help-btn').addEventListener('click', () => {
      if (current && current.def) showHow(current.def, false);
    });
    /* tapping the dimmed area behind the card dismisses it */
    $('sheet').addEventListener('click', (e) => {
      if (e.target === $('sheet')) closeSheet();
    });
    $('home-btn').addEventListener('click', afterMatch(home));
    $('again-btn').addEventListener('click', afterMatch(replayLast));

    $('daily-card').addEventListener('click', playDaily);
    $('share-btn').addEventListener('click', doShare);
    $('party-bar').addEventListener('click', party);
    $('add-player').addEventListener('click', () => {
      if (roster.length >= MAX_PLAYERS) return;
      roster.push('');
      saveRoster();
      renderRoster();
      /* drop the cursor straight into the new name */
      const inputs = $('roster').querySelectorAll('input');
      const last = inputs[inputs.length - 1];
      if (last) last.focus();
    });
    $('party-done').addEventListener('click', home);
    $('handoff-go').addEventListener('click', () => { if (match) launch(); else home(); });
    $('board-home').addEventListener('click', afterMatch(home));
    $('board-again').addEventListener('click', afterMatch(replayLast));

    /* leaving the tab mid-round would poison the timings — bail out */
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && current) home();
    });

    home();
  }

  /* ---------- public ---------- */
  function mode(def) {
    if (!def.formatBest) def.formatBest = (v) => fmtMs(v);
    modes.push(def);
  }

  return { boot: boot, mode: mode, play: play, home: home,
           blip: blip, beep: beep, tone: tone, buzz: buzz };
})();
