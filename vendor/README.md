# Optional FFmpeg override

Morph needs nothing installed on the user's computer. Documents and PDFs are converted by libraries inside the
app, and audio/video use the FFmpeg binaries delivered by the `ffmpeg-static` and `@ffprobe-installer/ffprobe`
npm packages (they are packed into the installer).

If you want to ship a different FFmpeg build (for example an LGPL-only one, see `docs/DEPENDENCIES.md`), put
`ffmpeg.exe` and `ffprobe.exe` in `vendor/ffmpeg/` (or `vendor/ffmpeg/bin/`) before packaging. A bundled build here
takes priority over the npm one. Everything in this folder except this README is ignored by git.
