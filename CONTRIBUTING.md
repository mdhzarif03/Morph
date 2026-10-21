# Contributing to Morph

Thanks for helping. Please open an issue before large changes.

## Setup

Node.js 22.12+, then `npm install`. Run `npm run dev`. Before a pull request run `npm run verify` and, for UI or window changes, `npm run test:e2e`.

## Guidelines

- Strict TypeScript, no `any`. Lint must pass.
- `src/core` must not import Electron. Conversions are described once in `src/core/registry.ts`; the UI and validation derive from it.
- Never build shell command strings; pass argument arrays. Treat all input files as hostile.
- New conversion routes need an integration test that runs the real tool (skipped when the tool is absent) and an honest note on limitations.
- Never add telemetry, network calls, or silent downloads.
- Keep the shortcut policy: no bare or Shift-only shortcuts.

## Pull requests

Describe what changed and how you tested it. Do not claim tests passed unless you ran them.
