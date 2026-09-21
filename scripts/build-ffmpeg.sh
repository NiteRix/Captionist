/*
 * VENDORED from NiteRix/Silencer @ 7df6387 -- scripts/build-ffmpeg.sh
 * Keep in step with upstream; scripts/sync-common.sh reports drift.
 */
#!/usr/bin/env bash
#
# Builds the minimal ffmpeg that Silencer ships.
#
# Silencer runs exactly one ffmpeg command: open a file, decode one audio
# stream, resample to mono 8 kHz, write raw floats. It never touches video,
# never encodes anything but raw PCM, and never opens a socket. A stock build
# carries all of that anyway - upstream's ffmpeg.exe is 127 MB. This one is
# about 7 MB and decodes the same files.
#
# Usage:
#   scripts/build-ffmpeg.sh windows  out/ffmpeg.exe
#   scripts/build-ffmpeg.sh linux    out/ffmpeg
#
# Windows needs mingw-w64 (apt install mingw-w64). Both need nasm.
set -euo pipefail

TARGET="${1:-linux}"
OUTPUT="${2:-}"
FFMPEG_TAG="${FFMPEG_TAG:-n7.1}"
WORK="${WORK:-$(mktemp -d)}"

[ -n "$OUTPUT" ] || { echo "usage: $0 <windows|linux> <output-path>" >&2; exit 1; }

# Resolve the destination before anything cd's anywhere. The build runs inside
# the ffmpeg checkout, so a relative output path would otherwise land there
# instead of where the caller asked for it.
mkdir -p "$(dirname "$OUTPUT")"
OUTPUT="$(cd "$(dirname "$OUTPUT")" && pwd)/$(basename "$OUTPUT")"
OUTDIR="$(dirname "$OUTPUT")"

# Containers an NLE actually hands us.
DEMUXERS=aac,ac3,aiff,amr,asf,au,avi,caf,dts,eac3,flac,flv,matroska,mov,mp3,mpegps,mpegts,mxf,ogg,w64,wav,latm,live_flv

# Audio decoders only. No video decoder is needed to demux a video file.
DECODERS=aac,aac_latm,ac3,eac3,alac,dca,flac,mp1float,mp2float,mp3float,opus,vorbis,wmav1,wmav2,wmapro,truehd,mlp,\
pcm_alaw,pcm_bluray,pcm_dvd,pcm_f16le,pcm_f24le,pcm_f32be,pcm_f32le,pcm_f64be,pcm_f64le,pcm_lxf,pcm_mulaw,\
pcm_s16be,pcm_s16be_planar,pcm_s16le,pcm_s16le_planar,pcm_s24be,pcm_s24daud,pcm_s24le,pcm_s24le_planar,\
pcm_s32be,pcm_s32le,pcm_s32le_planar,pcm_s64be,pcm_s64le,pcm_s8,pcm_s8_planar,pcm_u16be,pcm_u16le,\
pcm_u24be,pcm_u24le,pcm_u32be,pcm_u32le,pcm_u8,pcm_vidc,\
adpcm_ima_qt,adpcm_ima_wav,adpcm_ms,adpcm_swf,adpcm_yamaha

PARSERS=aac,aac_latm,ac3,dca,flac,mpegaudio,opus,vorbis,mlp

echo "==> source ($FFMPEG_TAG) into $WORK"
if [ ! -d "$WORK/src" ]; then
  git clone --depth 1 --branch "$FFMPEG_TAG" https://github.com/FFmpeg/FFmpeg.git "$WORK/src"
fi
cd "$WORK/src"

# --- the one source change -------------------------------------------------
# libavutil builds three transform implementations: float, double and fixed
# point. tx_double.o and tx_int32.o are 12.5 MB of the binary between them, and
# every decoder enabled above is float-only. The codelet table in tx.c names
# all three, so the linker cannot drop the unused two on its own - they have to
# come out of the build. Asserting on the exact text means an upstream change
# fails the build rather than silently shipping something untested.
python3 - <<'PATCH'
import io
mk = 'libavutil/Makefile'
s = io.open(mk, encoding='utf-8').read()
for obj in ('tx_double.o', 'tx_int32.o'):
    line = [l for l in s.split('\n') if l.strip().startswith(obj)]
    assert line, f'{obj} not found in {mk} - upstream layout changed'
    s = s.replace(line[0] + '\n', '', 1)
