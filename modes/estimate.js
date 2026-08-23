/* ============================================================
   HOW LONG
   A light and tone hold for some duration. You say how long
   it lasted. No counting out loud — the slider only.
   ============================================================ */
TT.mode({
  id: 'estimate',
  name: 'How Long',
  tag: 'Something lasts. You say how many milliseconds it was.',
  glyph: '◐',
  color: '#FF7AC8',              /* pink */
  formatBest: (v) => v.toFixed(1) + '% off',

  how: [
    'A tone plays and holds for some length of time. Watch and listen.',
    'When it stops, set the slider to how long you think it lasted. On hard the slider shows you no number.',
    'Scored as a percentage, because judging five seconds is far harder than judging half a second.'
  ],

  homeBest(bests) {
    const n = bests['estimate'], h = bests['estimate:hard'];
    if (n == null && h == null) return '';
    const parts = [];
    if (n != null) parts.push(n.toFixed(1) + '%');
    if (h != null) parts.push(h.toFixed(1) + '% hard');
    return 'best ' + parts.join(' / ');
  },

  start(ctx, opts) {
    if (!opts.diff) {
      ctx.choose('How Long', [
        { label: 'Normal', note: 'the slider tells you what you picked', value: 'normal' },
        { label: 'Hard', note: 'no readout — place it by feel', value: 'hard' }
      ], (v) => TT.play('estimate', { diff: v }));
      return;
    }

    const diff = opts.diff;
    const HARD = diff === 'hard';
    const ROUNDS = 5;
    const MIN = 400, MAX = 6000;       /* slider bounds, ms */
    /* hard grades tighter: 4% on a 3s stimulus is 120ms */
    const GOOD_PCT = HARD ? 4 : 6;
    const WARN_PCT = HARD ? 10 : 15;
    const rate = (p) => (p <= GOOD_PCT ? 'good' : p <= WARN_PCT ? 'warn' : 'bad');

    let round = 0;
    const pctErrors = [];
    const msErrors = [];
    let actual = 0;

    /* --- slider UI, built once and reused --- */
    const panel = document.createElement('div');
    panel.className = 'slab';
    panel.style.display = 'none';

    const readout = document.createElement('div');
    readout.style.cssText = 'font-family:var(--mono);font-size:26px;text-align:center;margin-bottom:6px;';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(MIN);
    slider.max = String(MAX);
    slider.step = '10';
    slider.value = '2000';

    const scale = document.createElement('div');
    scale.style.cssText = 'display:flex;justify-content:space-between;font-size:11px;color:var(--dim);font-family:var(--mono);';
    scale.innerHTML = '<span>0.4s</span><span>6.0s</span>';

    const lock = document.createElement('button');
    lock.className = 'btn btn-primary';
    lock.style.cssText = 'width:100%;margin-top:14px;';
    lock.textContent = 'Lock it in';

    panel.appendChild(readout);
    panel.appendChild(slider);
    panel.appendChild(scale);
    panel.appendChild(lock);
    ctx.extra.appendChild(panel);

    /* hard mode hides the number — you're placing the thumb by feel,
       not dialling in a figure you can read back */
    function syncReadout() {
      readout.textContent = HARD ? '· · ·' : (Number(slider.value) / 1000).toFixed(2) + 's';
    }
    slider.addEventListener('input', syncReadout);
    syncReadout();

    let phase = 'idle';   /* idle → playing → answering → judged */
    let tapzone = null;

    function armRound() {
      phase = 'idle';
      panel.style.display = 'none';
      ctx.prompt('Round ' + (round + 1) + ' of ' + ROUNDS);
      ctx.display('◯');
      ctx.displayClass('');
      ctx.sub('Watch and listen');
      ctx.foot('Tap anywhere to begin');
      if (tapzone) tapzone.style.display = '';
    }

    function playStimulus() {
      phase = 'playing';
      if (tapzone) tapzone.style.display = 'none';   /* no cheating by tapping through it */
      actual = Math.round(ctx.rand(MIN + 200, MAX - 600));

      ctx.prompt('Now');
      ctx.display('●');
      ctx.displayClass('is-good');
      ctx.sub('');
      ctx.foot('');

      /* a held tone for exactly `actual` ms, started and stopped on the same clock */
      const holdOn = ctx.now();
      /* single sharp tone, not the two-tone beep — the player is judging
         the gap between start and end, so both edges must be crisp */
      ctx.tone(880, 0.10, 0.8, 'square');
      /* the pulse under it stays quieter so it can't be mistaken for the ends */
      const pulse = ctx.every(220, () => ctx.blip(523, 0.05, 0.28));

      ctx.after(actual, () => {
        clearInterval(pulse);
        ctx.tone(392, 0.22, 0.75, 'square');   /* low tone = it's over */
        actual = Math.round(ctx.now() - holdOn);  /* score the real elapsed time, not the request */
        askAnswer();
      });
    }

    function askAnswer() {
      phase = 'answering';
      ctx.prompt('How long was that?');
      ctx.display('◯');
      ctx.displayClass('');
      ctx.sub('');
      ctx.foot('');
      panel.style.display = '';
      slider.value = String(Math.min(MAX, Math.max(MIN, 2000)));
      syncReadout();
    }

    function judge() {
      if (phase !== 'answering') return;
      phase = 'judged';
      panel.style.display = 'none';

      const guess = Number(slider.value);
      const err = guess - actual;
      const pct = Math.abs(err) / actual * 100;
      msErrors.push(err);
      pctErrors.push(pct);

      /* percentage bands: judging 5s to ±100ms is much harder than 500ms to ±100ms */
      const b = rate(pct);
      ctx.display((actual / 1000).toFixed(2) + 's', ctx.BAND_CLASS[b]);
      ctx.prompt(ctx.BAND_WORD[b]);
      ctx.sub('You said ' + (guess / 1000).toFixed(2) + 's  ·  ' + ctx.fmtSigned(err));
      ctx.flash(b === 'good' ? 'var(--accent)' : b === 'warn' ? 'var(--warn)' : 'var(--bad)');
      ctx.buzz(b === 'good' ? 10 : 24);

      round++;
      if (tapzone) tapzone.style.display = '';
      if (round < ROUNDS) {
        ctx.foot('Tap to continue');
      } else {
        ctx.foot('');
        ctx.after(1000, report);
      }
    }

    lock.addEventListener('click', (e) => { e.stopPropagation(); judge(); });

    function report() {
      const avgPct = ctx.mean(pctErrors);
      const bias = ctx.mean(msErrors);
      ctx.done({
        headline: 'How Long · ' + (HARD ? 'Hard' : 'Normal'),
        hero: avgPct.toFixed(1),
        unit: '% AVERAGE ERROR',
        band: rate(avgPct),
        score: avgPct,
        scoreKey: HARD ? 'estimate:hard' : 'estimate',
        replay: { diff: diff },
        marks: pctErrors.map(rate),
        lines: [
          ['Best round', Math.min.apply(null, pctErrors).toFixed(1) + '%'],
          ['Worst round', Math.max.apply(null, pctErrors).toFixed(1) + '%'],
          ['Bias', bias > 0 ? 'overestimates by ' + Math.round(bias) + 'ms'
                            : 'underestimates by ' + Math.round(-bias) + 'ms'],
          ['Rounds', String(ROUNDS)]
        ]
      });
    }

    tapzone = ctx.tap(() => {
      if (phase === 'idle') playStimulus();
      else if (phase === 'judged' && round < ROUNDS) armRound();
    });
    /* the slider panel has to sit above the tap surface */
    panel.style.position = 'relative';
    panel.style.zIndex = '4';
    ctx.extra.style.position = 'relative';
    ctx.extra.style.zIndex = '4';
    ctx.onCleanup(() => { ctx.extra.style.position = ''; ctx.extra.style.zIndex = ''; });

    armRound();
  }
});
