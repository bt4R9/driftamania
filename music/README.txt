Drop your music here and list the filenames in playlist.json:

  "menu" / "race" — each list is SHUFFLED, played through once, then
  shuffled again; a new shuffle never opens with the song that just
  played. A single-track list simply loops.

An entry is either "file.m4a" or { "artist", "song", "file" } — the second
form is announced on screen when the track starts.

menuCooldown / raceCooldown set the seconds of quiet between songs.

Any format the browser plays works (m4a, mp3, ogg...). Missing files are
skipped silently. Volume is mixed in-game.

  M      mute everything
  < / >  previous / next track  (the , and . keys — shift optional)

The shipped tracks are AAC at 80 kbps (.m4a) — smaller than the 96k MP3s
they replaced and better per byte, and every browser plays them. Drop new
tracks in as anything, then run ./compress.sh and update the list above.
