# Contributing

Thank you for improving Fishbowl (Fishbowl).

## Development setup

1. Use Node.js 22 or newer and npm.
2. Clone the repository and run `npm install`.
3. Build with `npm run build`.
4. Before opening a pull request, run:

   ```bash
   npm run typecheck
   npm test
   npm run test:acceptance
   npm run build
   ```

## Contribution rules

- Keep the product local-first. Do not add remote telemetry or background network calls.
- Never add credentials, real user data, raw engineering logs, or private client-project material to the repository or test fixtures.
- Preserve the distinction between evidence, attempts, candidate conclusions, and verified conclusions.
- Add focused tests for behavior changes. Include a regression test for every bug fix when practical.
- Keep pull requests narrowly scoped and explain the user-facing or engineering impact.

## Reporting bugs

Open a GitHub issue with the Fishbowl version, operating system, command invoked, expected behavior, and a redacted error excerpt. Do not attach raw logs unless you have reviewed them for secrets.
