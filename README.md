# Morph

**Files, transformed.** A local-first universal file converter for Windows 10/11 (x64).
Press one shortcut, drop a file, pick a format, done. Nothing leaves your computer.

> Status: early release (0.1.0). Developed and tested on Linux; the Windows installer has **not** been built or run yet. See [Known limitations](#known-limitations).

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
| Documents | DOCX, DOC, ODT, TXT | PDF, PNG, JPG, and DOCX/ODT/DOC where sensible | LibreOffice (+ Poppler for page images) |
| PDF | PDF | PNG, JPG per page (ZIP when more than one page) | Poppler |
| Audio | MP3, WAV, FLAC, AAC, OGG, M4A | the same set | FFmpeg |
| Video | MP4, MKV, MOV, WebM, AVI | the same containers, or audio only | FFmpeg |

Notes: PDF to Word is deliberately not offered. Video uses stream copy when the source already fits the target container, otherwise it re-encodes. Multi-page results are saved as `name_page_001.jpg` inside `name.zip`.

## Run from source

Requires Node.js 22.12+.

```bash
npm install
npm run dev        # development with hot reload
npm run build && npm start   # production build
```

External tools (optional, per conversion type): FFmpeg is pulled in through npm on supported platforms; install LibreOffice and Poppler yourself or place them in `vendor/` (see [vendor/README.md](vendor/README.md) and [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md)). Settings → Tools shows what was found.

## Build the Windows installer

Run on Windows 10/11 x64:

```bash
npm install
npm run check:vendor   # shows which optional tools will be bundled
npm run package        # NSIS installer in release/
npm run package:dir    # unpacked app for quick inspection
```

Review [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md) before distributing an installer: bundled FFmpeg/LibreOffice/Poppler carry their own licences (GPL/LGPL/MPL) that you must comply with. The installer is unsigned unless you add code signing.

## Development

```bash
npm run lint
npm run typecheck
npm test            # unit + integration (real tools are used when present, otherwise those tests skip)
npm run test:e2e    # Playwright + Electron (needs a display; use xvfb-run on Linux)
npm run verify      # lint + typecheck + test + build
```

Layout: `src/shared` contracts, `src/core` conversion engines and job pipeline (no Electron imports), `src/main` Electron main process, `src/preload` typed bridge, `src/renderer` React UI.

## Security and privacy

Context isolation on, Node integration off, strict CSP, a minimal typed preload API, schema-validated IPC from trusted senders only, no shell string interpolation (arguments are passed as arrays), input limits against decompression bombs, and ZIP entry names sanitised. The renderer never supplies raw file paths for conversion. See [SECURITY.md](SECURITY.md).

## Known limitations

- The Windows installer, Windows shortcut registration, tray and launch-at-login behaviour have not been tested on a real Windows machine.
- Without LibreOffice or Poppler installed (or bundled), document and PDF conversions are disabled and the UI says why.
- Encrypted PDFs and password-protected documents are rejected, not unlocked.
- Visual fidelity of DOCX/DOC/ODT output is whatever LibreOffice produces.
- No code signing; Windows SmartScreen will warn on unsigned builds.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under the [MIT License](LICENSE); third-party notices are in [docs/](docs/).
