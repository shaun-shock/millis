/* ============================================================
   BLIND STOP
   A stopwatch runs up. Stop it on the target.
   Normal: the digits are readable for the first moment.
   Hard:   the clock never shows a single digit, and the
           targets aren't round numbers.
   ============================================================ */
TT.mode({
  id: 'blindstop',
  name: 'Blind Stop',
  tag: 'The clock goes dark. Stop it on the number anyway.',
  glyph: '⏱',
  color: '#35E0FF',              /* cyan */
  formatBest: (v) => Math.round(v) + 'ms avg',

  how: [
    'You are given a target, like 5.0 seconds.',
    'Tap anywhere to start the clock. The digits fade almost immediately — on hard there are none at all.',
    'Tap again the moment you believe you have hit the target. Five rounds, scored on your average error.'
  ],

  homeBest(bests) {
    const n = bests['blindstop'], h = bests['blindstop:hard'];
    if (n == null && h == null) return '';
    const parts = [];
    if (n != null) parts.push(Math.round(n) + 'ms');
    if (h != null) parts.push(Math.round(h) + 'ms hard');
    return 'best ' + parts.join(' / ');
  },

  start(ctx, opts) {
    if (!opts.diff) {
      ctx.choose('Blind Stop', [
        { label: 'Normal', note: 'digits visible for the first 0.9s', value: 'normal' },
        { label: 'Hard', note: 'no digits at all · odd targets', value: 'hard' }
      ], (v) => TT.play('blindstop', { diff: v }));
      return;
    }

    const diff = opts.diff;
    const HARD = diff === 'hard';

    /* hard targets are deliberately un-round: you can't lean on a familiar count */
    const TARGETS = HARD
      ? [4300, 6700, 3400, 8200, 5900]
      : [3000, 5000, 4000, 7000, 5500];
    const VISIBLE_FOR = HARD ? 0 : 900;
    const GOOD = HARD ? 80 : 60;
    const WARN = HARD ? 220 : 180;
    const ROUNDS = TARGETS.length;

    let round = 0;
    const errors = [];

    const pips = document.createElement('div');
    pips.className = 'pips';
    ctx.extra.appendChild(pips);
    function drawPips() {
      pips.innerHTML = '';
      for (let i = 0; i < ROUNDS; i++) {
        const p = document.createElement('div');
        p.className = 'pip';
        if (i < errors.length) {
          p.classList.add(ctx.band(errors[i], GOOD, WARN) === 'bad' ? 'bad' : 'on');
        }
        pips.appendChild(p);
      }
    }
    drawPips();

    let phase = 'idle';   /* idle → running → judged */
    let stopLoop = null;
    let target = 0;
    let startedAt = 0;

    const targetLabel = (ms) => (ms / 1000).toFixed(1) + 's';

    function armRound() {
      phase = 'idle';
      target = TARGETS[round];
      ctx.prompt('Round ' + (round + 1) + ' of ' + ROUNDS);
      ctx.display(HARD ? '◯' : ctx.fmtClock(0));
      ctx.displayClass('');
      ctx.sub('Stop at ' + targetLabel(target));
      ctx.foot('Tap anywhere to start');
    }

    function runRound() {
      phase = 'running';
      ctx.prompt('Running');
      ctx.sub('Stop at ' + targetLabel(target));
      ctx.foot('Tap to stop');
      ctx.beep();               /* clock is live — make it unmistakable */

      if (HARD) {
        /* nothing to read — a dimmed dot is the only sign it's live */
        ctx.display('●', 'is-hidden-digits');
        return;
      }
      stopLoop = ctx.loop((t) => {
        if (phase !== 'running') return false;
        ctx.display(ctx.fmtClock(t), t > VISIBLE_FOR ? 'is-hidden-digits' : '');
      });
    }

    function judge(tapAt) {
      phase = 'judged';
      if (stopLoop) stopLoop();
      const elapsed = tapAt - startedAt;
      const err = elapsed - target;          /* + = late, − = early */
      errors.push(err);
      const b = ctx.band(err, GOOD, WARN);

      ctx.display(ctx.fmtClock(elapsed), ctx.BAND_CLASS[b]);
      ctx.prompt(ctx.BAND_WORD[b]);
      ctx.sub(ctx.fmtSigned(err) + (err > 0 ? ' late' : err < 0 ? ' early' : ''));
      ctx.flash(b === 'good' ? 'var(--accent)' : b === 'warn' ? 'var(--warn)' : 'var(--bad)');
      ctx.buzz(b === 'good' ? 10 : 24);
      ctx.blip(b === 'good' ? 1200 : b === 'warn' ? 760 : 320, 0.09);
      drawPips();

      round++;
      if (round < ROUNDS) {
        ctx.foot('Tap to continue');
      } else {
        ctx.foot('');
        ctx.after(900, report);
      }
    }

    function report() {
      const abs = errors.map(Math.abs);
      const avg = ctx.mean(abs);
      const bias = ctx.mean(errors);
      ctx.done({
        headline: 'Blind Stop · ' + (HARD ? 'Hard' : 'Normal'),
        hero: Math.round(avg),
        unit: 'MS AVERAGE ERROR',
        band: ctx.band(avg, GOOD, WARN),
        score: avg,
        scoreKey: HARD ? 'blindstop:hard' : 'blindstop',
        replay: { diff: diff },
        marks: errors.map((e) => ctx.band(e, GOOD, WARN)),
        lines: [
          ['Best round', ctx.fmtMs(Math.min.apply(null, abs))],
          ['Worst round', ctx.fmtMs(Math.max.apply(null, abs))],
          ['Bias', bias > 0 ? ctx.fmtSigned(bias) + ' late' : ctx.fmtSigned(bias) + ' early'],
          ['Rounds', String(ROUNDS)]
        ]
      });
    }

    ctx.tap((t) => {
      if (phase === 'idle') { startedAt = t; runRound(); }
      else if (phase === 'running') { judge(t); }
      else if (phase === 'judged' && round < ROUNDS) { armRound(); }
    });

    armRound();
  }
});
