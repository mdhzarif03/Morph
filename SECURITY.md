# Security Policy

## Reporting a vulnerability

Please do not open a public issue. Use the repository's private vulnerability reporting (GitHub → Security → Report a vulnerability) once enabled, or contact the maintainers privately. Include steps to reproduce and affected version. <!-- Maintainers: enable private reporting and/or add a contact address before publishing. -->

## Scope and design

Morph processes untrusted files locally. Relevant protections: sandboxed renderer with context isolation, strict CSP, validated IPC from trusted frames only, opaque file ids instead of renderer-supplied paths, argument-array process execution (no shell), pixel and animation limits, safe ZIP entry names, exclusive-create output files so nothing is overwritten, and temporary work directories removed after each job.

Out of scope: vulnerabilities inside FFmpeg, Poppler, LibreOffice or Sharp themselves (report upstream), though we want to know so we can bump versions.

## Supported versions

Only the latest release receives fixes.
