/* ============================================================
   SPLIT
   A target duration, repeated. 30 seconds in 10 means ten
   intervals of 3s each.

   Every interval is bounded by two taps: tap to start, wait it
   out, tap to stop. That closes interval one — then you start
   the next when you're ready. The pause between them isn't
   measured, so each interval is its own attempt.

   No clock, no counter, and no idea how you did until the set
   ends. The pips only ever say where you are, never how you're
   doing: filled means closed, hollow-and-breathing means you're
   timing it right now.
   ============================================================ */
TT.mode({
  id: 'interval',
  name: 'Split',
  tag: 'Ten intervals of three seconds. Tap to start, tap to stop, no clock.',
  glyph: '⑽',
  color: '#6C9BFF',              /* blue */
  formatBest: (v) => Math.round(v) + 'ms/tap',

  how: [
    'One duration, repeated — three seconds, ten times over.',
    'Tap to start an interval, wait it out, tap to stop. That closes it, then you start the next when ready.',
    'There is no clock and no feedback. You find out how close every interval was only at the end of the set.'
  ],

  homeBest(bests) {
    const n = bests['interval'], h = bests['interval:hard'];
    if (n == null && h == null) return '';
    const parts = [];
    if (n != null) parts.push(Math.round(n) + 'ms');
    if (h != null) parts.push(Math.round(h) + 'ms hard');
    return 'best ' + parts.join(' / ');
  },

  start(ctx, opts) {
    /* each level: `total` split into `parts` intervals */
    const LEVELS = {
      normal: [
        { total: 30000, parts: 10 },   /* 3s each */
        { total: 20000, parts: 5 },    /* 4s each */
        { total: 30000, parts: 6 }     /* 5s each */
      ],
      hard: [
        { total: 45000, parts: 9 },    /* 5s — long enough to drift badly */
        { total: 28000, parts: 8 },    /* 3.5s — not a round number */
        { total: 60000, parts: 15 }    /* 4s, fifteen times over */
      ]
    };

    if (!opts.diff) {
      ctx.choose('Split', [
        { label: 'Normal', note: '3s ×10 · 4s ×5 · 5s ×6', value: 'normal' },
        { label: 'Hard', note: 'longer intervals, odd durations, more of them', value: 'hard' }
      ], (v) => TT.play('interval', { diff: v }));
      return;
    }

    const diff = opts.diff;
    const sets = LEVELS[diff];
    const HARD = diff === 'hard';
    const GOOD = HARD ? 120 : 200;
    const WARN = HARD ? 300 : 450;

    let set = 0;
    let phase = 'idle';              /* idle → ready → timing → judged */
    let startedAt = 0;               /* when the current interval began */
    let durations = [];              /* measured length of each closed interval */
    const allErrors = [];
    const setSummaries = [];

    const pips = document.createElement('div');
    pips.className = 'pips';
    ctx.extra.appendChild(pips);

    /* 3000 → "3", 3500 → "3.5" */
    const secs = (ms) => String(+(ms / 1000).toFixed(2));
    const target = () => sets[set].total / sets[set].parts;

    function drawPips(colors) {
      const n = sets[set].parts;
      pips.innerHTML = '';
      for (let i = 0; i < n; i++) {
        const p = document.createElement('div');
        p.className = 'pip';
        if (colors) {
          if (colors[i]) p.classList.add(colors[i]);
        } else if (i < durations.length) {
          p.classList.add('on');                       /* closed */
        } else if (i === durations.length && phase === 'timing') {
          p.classList.add('now');                      /* timing this one */
        }
        pips.appendChild(p);
      }
    }

    function armSet() {
      phase = 'idle';
      durations = [];
      const s = sets[set];
      drawPips();
      ctx.prompt('Set ' + (set + 1) + ' of ' + sets.length);
      ctx.display(secs(target()) + 's');
      ctx.sub('× ' + s.parts + '  ·  ' + secs(s.total) + 's in total');
      ctx.foot('Tap anywhere to begin');
    }

    /* waiting for the player to start the next interval */
    function ready(first) {
      phase = 'ready';
      drawPips();
      ctx.prompt(first ? 'Ready' : 'Interval ' + durations.length + ' done');
      ctx.display('—');
      ctx.displayClass('');
      ctx.sub('');
      ctx.foot(first ? 'Tap to start' : 'Tap to start the next one');
    }

    function startInterval(t) {
      phase = 'timing';
      startedAt = t;
      drawPips();
      ctx.prompt('Timing');
      ctx.display('—');
      ctx.displayClass('');
      ctx.sub('');
      ctx.foot('Tap to stop');
      if (durations.length === 0) ctx.beep();          /* first one gets the loud go */
      else ctx.blip(660, 0.07);
      ctx.buzz(10);
    }

    function stopInterval(t) {
      durations.push(t - startedAt);
      /* the tap is confirmed, but nothing about how close it was */
      ctx.blip(880, 0.07);
      ctx.buzz(8);
      if (durations.length >= sets[set].parts) endSet();
      else ready(false);
    }

    function endSet() {
      phase = 'judged';
      const s = sets[set];
      const each = target();

      const errs = durations.map((d) => d - each);
      errs.forEach((e) => allErrors.push(e));

      const avg = ctx.mean(errs.map(Math.abs));
      const summed = durations.reduce((a, b) => a + b, 0);
      const b = ctx.band(avg, GOOD, WARN);

      /* everything is revealed at once, interval by interval */
      drawPips(errs.map((e) => ctx.band(e, GOOD, WARN) === 'bad' ? 'bad' : 'on'));

      ctx.prompt(ctx.BAND_WORD[b]);
      ctx.display(Math.round(avg) + 'ms', ctx.BAND_CLASS[b]);
      ctx.sub('per interval  ·  your ' + s.parts + ' added up to ' +
              (summed / 1000).toFixed(2) + 's of ' + secs(s.total) + 's');
      ctx.flash(b === 'good' ? 'var(--accent)' : b === 'warn' ? 'var(--warn)' : 'var(--bad)');

      setSummaries.push({ label: secs(each) + 's × ' + s.parts, avg: avg });

      set++;
      if (set < sets.length) {
        ctx.foot('Tap to continue');
      } else {
        ctx.foot('');
        ctx.after(1200, report);
      }
    }

    function report() {
      const abs = allErrors.map(Math.abs);
      const avg = ctx.mean(abs);
      const bias = ctx.mean(allErrors);
      /* drift is the real killer: are the late intervals worse than
         the early ones, or are you just noisy throughout? */
      const half = Math.floor(allErrors.length / 2);
      const drift = ctx.mean(allErrors.slice(half)) - ctx.mean(allErrors.slice(0, half));

      const lines = setSummaries.map((s) => [s.label, Math.round(s.avg) + 'ms/tap']);
      lines.push(['Bias', bias > 0 ? ctx.fmtSigned(bias) + ' long' : ctx.fmtSigned(bias) + ' short']);
      lines.push(['Drift', (drift > 0 ? 'slowing ' : 'speeding ') + Math.abs(Math.round(drift)) + 'ms']);
      lines.push(['Intervals', String(allErrors.length)]);

      ctx.done({
        headline: 'Split · ' + (HARD ? 'Hard' : 'Normal'),
        hero: Math.round(avg),
        unit: 'MS PER INTERVAL',
        band: ctx.band(avg, GOOD, WARN),
        score: avg,
        scoreKey: HARD ? 'interval:hard' : 'interval',
        replay: { diff: diff },
        /* one mark per set — thirty blocks would be unreadable */
        marks: setSummaries.map((s) => ctx.band(s.avg, GOOD, WARN)),
        lines: lines
      });
    }

    ctx.tap((t) => {
      if (phase === 'idle' || phase === 'ready') startInterval(t);
      else if (phase === 'timing') stopInterval(t);
      else if (phase === 'judged' && set < sets.length) armSet();
    });

    armSet();
  }
});
