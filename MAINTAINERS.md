# Maintainers

## Current maintainers

| Name | GitHub | Role |
| --- | --- | --- |
| Brayden Moon | [@crazywolf132](https://github.com/crazywolf132) | Project lead, release keys |

## Bus-factor plan

A single maintainer is an accepted bootstrap state, not a steady state:

- From M1 onward, at least **two humans** hold release signing keys and registry admin rights (SPEC.md §7). Recruiting the second key-holder is a tracked launch requirement.
- Release automation, signing, and registry pipelines are documented as they are built so that any maintainer can run a release end to end.
- All infrastructure access (CI secrets, updater keys, registry repos, domains) is inventoried here as it is created, with at least two people able to reach each item before 1.0.

## Becoming a maintainer

Sustained, high-quality contributions and review work are the path in; maintainers are added by consensus of the existing maintainers. Governance details (RFC process for public API and file-format changes) live in CONTRIBUTING.md and `docs/adr/`.
