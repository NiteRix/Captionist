# Changelog

## 0.1.3

### Fades use Premiere's own Cross Dissolve

Keyframes were confirmed as the cause of captions that were placed,
selectable and invisible. A keyframe has to be written at a point on a clock,
and the reference never says which clock; a transition does not, because it
belongs to a clip edge. So the fade now goes through Premiere's own Cross
Dissolve and writes no opacity keyframes at all.

The other half of the difference is that this one can be checked.
`Track.transitions` is documented and readable, so a transition that did not
take is visible immediately — where `getKeys()` would happily report keyframes
that Premiere then declined to render.

- **Fade** needs no keyframes now. **Pop**, **Punch** and **Rise** keep them
  for the scale and position moves a transition cannot do, but hand their
  opacity to the dissolve.
- Adding a transition is not in the documented API, so it goes through QE,
  tries the call shapes that have existed across versions, and keeps whichever
  the track accepts — then counts the track's transitions to confirm.
- Fades are clamped to 80% of a caption's length, so a short one still sits
  still for a moment.
- If the dissolve cannot be added, it falls back to opacity keyframes and says
  so in the log rather than silently dropping the fade.
- **Fade with Premiere's own dissolve** in Look and motion turns it off.

Stills are the ideal case for this: a transition needs handles beyond the clip
edge, and a still image has unlimited ones.

## 0.1.2

### Still chasing: animated captions that are placed but invisible

0.1.1 fixed the time form `overwriteClip` is given, which was genuinely
wrong. It was not the whole story: the captions now land in the right place —
they can be selected on the timeline — and still render nothing, while the
same PNG dragged in by hand looks fine.

A clip that is present, selectable and invisible has a short list of causes.
This release addresses all three, and reports which one applied.

- **Keyframes on the wrong clock.** Every animation preset starts and ends at
  zero opacity. The scripting reference says a keyframe time is "when the
  keyframe should be added" and never says whether that is measured from the
  start of the sequence or the start of the clip. Get it wrong and every key
  falls outside the clip, the clip holds the nearest key's value, and that
  value is zero — present, selectable, invisible. The first caption is now a
  probe: its keys are written against the sequence clock and read back with
  `getKeys()`, and the clock whose keys Premiere keeps is the one used for the
  rest. The log says which won.
- **Never invisible as a failure mode.** If neither clock survives the check,
  the keyframes are removed and the property is put back to rest, so the
  captions are static and *visible* rather than animated and absent. The panel
  says so plainly instead of claiming success.
- **Captions under the picture.** The target track was the highest existing
  video track, whether or not it was free. If that track held footage,
  `overwriteClip` destroyed it; if the only free track was below the picture,
  the captions were placed perfectly and covered up. Captions now go on the
  highest *empty* video track, and a new one is added above when every track
  is occupied.
- **A track with its output switched off** renders nothing while its clips
  still select normally. That is now detected and switched back on.

If your timeline still has invisible captions from an earlier version, delete
them and insert again — or select them and use Remove Attributes to strip the
opacity keyframes.

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
