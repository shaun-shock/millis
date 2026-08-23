/* ============================================================
   MILLIS — analytics

   Same shape as ads.js: the game emits events through one shim,
   and the provider is swapped underneath without touching game
   code. Nothing is sent until a provider is configured.

   Two independent layers:

   1. Page-level traffic (visitors, referrers) — Cloudflare Web
      Analytics, enabled by dropping in a beacon token below.
      Free, cookieless, needs no consent banner.

   2. Game events (which modes get played, whether people come
      back for the daily, where they quit) — the numbers that
      actually answer "is this retaining?". Cloudflare Web
      Analytics does not do custom events, so this needs either
      an endpoint of your own or a tool like Plausible/Umami.

   Like the ad layer, this must never do work mid-run. Events are
   queued and flushed when the player is idle.
   ============================================================ */
window.Track = (function () {

  const cfg = {
    debug: false,          /* log events to the console instead of sending */
    cfBeaconToken: '',     /* Cloudflare Web Analytics site token */
    endpoint: '',          /* optional: your own collector for game events */
    appVersion: 'v1'
  };

  let queue = [];
  let playing = false;
  let sessionStart = Date.now();

  /* ---------- session identity ----------
     A random per-browser id, stored locally. No personal data, no
     cookie, never leaves as anything but an opaque string — enough
     to tell "10 people played once" from "1 person played 10 times",
     which is the whole question retention turns on. */
  const AID = 'millis.aid.v1';
  function anonId() {
    try {
      let v = localStorage.getItem(AID);
      if (!v) {
        v = (Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 16);
        localStorage.setItem(AID, v);
      }
      return v;
    } catch (e) { return 'nostore'; }
  }

  /* days since this browser first opened the game — the retention axis */
  const FIRST = 'millis.first.v1';
  function daysKnown() {
    try {
      let f = localStorage.getItem(FIRST);
      if (!f) { f = String(Date.now()); localStorage.setItem(FIRST, f); }
      return Math.floor((Date.now() - Number(f)) / 86400000);
    } catch (e) { return 0; }
  }

  function init(options) {
    Object.assign(cfg, options || {});

    /* Cloudflare Web Analytics: page traffic, entirely separate from
       the event queue below. Loaded late so it never competes with
       the first run for main-thread time. */
    if (cfg.cfBeaconToken) {
      const load = () => {
        const s = document.createElement('script');
        s.defer = true;
        s.src = 'https://static.cloudflareinsights.com/beacon.min.js';
        s.setAttribute('data-cf-beacon', JSON.stringify({ token: cfg.cfBeaconToken }));
        document.head.appendChild(s);
      };
      if (window.requestIdleCallback) requestIdleCallback(load, { timeout: 5000 });
      else setTimeout(load, 2500);
    }

    event('app_open', { days_known: daysKnown() });

    /* a run that dies on an exception is invisible otherwise */
    window.addEventListener('error', (e) => {
      event('js_error', { msg: String(e.message).slice(0, 140) });
    });
    window.addEventListener('unhandledrejection', () => {
      event('js_error', { msg: 'unhandled_rejection' });
    });

    /* last chance to flush before the tab goes away */
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) flush();
    });
  }

  /* core calls this so analytics never transmits mid-measurement */
  function setPlaying(v) {
    playing = !!v;
    if (!playing) flush();
  }

  function event(name, props) {
    const e = {
      t: Date.now(),
      name: name,
      aid: anonId(),
      v: cfg.appVersion,
      session_s: Math.round((Date.now() - sessionStart) / 1000)
    };
    if (props) Object.keys(props).forEach((k) => { e[k] = props[k]; });

    if (cfg.debug) { console.log('[track]', name, e); }
    queue.push(e);
    if (queue.length > 60) queue = queue.slice(-60);   /* never grow unbounded */
    if (!playing) flush();
  }

  function flush() {
    if (!queue.length || !cfg.endpoint) return;
    const batch = queue;
    queue = [];
    try {
      const body = JSON.stringify({ events: batch });
      /* sendBeacon survives the page being closed, and never blocks */
      if (navigator.sendBeacon) {
        navigator.sendBeacon(cfg.endpoint, new Blob([body], { type: 'application/json' }));
      } else {
        fetch(cfg.endpoint, { method: 'POST', body: body, keepalive: true }).catch(() => {});
      }
    } catch (e) { /* analytics must never break the game */ }
  }

  return {
    init: init,
    event: event,
    setPlaying: setPlaying,
    flush: flush,
    config: cfg
  };
})();
