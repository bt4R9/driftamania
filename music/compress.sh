#!/bin/sh
# Re-encode everything in here to AAC at 80 kbps — smaller than the 96k MP3s these replaced AND
# better per byte (AAC-LC at 80k is roughly MP3 at 120k), and every browser plays m4a. `aac_at` is
# macOS's own encoder, which is markedly better than ffmpeg's built-in `aac` at low bitrates; drop
# the `_at` on Linux. -map_metadata -1 strips cover art, which is otherwise megabytes of nothing.
for f in *.mp3 *.wav *.flac; do
  [ -e "$f" ] || continue
  ffmpeg -v error -y -i "$f" -map_metadata -1 -map 0:a -c:a aac_at -b:a 80k "${f%.*}.m4a" && rm "$f"
done
echo "now list the .m4a filenames in playlist.json"
