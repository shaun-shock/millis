# Error Margin

A browser game where everything is measured in milliseconds of error.

No build step, no dependencies, no framework — plain HTML, CSS and JavaScript.
Open `index.html` in a browser and it runs.

## Modes

| Mode | What you do |
| --- | --- |
| **Blind Stop** | A stopwatch runs up and the digits go dark. Stop it on the target anyway. Hard mode never shows a digit and uses un-round targets. |
| **Split** | Carve a total into equal taps — 30 seconds in 10 taps is 3s each. No clock, no counter, no feedback until the end. |
| **How Long** | A tone holds for some duration. You say how many milliseconds it lasted. Scored as a percentage, because judging 5s to ±100ms is far harder than 500ms to ±100ms. |

## Pass and play

Set a roster of up to 6 players on the home screen. Everyone plays the same
challenge in sequence — the randomness is seeded once per match and replayed
for each player — with a handoff screen between turns and a leaderboard at the
end. Solo is just a match of one.

## Layout

```
index.html        screens and script tags
style.css         design tokens and every screen's styling
core.js           engine: screens, mode registry, timing, audio, results, bests
ads.js            ad layer, inert until a provider is wired
modes/*.js        one file per mode, self-registering via TT.mode({...})
```

## Adding a mode

Modes register themselves and drive the play screen through the `ctx` object:

```js
TT.mode({
  id: 'yourmode',
  name: 'Your Mode',
  tag: 'One line shown on the home card.',
  glyph: '◆',
  start(ctx, opts) {
    ctx.prompt('Round 1');
    ctx.display('0.000');
    ctx.tap((t) => { /* t is a performance.now() timestamp */ });
    // ctx.done({ hero, unit, band, score, lines }) ends the run
  }
});
```

Add a `<script>` tag for it in `index.html` and it appears on the home screen.

`ctx` gives you stage writers (`prompt`/`display`/`sub`/`foot`/`extra`), input
(`tap`), timers that clean themselves up (`after`/`every`/`loop`), feedback
(`beep`/`blip`/`buzz`/`flash`), seeded randomness (`rand`/`randInt`), formatting
helpers, and `done()` to finish.

## Timing notes

- Tap timestamps come from `performance.now()` at `pointerdown`.
- Input latency largely cancels in Blind Stop and Split, since both the start
  and stop taps travel the same pipeline — it shows up as a small constant bias
  rather than noise, and it hits every player on the device equally.
- Ad code never runs during a run. `show()` in `core.js` calls
  `Ads.setPlaying()` on every screen change, so this holds for any future mode.
- Leaving the tab mid-run returns to the home screen, because a backgrounded
  tab would poison the measurement.