io.open(mk, 'w', encoding='utf-8').write(s)

tx = 'libavutil/tx.c'
s = io.open(tx, encoding='utf-8').read()
old = ('    ff_tx_codelet_list_float_c,\n'
       '    ff_tx_codelet_list_double_c,\n'
       '    ff_tx_codelet_list_int32_c,\n')
assert old in s, 'codelet_list layout in tx.c changed - re-check before shipping'
io.open(tx, 'w', encoding='utf-8').write(
    s.replace(old, '    ff_tx_codelet_list_float_c,\n', 1))
print('    patched: float-only transforms')
PATCH

CROSS=()
if [ "$TARGET" = "windows" ]; then
  CROSS=(--cross-prefix=x86_64-w64-mingw32- --target-os=mingw32 --arch=x86_64 --disable-schannel)
  BIN=ffmpeg.exe
else
  BIN=ffmpeg
fi

echo "==> configure"
./configure \
  "${CROSS[@]}" \
  --pkg-config=false \
  --disable-autodetect \
  --disable-everything \
  --disable-doc --disable-debug --disable-network \
  --disable-ffplay --disable-ffprobe --disable-avdevice \
  --disable-postproc --disable-swscale --disable-sdl2 \
  --disable-iconv --disable-zlib --disable-bzlib --disable-lzma \
  --enable-small \
  --enable-protocol=file,pipe \
  --enable-demuxer="$DEMUXERS" \
  --enable-decoder="$DECODERS" \
  --enable-parser="$PARSERS" \
  --enable-bsf=extract_extradata,null,aac_adtstoasc \
  --enable-encoder=pcm_f32le \
  --enable-muxer=pcm_f32le,null \
  --enable-filter=aresample,aformat,anull,abuffer,abuffersink,atrim,volume,channelmap \
  --extra-cflags="-Os -ffunction-sections -fdata-sections" \
  --extra-ldflags="-Wl,--gc-sections -s" > /dev/null

# The CLI format name is f32le but the configure component is pcm_f32le, and
# configure accepts an unknown muxer name without complaint. Check it landed.
grep -q '^CONFIG_PCM_F32LE_MUXER=yes' ffbuild/config.mak \
  || { echo "the f32le muxer did not get enabled"; exit 1; }
grep -q 'License: LGPL' ffbuild/config.log 2>/dev/null || true

echo "==> build"
make -j"$(nproc)" > /dev/null

cp "$BIN" "$OUTPUT"

# Licence obligations travel with the binary.
cp COPYING.LGPLv2.1 "$OUTDIR/ffmpeg-COPYING.LGPLv2.1"
{
  echo "This directory contains a purpose-built ffmpeg, used by Silencer to"
  echo "decode audio that the browser engine inside the panel cannot read."
  echo
  echo "ffmpeg version:  $FFMPEG_TAG"
  echo "Licence:         LGPL v2.1 or later (see ffmpeg-COPYING.LGPLv2.1)"
  echo "Upstream source: https://github.com/FFmpeg/FFmpeg/tree/$FFMPEG_TAG"
  echo
  echo "It is built with --disable-everything plus only the audio demuxers,"
  echo "decoders and the raw-PCM muxer Silencer uses, and with libavutil's"
  echo "double and fixed-point transforms removed. The exact recipe, including"
  echo "that source change, is scripts/build-ffmpeg.sh in the Silencer"
  echo "repository: https://github.com/NiteRix/Silencer"
  echo
  echo "Build configuration:"
  sed -n 's/^FFMPEG_CONFIGURATION=//p' ffbuild/config.mak
} > "$OUTDIR/ffmpeg-README.txt"

printf '==> %s  %.1f MB\n' "$OUTPUT" "$(echo "scale=2; $(stat -c%s "$OUTPUT")/1048576" | bc)"
