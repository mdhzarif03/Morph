# Morph

**Files, transformed.** A local-first universal file converter for Windows 10/11 (x64).
Press one shortcut, drop a file, pick a format, done. Nothing leaves your computer.

> Status: early release (0.1.0). Developed and tested on Linux; the app has been run on Windows 11 with `npm run dev`. The Windows installer is cross-built and has not been tested on a clean Windows machine. See [Known limitations](#known-limitations).

<!-- Screenshots: add docs/screenshots/*.png and reference them here before publishing. -->

## Features

- Global shortcut (default **Ctrl+Shift+C**, configurable) opens a small floating window at the top of the screen. It does not steal focus unless you choose that in Settings.
- Drag and drop, or Browse. Batches are supported.
- Only formats that make sense for the dropped file, and that your installed tools can produce, are offered.
- Output goes next to the original by default. Originals are never modified; existing files are never overwritten (`logo (1).webp`).
- No telemetry, no accounts, no cloud. Tools are never downloaded automatically.
- Tray icon (Open, Settings, Quit). Launch at login is off by default.

## Conversions

| Category | From | To | Needs |
| --- | --- | --- | --- |
| Images | PNG, JPG, WebP, AVIF, BMP, TIFF, GIF, ICO | the same set | built in (Sharp) |
| Documents | DOCX, DOC (text only), ODT, TXT | PDF, PNG, JPG | built in (laid out by Morph, rendered by PDFium) |
| PDF | PDF | PNG, JPG per page (ZIP when more than one page) | built in (PDFium) |
| Audio | MP3, WAV, FLAC, AAC, OGG, M4A | the same set | FFmpeg (ships inside the installer) |
| Video | MP4, MKV, MOV, WebM, AVI | the same containers, or audio only | FFmpeg (ships inside the installer) |

Morph is **standalone**: nothing else (Office, LibreOffice, Poppler, FFmpeg) has to be installed on the computer. Notes: PDF to Word is not offered, and conversions between word-processor formats (for example DOCX to ODT) are not offered because they cannot be done faithfully without a full office suite. Video uses stream copy when the source already fits the target container, otherwise it re-encodes. Multi-page results are saved as `name_page_001.jpg` inside `name.zip`.

## Run from source

Requires Node.js 22.12+.

```bash
npm install
npm run dev        # development with hot reload
npm run build && npm start   # production build
```

No other software is needed. Documents and PDFs are handled by libraries inside the app; FFmpeg comes from the `ffmpeg-static` / `@ffprobe-installer/ffprobe` npm packages (their binaries are downloaded by npm during `npm install`).

## Build the Windows installer

Run on Windows 10/11 x64:

```bash
npm install
npm run check:vendor   # verifies FFmpeg/FFprobe are present for the installer
npm run package        # NSIS installer in release/
npm run package:dir    # unpacked app for quick inspection
```

Review [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md) before distributing an installer: the bundled FFmpeg build carries its own licence (GPL for the npm-supplied binaries) that you must comply with. The installer is unsigned unless you add code signing.

## Development

```bash
npm run lint
npm run typecheck
npm test            # unit + integration (document tests need a Chromium for Playwright; FFmpeg tests need the npm FFmpeg)
npm run test:e2e    # Playwright + Electron (needs a display; use xvfb-run on Linux)
npm run verify      # lint + typecheck + test + build
```

Layout: `src/shared` contracts, `src/core` conversion engines and job pipeline (no Electron imports), `src/main` Electron main process, `src/preload` typed bridge, `src/renderer` React UI.

## Security and privacy

Context isolation on, Node integration off, strict CSP, a minimal typed preload API, schema-validated IPC from trusted senders only, no shell string interpolation (arguments are passed as arrays), input limits against decompression bombs, and ZIP entry names sanitised. The renderer never supplies raw file paths for conversion. See [SECURITY.md](SECURITY.md).

## Known limitations

- The Windows installer, Windows shortcut registration, tray and launch-at-login behaviour have not been tested on a real Windows machine.
- Document layout is done by Morph, not by Word: DOCX and ODT fonts, sizes, colours, alignment, spacing, lists, tables, pictures and page size/margins are reproduced, but headers, footers, footnotes, columns, text boxes and tracked changes are not, fonts not installed on the machine are substituted, and page breaks can differ slightly. Legacy `.doc` files are converted as plain text only. Save as DOCX for the best result.
- Encrypted PDFs and password-protected documents are rejected, not unlocked.
- No code signing; Windows SmartScreen will warn on unsigned builds.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under the [MIT License](LICENSE); third-party notices are in [docs/](docs/).
