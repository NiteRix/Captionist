# Changelog

## 0.1.1

### Fixed: animated captions landed at 00:00:00

**Add animated to sequence** rendered its PNGs and imported them, but they did
not appear where they belonged — dragging the same files in by hand worked.
Six calls into Premiere's scripting API were wrong, and the first of them
accounts for the symptom entirely.

- `Track.overwriteClip`'s time argument is documented as **ticks**, and it was
  being given seconds. A caption at 0.5 s became 0.5 ticks — about two
  billionths of a second — so every graphic was placed at the very start of the
  timeline, each one overwriting the last. Adobe's own example in the same
  reference passes seconds, so rather than guess, Captionist now places the
  clip, checks where it actually landed, and keeps whichever form works for the
  rest of the run.
- `ProjectItem.setInPoint`/`setOutPoint` also take ticks, despite the parameter
  being named `seconds`. Without this the stills kept Premiere's default
  duration instead of the caption's.
- `importFiles` was passed `null` for the destination bin, so the items landed
  wherever Premiere chose; the lookup that followed only searched the project
  root and could miss them. Imports now go straight into the target bin and the
  lookup walks the whole tree.
- `Sequence.createCaptionTrack`'s third argument is a caption **format**, not a
  boolean.
- `setValueAtKey`'s `updateUI` is an Integer, not a Boolean, and `addKey` is
  documented to throw on non-colour properties — so `setValueAtKey` does the
  work and `addKey` is only a best-effort nudge. Keyframe support is checked
  first, and what Premiere actually stored is read back into the panel log.
- If the first few captions cannot be placed where they were asked to go,
  the run stops and says so, instead of stacking the whole set at the head of
  the timeline.

### Added: correct captions before committing them

Captions can be edited in place in the preview. This matters most for the
animated route, where the text is baked into a PNG — after that, a typo means
re-rendering the whole run.

- Click a caption and type. Enter commits, Escape restores, Tab moves to the
  next caption, so a correction pass is a keyboard job.
- A spelling fix keeps the original word timings exactly. Adding or removing
  words redistributes the caption's own span across the new words in proportion
  to their length, so the caption still starts and ends where it did and
  nothing after it moves.
- Typed line breaks are honoured; otherwise corrected text is re-wrapped, and
  is allowed extra lines rather than overflowing the ones the preset allows.
- Corrected captions are marked, counted, and can all be reverted at once.
  Re-shaping rebuilds captions from the transcript and cannot carry corrections
  across, so it asks before discarding them.

## 0.1.0

First release. Transcription end to end, subtitles out.

- Local transcription with whisper.cpp — nothing is uploaded, and the only
  network request is fetching the model you pick.
- Model manager: download, resume, remove, disk usage, or point at your own
  `.bin`. Models are kept outside the extension folder so updates cannot
  delete them.
- Timeline audio rendered to one continuous 16 kHz mono stream, honouring
  in-points, clip speed, overlap and muted tracks, decoding only the span the
  timeline actually uses.
- Word-level timing via `--dtw`, with tokens reassembled into words and
  out-of-order or missing timings repaired.
- Short form and long form caption shaping, with scored break points, widow
  control and frame snapping. Re-shaping is instant and never re-runs the model.
- SRT and VTT output, imported into the project and attached as a caption
  track where Premiere allows it.
- Progress, cancel and stall detection on every long-running step.
- ffmpeg and whisper-cli built into the Windows release; nothing is downloaded
  at install time.

### Animated captions

- Caption graphics drawn by the panel at the sequence's own resolution, in
  three looks: Clean, Punch and Boxed. Size, position, distance from edge,
  highlight colour and uppercase are adjustable, with a live preview.
- Five animation presets (none, fade, pop, punch, rise) applied as keyframes
  on Premiere's own Motion and Opacity properties rather than as a rendered
  frame sequence. An intensity slider scales how far each property departs
  from rest, and entrance/exit are capped at 80% of a caption's life so short
  captions still animate properly.
- Per-word highlighting: a multi-word caption becomes one graphic per word,
  each starting when that word is spoken.
- The caption-track and .srt routes are unchanged, for when editable text
  matters more than motion.

### Typography

- Full font control: every font installed on the machine, with the weights and
  italics it genuinely has. Choosing a family repopulates the style list from
  that family, so a weight the font does not ship can never be selected.
- The list starts with **Don't change**, which leaves the look preset's font
  alone.
- Letter spacing, line height, text colour, outline colour and thickness, and
  drop shadow are all exposed alongside the existing size, position and
  highlight controls.
- Fonts are found by reading the font files themselves, since a browser cannot
  enumerate system fonts: each file's `name` and `OS/2` tables are parsed for
  family, style, weight and italic, reading a few kilobytes rather than the
  whole file. Scanning is deferred until the section is opened and can be
  re-run from a button.
- Letter spacing is applied by hand rather than through `ctx.letterSpacing`,
  which is newer than the engine inside some Premiere versions. Doing it
  manually also keeps measurement and drawing in agreement, which is what
  centring and per-word highlighting depend on.
