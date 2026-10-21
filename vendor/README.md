# Bundled tools (optional)

Morph finds FFmpeg, Poppler and LibreOffice in this order: path chosen in Settings, **this folder**,
the npm packages `ffmpeg-static` / `@ffprobe-installer/ffprobe`, well-known install locations, then `PATH`.

Nothing here is downloaded automatically. To ship a self-contained installer, place the tools yourself
(and keep their licences with them, see `docs/DEPENDENCIES.md`):

| Tool | Expected location |
| --- | --- |
| FFmpeg + FFprobe | `vendor/ffmpeg/ffmpeg.exe`, `vendor/ffmpeg/ffprobe.exe` (or `vendor/ffmpeg/bin/`) |
| Poppler | `vendor/poppler/**/pdftoppm.exe` and `pdfinfo.exe` (any nesting, up to 5 levels) |
| LibreOffice | `vendor/libreoffice/program/soffice.exe` (a portable/extracted install) |

Run `npm run check:vendor` to see what will be bundled. Everything is optional: missing tools are reported
in Settings → Tools with an install hint, and only the conversions that need them are disabled.

Files in this folder other than this README are ignored by git (see `.gitignore`).
