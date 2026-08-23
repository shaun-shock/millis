/* ============================================================
   IMPOSTER

   Phase 1 — briefing. The phone goes round the room once and
   everyone reads their own time in private. Holding the button
   reveals it; letting go hides it again and nothing else happens,
   so a fumbled grip can never cost you your briefing. You move on
   only by deliberately pressing "pass".

   Phase 2 — rounds. Everyone attempts the time blind, one after
   another, with the room watching. Each turn ends on that player's
   duration — but never their error, which would hand the imposter
   the target by arithmetic. The briefing is the only private part
   of this game; the performances are public.

   Then every time is revealed at once, and each further round is
   appended alongside the last so the room can compare across
   rounds. Accuse whenever you like, up to three rounds.

   The target never changes, so the imposter learns from each
   reveal and blends in better as the game goes on. Waiting for
   more data lets them catch up — that is the tension.
   ============================================================ */
TT.mode({
  id: 'imposter',
  name: 'Imposter',
  tag: 'Everyone gets the same time. One of you is faking it.',
  glyph: '?',
  color: '#A78BFA',              /* violet — the odd one out */
  singleRun: true,               /* this mode runs the room itself */

  how: [
    'The phone goes round once and everyone privately reads their time. One of you is the imposter and is told so.',
    'Then everyone attempts that time blind — tap to start, tap to stop. Your time shows at the end of your turn.',
    'Every time is revealed together, round by round. Argue, then accuse when you are ready — three rounds max.'
  ],

  homeBest(bests, players) {
    return players < 3 ? 'needs 3+ players' : players + ' in the room';
  },

  start(ctx, opts) {
    const names = ctx.roster;

    /* two players makes the deduction trivial */
    if (names.length < 3) {
      ctx.prompt('Imposter');
      ctx.display('3+');
      ctx.sub('This one needs at least three players in the room.');
      const b = document.createElement('button');
      b.className = 'btn btn-primary';
      b.style.cssText = 'width:100%;margin-top:8px;';
      b.textContent = 'Add players';
      b.addEventListener('click', () => ctx.openPlayers());
      lift();
      ctx.extra.appendChild(b);
      return;
    }

    if (!opts.diff) {
      ctx.choose('Imposter', [
        { label: 'Normal', note: 'the imposter gets a rough range', value: 'normal' },
        { label: 'Hard', note: 'the imposter gets nothing at all', value: 'hard' }
      ], (v) => TT.play('imposter', { diff: v }));
      return;
    }

    const HARD = opts.diff === 'hard';
    const MAX_ROUNDS = 3;
    const N = names.length;

    /* the secret: one target for the whole room, one imposter */
    const target = Math.round(ctx.rand(2500, 7000) / 100) * 100;
    const imposter = ctx.randInt(0, N - 1);
    /* a range that contains the target but isn't centred on it, so the
       imposter can't just play the midpoint */
    const lo = Math.max(1200, target - Math.round(ctx.rand(500, 1700) / 100) * 100);
    const hi = target + Math.round(ctx.rand(500, 1700) / 100) * 100;

    const secs = (ms) => (ms / 1000).toFixed(1);

    let round = 0;
    let turn = 0;
    let brief = 0;
    let phase = 'brief';         /* brief → pass → ready → timing → results → accuse → over */
    let startedAt = 0;
    let roundTimes = [];
    const history = [];          /* one array of durations per round */

    /* keep this mode's own controls above the full-screen tap surface */
    function lift() {
      ctx.extra.style.position = 'relative';
      ctx.extra.style.zIndex = '4';
    }
    ctx.onCleanup(() => { ctx.extra.style.position = ''; ctx.extra.style.zIndex = ''; });
    lift();

    function clearExtra() { ctx.extra.innerHTML = ''; }

    function button(label, primary, onClick) {
      const b = document.createElement('button');
      b.className = 'btn ' + (primary ? 'btn-primary' : 'btn-ghost');
      b.style.cssText = 'width:100%;margin-bottom:9px;';
      b.textContent = label;
      b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
      return b;
    }

    /* ================= PHASE 1: BRIEFING ================= */
    function briefPlayer(i) {
      brief = i;
      phase = 'brief';
      clearExtra();

      ctx.prompt('Briefing ' + (i + 1) + ' of ' + N);
      ctx.display(names[i]);
      ctx.displayClass('');
      ctx.sub('Hold the button to read your time. Check it as often as you like.');
      ctx.foot('');

      const hold = document.createElement('button');
      hold.className = 'btn hold-btn';
      hold.textContent = 'Hold to reveal';
      /* release only hides the briefing — it never advances the game,
         so a slipped finger cannot skip anyone past their own time */
      hold.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (phase === 'brief') reveal(true);
      });
      ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => {
        hold.addEventListener(ev, (e) => {
          e.preventDefault(); e.stopPropagation();
          if (phase === 'brief') reveal(false);
        });
      });

      const last = i === N - 1;
      const next = button(
        last ? 'Everyone is briefed — start round 1' : 'Pass to ' + names[i + 1],
        last,
        () => { if (last) startRound(); else briefPlayer(i + 1); }
      );

      ctx.extra.appendChild(hold);
      ctx.extra.appendChild(next);
    }

    function reveal(on) {
      if (!on) {
        ctx.display(names[brief]);
        ctx.displayClass('');
        ctx.sub('Hold the button to read your time. Check it as often as you like.');
        return;
      }
      if (brief === imposter) {
        ctx.display('IMPOSTER', 'is-bad');
        ctx.sub(HARD
          ? 'No time for you. Watch the others and blend in.'
          : 'Somewhere between ' + secs(lo) + 's and ' + secs(hi) + 's.');
      } else {
        ctx.display(secs(target) + 's', 'is-good');
        ctx.sub('Hit this exactly. Keep it to yourself.');
      }
    }

    /* ================= PHASE 2: ROUNDS ================= */
    function startRound() {
      roundTimes = [];
      handTo(0);
    }

    /* an explicit gate before each attempt, so receiving the phone
       cannot accidentally start someone's clock */
    function handTo(i) {
      turn = i;
      phase = 'pass';
      clearExtra();
      ctx.prompt('Round ' + (round + 1) + ' of ' + MAX_ROUNDS);
      ctx.display(names[i]);
      ctx.displayClass('');
      ctx.sub('Pass the phone.');
      ctx.foot('');
      ctx.extra.appendChild(button('I am ' + names[i] + ' — ready', true, () => {
        phase = 'ready';
        clearExtra();
        ctx.prompt(names[i]);
        ctx.display('—');
        ctx.sub('');
        ctx.foot('Tap anywhere to start');
      }));
    }

    function startAttempt(t) {
      phase = 'timing';
      startedAt = t;
      ctx.prompt('Go');
      ctx.display('—');
      ctx.sub('');
      ctx.foot('Tap to stop');
      ctx.beep();
      ctx.buzz(10);
    }

    function stopAttempt(t) {
      const dur = t - startedAt;
      roundTimes[turn] = dur;
      ctx.blip(880, 0.07);
      ctx.buzz(8);

      phase = 'turnend';
      clearExtra();
      ctx.prompt(names[turn]);
      /* You see your own time — but never how far off you were. An error
         figure would hand the imposter the target by simple arithmetic. */
      ctx.display((dur / 1000).toFixed(2) + 's');
      ctx.displayClass('');
      ctx.sub('That is what you put in.');
      ctx.foot('');

      const last = turn + 1 >= N;
      ctx.extra.appendChild(button(
        last ? 'Show the round' : 'Pass to ' + names[turn + 1],
        true,
        () => { if (last) revealRound(); else handTo(turn + 1); }
      ));
    }

    /* ================= THE REVEAL ================= */
    function revealRound() {
      phase = 'results';
      history.push(roundTimes.slice());
      round++;
      clearExtra();

      ctx.prompt(history.length === 1 ? 'Round 1' : 'Rounds 1 – ' + history.length);
      ctx.display('');
      ctx.sub('');
      ctx.foot('');

      /* every round so far, side by side, so the room can compare */
      const wrap = document.createElement('div');
      wrap.className = 'slab rtable-wrap';

      const table = document.createElement('table');
      table.className = 'rtable';

      const thead = document.createElement('tr');
      const blank = document.createElement('th');
      blank.textContent = '';
      thead.appendChild(blank);
      history.forEach((_, r) => {
        const th = document.createElement('th');
        th.textContent = 'R' + (r + 1);
        thead.appendChild(th);
      });
      table.appendChild(thead);

      names.forEach((nm, i) => {
        const tr = document.createElement('tr');
        const td0 = document.createElement('td');
        td0.textContent = nm;
        tr.appendChild(td0);
        history.forEach((r) => {
          const td = document.createElement('td');
          td.textContent = (r[i] / 1000).toFixed(2);
          tr.appendChild(td);
        });
        table.appendChild(tr);
      });

      wrap.appendChild(table);
      ctx.extra.appendChild(wrap);

      const actions = document.createElement('div');
      actions.style.marginTop = '14px';
      actions.appendChild(button('Accuse someone', true, askAccusation));

      if (round < MAX_ROUNDS) {
        actions.appendChild(button('Play round ' + (round + 1), false, startRound));
      } else {
        const note = document.createElement('div');
        note.className = 'hint';
        note.style.textAlign = 'center';
        note.textContent = 'Last round played — someone has to answer for it.';
        actions.appendChild(note);
      }
      ctx.extra.appendChild(actions);
      ctx.blip(1046, 0.12);
    }

    /* ================= ACCUSATION ================= */
    function askAccusation() {
      phase = 'accuse';
      clearExtra();
      ctx.prompt('Who is the imposter?');
      ctx.display('');
      ctx.sub('Agree first. One shot.');
      ctx.foot('');
      names.forEach((nm, i) => ctx.extra.appendChild(button(nm, false, () => resolve(i))));
      const back = document.createElement('div');
      back.className = 'hint';
      back.style.textAlign = 'center';
      back.textContent = history.length + ' round' + (history.length > 1 ? 's' : '') + ' played.';
      ctx.extra.appendChild(back);
    }

    function resolve(accused) {
      phase = 'over';
      const caught = accused === imposter;

      const impErrs = history.map((r) => Math.abs(r[imposter] - target));
      const crewErrs = [];
      history.forEach((r) => {
        r.forEach((d, i) => { if (i !== imposter) crewErrs.push(Math.abs(d - target)); });
      });

      const lines = [
        ['The imposter was', names[imposter]],
        ['You accused', names[accused]],
        ['Target', secs(target) + 's'],
        ['Imposter\'s closest', ctx.fmtMs(Math.min.apply(null, impErrs))],
        ['Crew average error', ctx.fmtMs(ctx.mean(crewErrs))],
        ['Rounds played', String(history.length)]
      ];
      if (!HARD) lines.splice(3, 0, ['Range they saw', secs(lo) + 's – ' + secs(hi) + 's']);

      ctx.flash(caught ? 'var(--accent)' : 'var(--bad)');
      ctx.done({
        headline: 'Imposter · ' + (HARD ? 'Hard' : 'Normal'),
        hero: caught ? 'CAUGHT' : 'ESCAPED',
        unit: caught ? 'THE CREW WINS' : names[imposter].toUpperCase() + ' WINS',
        band: caught ? 'good' : 'bad',
        score: null,              /* a social round has no personal best */
        replay: { diff: opts.diff },
        lines: lines
      });
    }

    /* the tap surface only matters during an attempt */
    ctx.tap((t) => {
      if (phase === 'ready') startAttempt(t);
      else if (phase === 'timing') stopAttempt(t);
    });

    briefPlayer(0);
  }
});
