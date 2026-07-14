# Contributing to gang

Thanks for helping improve gang.

## Before opening a pull request

1. Open an issue for large changes so the approach can be discussed first.
2. Keep changes focused and include tests for behavior changes.
3. Run the full local check:

   ```sh
   npm ci
   npm run check
   npm audit --omit=dev
   npm pack --dry-run
   ```

4. Update `README.md` and `NOTICE` when user-facing behavior or third-party code changes.

## Development notes

- Node.js 22.19.0 or newer is required.
- `tmux` is required for end-to-end gang behavior, but unit tests do not need a running gang.
- The package is a Pi extension. `package.json` is the runtime manifest; `src/intercom/index.ts` and `src/gang/index.ts` are the extension entry points.
- Do not commit `.env` files, credentials, local Pi state, broker logs, or generated artifacts.

## Pull requests

Describe the problem, the change, and how you verified it. Keep the PR reviewable; split unrelated cleanup into a separate PR.
