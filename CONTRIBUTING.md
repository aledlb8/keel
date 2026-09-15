# Contributing to Keel

Thanks for helping improve Keel. Keep changes focused, explain user-visible behavior in the pull request, and include verification appropriate to the change.

## Setup

Keel uses pnpm and the Rust toolchain. Install the platform prerequisites from the [Tauri documentation](https://tauri.app/start/prerequisites/), then run:

```sh
corepack enable
pnpm install
pnpm doctor
```

Start the desktop application with `pnpm dev`. Use `pnpm dev:web` only for frontend work that does not depend on Tauri commands.

## Before opening a pull request

Run the repository checks:

```sh
pnpm check
```

For changes that affect packaging, also run the relevant production build when your platform supports it:

```sh
pnpm build:app
```

Do not commit `release/`, `dist/`, `src-tauri/target/`, TypeScript build-info files, editor state, credentials, VPN profiles, local environment files, or other machine-specific data.

## Project conventions

- Keep TypeScript and React code consistent with the surrounding files.
- Run `pnpm rust:fmt` after changing Rust code.
- Add focused tests for pure logic and regressions where a test meaningfully protects behavior.
- Keep platform-specific behavior behind the appropriate runtime or compile-time checks.
- Update documentation when commands, configuration, setup requirements, or user-visible behavior change.

## Issues and security

Use GitHub issues for reproducible bugs and scoped feature requests. Do not post credentials, private VPN profiles, access tokens, or other sensitive data in issues, logs, screenshots, or pull requests.
