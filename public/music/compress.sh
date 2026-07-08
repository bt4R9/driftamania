for f in *.mp3; do
    ffmpeg -i "$f" -map_metadata -1 -map 0:a -c:a libmp3lame -b:a 96k "new_$f"
done