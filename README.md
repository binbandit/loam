# Loam

Loam is an open-source, local-first knowledge base built around plain Markdown files.

## Toolchain

- Node.js 26.5.0
- pnpm 11.13.1
- Rust 1.97.1 with Clippy and rustfmt
- Turborepo 2.10.5

The versions are pinned in `.node-version`, `package.json`, and `rust-toolchain.toml`.

## Bootstrap commands

```sh
pnpm install
pnpm dev
pnpm build
pnpm test
pnpm lint
pnpm format:check
pnpm toolchain:check
```

Application behavior is added incrementally through the M0 and M1 Linear delivery plan.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, quality gates, the DCO sign-off requirement, and the clean-room rules. Security reports go through the private path in [SECURITY.md](SECURITY.md).

## License

The app and core are licensed [AGPL-3.0-only](LICENSE). `packages/plugin-sdk` and `fixtures/` are [MIT](packages/plugin-sdk/LICENSE) so plugin authors and format testers stay unencumbered. Loam is an independent project: it works with existing Markdown vaults, including those created by other tools, but is not affiliated with or endorsed by any of them.
