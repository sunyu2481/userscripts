# Repository Guidelines

## Project Structure & Module Organization

This repository contains self-contained Tampermonkey userscripts. Root-level `build.js` and `test.js` discover script directories. Each script under `scripts/<name>/` normally contains:

- `src/`: ordered JavaScript chunks; numeric prefixes (for example, `30-detect.js`) define concatenation order.
- `test/`: `node:test` suites and small test helpers.
- `build.js`, `README.md`, and the generated `<name>.user.js` bundle.

`dist/` contains installable generated bundles. Edit `src/`, not generated `.user.js` files or `dist/` directly.

## Build, Test, and Development Commands

Node.js 18 or newer is required; there are no third-party runtime dependencies.

```bash
npm run build                 # Build every discovered script and refresh dist/
npm test                      # Build scripts, then run all tests
npm run check                 # Build and test the complete repository
node build.js api-auto-checkin # Build one script by directory name
node test.js api-auto-checkin  # Test one script by directory name
```

For a release, run `node build.js --bump` in a script directory, then run the root build and commit updated bundles. CI repeats these checks on pushes to `main`.

## Coding Style & Naming Conventions

Use CommonJS JavaScript, two-space indentation, semicolons, and single-quoted strings. Keep functions focused and use descriptive English identifiers. Source filenames use two-digit numeric prefixes and kebab-case names. Comments and README prose are Chinese; identifiers remain English. No formatter or linter is configured, so follow neighboring code.

## Testing Guidelines

Tests use Node's built-in `node:test` runner and are named `*.test.js`. Update tests with behavior changes, including structure tests when an invariant changes. `test/load-src.js` evaluates the same source the build concatenates; keep tests dependency-free and run `npm test` before submitting.

## Commit & Pull Request Guidelines

Use concise messages with conventional prefixes such as `feat:`, `fix:`, or `chore:`; Chinese descriptions are common. Pull requests should explain user-visible behavior, list validation commands, call out version or `dist/` changes, and include screenshots or reproduction steps for UI changes. Link an issue when one exists.

## Security & Configuration Tips

The userscript should click controls provided by the site, not hard-code sign-in endpoints or issue synthetic check-in requests. Never bypass CAPTCHA or login checks, and do not commit credentials or private site data. Review generated bundles and verify metadata before publishing.
