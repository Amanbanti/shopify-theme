// Simple proxy to run the main E2E theme runner and forward CLI args
// Usage examples:
//   npm run test-single -- "dawn" --limit=1 --concurrency=1 --quiet
//   node --loader ts-node/esm test-single-theme.ts "my theme" --limit=1

import "./e2e_theme_runner.ts";