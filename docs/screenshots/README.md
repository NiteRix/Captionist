# Screenshots

Renders of the real panel — `extension/index.html` with its actual CSS and all
nine of its scripts — driven by `scripts/make-screenshots.mjs`. Only the CEP
bridge is stubbed.

The caption previews are genuine output: the same 37 words are run through the
real `chunker.js`, once per preset. Long form produces 5 cues at 7.4 words
each; short form produces 16 at 2.3 words each. That difference is the whole
feature, so it is worth seeing it come from the actual code.

| File | State |
|---|---|
| `1-long-form.png` | Long form captions, normal subtitle rhythm |
| `2-short-form.png` | Short form, a few words at a time |
| `3-models.png` | Model picker, one installed |
| `4-look-and-motion.png` | Caption look and animation, live preview |

Transcription itself is not exercised here — that needs whisper-cli and a
downloaded model, neither of which belongs in a screenshot harness.
