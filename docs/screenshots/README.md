# Screenshots

Renders of the real panel — `extension/index.html` with its actual CSS and all
of its scripts — driven by `scripts/make-screenshots.mjs`. Only the CEP bridge
is stubbed.

The caption previews are genuine output. The harness feeds word timings to the
real `chunker.js` and then hands the result to the panel through
`window.__panel`, so what you see is the panel's own rendering rather than the
harness drawing a lookalike. The same 37 words produce 5 long-form cues at 7.4
words each and 16 short-form cues at 2.3 words each; that difference is the
whole feature, so it is worth seeing it come from the actual code.

| File | State |
|---|---|
| `1-long-form.png` | Long form captions, normal subtitle rhythm |
| `2-short-form.png` | Short form, a few words at a time |
| `3-editing.png` | Correcting the transcript in place before it is committed |
| `4-look-and-motion.png` | Caption look and animation, live preview |
| `5-animation-pop.png` | The Pop curve, frame by frame |
| `6-models.png` | Model picker, one installed |

`3-editing.png` is a real edit session: the harness types two corrections
through the panel's own edit path (`Their was` → `There was`, `the hole
problem` → `the whole problem`), which is why the rows carry the edited marker
and the bar offers to revert them.

Transcription itself is not exercised here — that needs whisper-cli and a
downloaded model, neither of which belongs in a screenshot harness.

`5-animation-pop.png` comes from `scripts/make-animation-strip.mjs`, which
simulates Premiere's linear keyframe interpolation across a clip so the
animation curves can be seen without opening Premiere. Pop reads as invisible,
small, overshooting past full size, settled, then faded.
