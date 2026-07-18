# Security policy

Loam is a local-first application: your notes live on your disk, the app makes no network calls without explicit action, and telemetry is strictly opt-in. Security reports that affect that promise are taken seriously.

## Supported versions

Loam is pre-1.0. Only the latest release (and `main`) receive security fixes.

## Reporting a vulnerability

Please use a private channel. **Do not open a public issue for a security report.**

1. Preferred: GitHub's private vulnerability reporting — "Security" tab → "Report a vulnerability" on this repository.
2. If that is unavailable, contact a maintainer listed in [MAINTAINERS.md](MAINTAINERS.md) through a private channel and ask for a secure contact before sending details.

Include what you can: affected version or commit, reproduction steps, impact assessment, and any suggested fix. Reports in English are easiest for us to act on quickly.

## What to expect

This is a volunteer-run open-source project. We aim to acknowledge reports and keep reporters informed as we investigate, but we do not commit to fixed response or fix timelines. We practice coordinated disclosure: we ask that you give us a reasonable opportunity to ship a fix before publishing details, and we will credit reporters in release notes unless they prefer otherwise.

## Scope notes

- Community plugins run with app privileges by design (documented in the plugin docs); reports about the *plugin platform's* safety rails (restricted mode, permission surfacing, registry checks) are in scope, while vulnerabilities in individual third-party plugins should go to their authors.
- A full threat-model document lands in `docs/security.md` as the plugin runtime and sync features are built.
