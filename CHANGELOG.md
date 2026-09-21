# Changelog

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

Animated caption graphics are not in this release.
