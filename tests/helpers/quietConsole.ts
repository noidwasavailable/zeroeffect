// Test preload: the services under test log expected failures (rate limits, retries,
// malformed notifications) to the console. Silence them unless TEST_LOGS=1 is set.
if (!process.env.TEST_LOGS) {
  const noop = () => {};
  for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    console[method] = noop;
  }
}
