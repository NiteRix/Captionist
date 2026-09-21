# Captionist

Automatic subtitles for Adobe Premiere Pro, transcribed on your own machine.

No account. No sign-in. No upload. No per-minute billing. Your audio never
leaves your computer — the only network request Captionist ever makes is
fetching the speech model you asked for.

Two shapes of caption: **short form**, a few words at a time for vertical
video, and **long form**, normal readable subtitles. Both adjustable.

Sibling to [Silencer](https://github.com/NiteRix/Silencer), which cuts the
silence out of a timeline. They install separately and neither needs the other.

---

## Install

### Windows

1. Download `Captionist-x.y.z-Setup.exe` from the
   [Releases page](https://github.com/NiteRix/Captionist/releases) and run it.
2. Restart Premiere Pro.
3. `Window > Extensions > Captionist`.
4. Open the **Models** tab and download a speech model.

No admin rights, no UAC prompt — it installs into your own user folder.

### macOS

1. Download the portable zip, unpack it, double-click **`Install-Mac.command`**.
   If macOS blocks it, right-click the file and choose **Open**.
2. `brew install ffmpeg whisper-cpp` — macOS binaries are not bundled yet.
3. Restart Premiere Pro, then pick a model in the **Models** tab.

---

## Models

Models are **not** bundled. They run from about 75 MB to 3 GB, and which one
suits you depends entirely on your machine and your patience, so Captionist
downloads the one you pick.

| Model | Roughly | Notes |
|---|---|---|
| Tiny | 75 MB | Fastest, rough. Fine for rough cuts. |
| Base | 142 MB | Quick and usable. |
| Small | 466 MB | Good accuracy, still fast. |
| **Large v3 Turbo** | 1.6 GB | **Best balance for most people.** |
| Large v3 Turbo (compressed) | ~550 MB | Nearly the same, much smaller. |
| Large v3 | 2.9 GB | Best accuracy, slowest. |

Sizes are approximate; the panel shows the real figure from the server before
downloading anything.

Models live in `%APPDATA%\Captionist\models` (macOS:
`~/Library/Application Support/Captionist/models`) — deliberately **outside**
the extension folder, because installing an update deletes that folder and
would otherwise throw away a multi-gigabyte download every time.

`.en` models are English-only and a little sharper on English than the
multilingual ones of the same size.

---

## Use

1. Open the sequence.
2. Pick a model and a caption style.
3. **Transcribe sequence.**
4. Adjust the shape if you want — the preview updates instantly, without
   re-running the model.
5. **Add to sequence**, or **Save .srt** to take elsewhere.

### Short form vs long form

| | Short form | Long form |
|---|---|---|
| Words per caption | 3 | 12 |
| Characters per line | 16 | 42 |
| Lines | 1 | 2 |
| Time on screen | 0.3–1.2 s | 1.0–6.0 s |
| Break after a pause of | 0.25 s | 0.40 s |

Picking a style resets the sliders to its numbers; changing any slider
afterwards is yours to keep. Re-shaping never re-runs the model, so it is
instant.

---

## How it works

**Audio.** Every source file on the audio tracks is decoded once, only across
the span the timeline actually uses, then painted into a single 16 kHz mono
stream honouring in-points, clip speed and overlap. Whisper gets one
continuous take, which keeps its context across cuts and means every timestamp
it returns is already a timeline timestamp.

**Transcription.** whisper.cpp runs locally, with `--dtw` for proper
word-level timing. Segment-level timing is not enough when a caption holds
three words for under a second.

**Shaping.** Words become captions by greedy accumulation with *scored break
points* — a full stop beats a comma, which beats a long pause, which beats
simply running out of room. Plus widow control so a single short word is not
left stranded, and frame snapping so Premiere never sees a part-frame
boundary.

**Insertion.** An SRT is written and imported, and attached as a caption track
where Premiere's scripting allows it. Animated graphics captions are planned;
see below.

---

## Requirements

- Premiere Pro 2019 (13.0) or newer.
- Windows 10+ or macOS 10.14+.
- A few GB of disk for whichever model you choose.
- CPU only — no GPU needed, and none is used.

Rough speeds on a modern CPU: tiny ~10–20× realtime, base ~7–12×,
small ~3–5×, large-v3-turbo ~3–5×, large-v3 ~0.5–1×.

## Not yet

- **Animated captions.** The plan is Canvas-rendered caption graphics with
  keyframed scale and opacity, and optional Motion Graphics Template support.
  Today Captionist produces SRT and a caption track.
- **macOS binaries.** Homebrew for now.
- **Speaker labels.**

## Building

```bash
node scripts/check-syntax.mjs   # parse everything, check the manifest
node scripts/test.mjs           # word parsing and caption shaping
scripts/sync-common.sh          # report drift against Silencer's shared files

scripts/build-ffmpeg.sh windows ffmpeg-out/ffmpeg.exe   # needs mingw-w64
pwsh scripts/build-whisper.ps1 -Output whisper-out/whisper-cli.exe   # needs MSVC
```

whisper has to be built with MSVC on Windows rather than cross-compiled: ggml's
Windows thread-throttling code uses `THREAD_POWER_THROTTLING_STATE`, which
mingw-w64 v11 headers do not define.

## Shared code

`extension/js/common/`, `extension/jsx/common/` and `scripts/build-ffmpeg.sh`
are vendored from [Silencer](https://github.com/NiteRix/Silencer) rather than
shared through a submodule. Each file carries a header naming its origin, and
`scripts/sync-common.sh` reports when upstream has moved on. CI runs it as an
advisory check — divergence is sometimes correct.

## Licence

Captionist is MIT — see [LICENSE](LICENSE).

It bundles [ffmpeg](https://ffmpeg.org) (LGPL v2.1) and
[whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT); both ship their
licence and build recipe alongside the binary in `extension/bin/`. Whisper
models are MIT, published by OpenAI.
