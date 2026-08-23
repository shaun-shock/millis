/* ============================================================
   ERROR MARGIN — ad layer

   One rule above all others: ad code must never execute while a
   run is in progress. Ad scripts are heavy and share the main
   thread with the rAF loop and the pointerdown handlers, so a
   200ms block mid-run delays a tap timestamp and quietly poisons
   the score. Everything here is gated on `playing`.

   No network SDK is wired up yet — pick a provider and fill in
   one adapter below. Until then this renders inert placeholders
   when DEBUG_SLOTS is on, and does nothing at all when it's off.
   ============================================================ */
window.Ads = (function () {

  const cfg = {
    enabled: false,       /* master switch — flip on once a provider is wired */
    provider: 'none',     /* 'none' | 'adsense' | 'poki' | 'crazygames' */
    debugSlots: false,    /* draw visible placeholders to check layout */

    /* interstitials are the intrusive format, so cap them hard */
    interstitialEveryNMatches: 3,
    interstitialMinGapMs: 120000
  };

  let playing = false;          /* true from run start until the board */
  let matchesSinceAd = 0;
  let lastInterstitialAt = 0;
  let slot = null;

  /* ---------- provider adapters ----------
     Each adapter needs three things: load(), showBanner(el),
     showInterstitial(done). Only one is ever active. */
  const providers = {
    none: {
      load() {},
      showBanner() {},
      showInterstitial(done) { done(); }
    }
    /* adsense / poki / crazygames go here — see notes at the bottom */
  };

  function provider() { return providers[cfg.provider] || providers.none; }

  /* ---------- public ---------- */

  /* core calls this so the ad layer always knows whether a run is live */
  function setPlaying(v) {
    playing = !!v;
    if (playing) hideBanner();   /* nothing on screen, nothing on the thread */
  }

  function init(options) {
    Object.assign(cfg, options || {});
    slot = document.getElementById('ad-slot');
    if (!cfg.enabled) return;
    /* defer the SDK until the browser is idle so it never competes
       with the first run for main-thread time */
    const start = () => provider().load();
    if (window.requestIdleCallback) requestIdleCallback(start, { timeout: 4000 });
    else setTimeout(start, 2000);
  }

  /* banner: only ever on the calm screens */
  function showBanner(where) {
    if (!slot) return;
    if (playing) return;
    const allowed = where === 'home' || where === 'result' || where === 'board';
    if (!allowed) { hideBanner(); return; }

    if (cfg.debugSlots) {
      slot.className = 'ad-slot ad-debug';
      slot.textContent = 'ad slot · ' + where;
      slot.style.display = '';
      return;
    }
    if (!cfg.enabled) { hideBanner(); return; }
    slot.className = 'ad-slot';
    slot.style.display = '';
    provider().showBanner(slot);
  }

  function hideBanner() {
    if (!slot) return;
    slot.style.display = 'none';
    slot.textContent = '';
  }

  /* interstitial: called at a match boundary only, never between
     players and never mid-run. Always invokes done() exactly once,
     so the caller's flow cannot stall on a failed ad. */
  function matchEnded() { matchesSinceAd++; }

  function maybeInterstitial(done) {
    const go = () => { try { done(); } catch (e) {} };
    if (playing || !cfg.enabled) return go();
    if (matchesSinceAd < cfg.interstitialEveryNMatches) return go();
    const t = Date.now();
    if (t - lastInterstitialAt < cfg.interstitialMinGapMs) return go();

    matchesSinceAd = 0;
    lastInterstitialAt = t;

    let fired = false;
    const once = () => { if (!fired) { fired = true; go(); } };
    setTimeout(once, 6000);        /* never let a broken SDK trap the player */
    provider().showInterstitial(once);
  }

  return {
    init: init,
    setPlaying: setPlaying,
    showBanner: showBanner,
    hideBanner: hideBanner,
    matchEnded: matchEnded,
    maybeInterstitial: maybeInterstitial,
    config: cfg
  };
})();

/* ------------------------------------------------------------
   Wiring a provider later:

   AdSense (self-hosted, you own the traffic)
     load(): inject the adsbygoogle script, then per slot push({}).
     Needs site approval, real traffic, a privacy policy, and a
     consent banner (CMP) for EEA/UK visitors. Banner only —
     AdSense has no rewarded/interstitial format for a game like this.

   Poki / CrazyGames (portal SDKs, they own the traffic)
     load(): their SDK script; showInterstitial(): their commercial
     break call, which returns a promise you resolve into done().
     These pay far better per player than AdSense because the portal
     sends you the audience — but you publish on their site and play
     by their rules. Their SDKs also expect gameplayStart/gameplayStop
     signals, which map exactly onto setPlaying() above.

   Whichever you pick: declare child-directed status honestly if the
   audience skews young, and keep the interstitial on the match
   boundary only.
   ------------------------------------------------------------ */
