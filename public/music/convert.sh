#!/usr/bin/env bash

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────
# Fixed CBR bitrate. Common choices: 128k, 192k, 256k, 320k.
BITRATE="192k"
# Prefer VBR instead? Comment the two -b:a lines below and use: -q:a 2
# (LAME VBR quality: 0 = best/largest ... 9 = worst/smallest; 2 ≈ 190 kbps)
# ──────────────────────────────────────────────────────────────────────

if [[ $# -ne 1 ]]; then
    echo "Usage: $0 <input.flac|input.m4a>"
    exit 1
fi

INPUT="$1"

if [[ ! -f "$INPUT" ]]; then
    echo "Error: File not found: $INPUT"
    exit 1
fi

# Make sure the tools we need are present.
if ! command -v ffmpeg >/dev/null 2>&1; then
    echo "Error: ffmpeg is not installed or not on PATH."
    exit 1
fi
ENCODERS="$(ffmpeg -hide_banner -encoders 2>/dev/null || true)"
if ! printf '%s' "$ENCODERS" | grep -q 'libmp3lame'; then
    echo "Error: your ffmpeg build has no libmp3lame (MP3) encoder."
    exit 1
fi

# Lowercase the extension in a way that works on bash 3.2 (macOS default),
# since \${EXT,,} requires bash 4.0+.
EXT="${INPUT##*.}"
EXT="$(printf '%s' "$EXT" | tr '[:upper:]' '[:lower:]')"

case "$EXT" in
    flac|m4a)
        ;;
    *)
        echo "Error: Input file must be a .flac or .m4a file."
        exit 1
        ;;
esac

OUTPUT="${INPUT%.*}.mp3"

ffmpeg -hide_banner -loglevel error -y \
    -i "$INPUT" \
    -map 0:a:0 \
    -map_metadata -1 \
    -map_chapters -1 \
    -fflags +bitexact -flags:a +bitexact \
    -codec:a libmp3lame \
    -b:a "$BITRATE" \
    "$OUTPUT"

echo "Created: $OUTPUT ($BITRATE)"