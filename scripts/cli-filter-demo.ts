import { Effect } from "effect";
import { BooleanFilterLive, BooleanFilter } from "../src/server/services/BooleanFilter";

const dsl = process.argv.slice(2).join(" ").trim();
if (!dsl) {
  console.error('Usage: bun run scripts/cli-filter-demo.ts \'is:unread AND label:INBOX\'');
  process.exitCode = 1;
} else {
  const filter = Effect.runSync(
    Effect.gen(function* () {
      return yield* BooleanFilter;
    }).pipe(Effect.provide(BooleanFilterLive)),
  );
  const result = Effect.runSync(Effect.result(filter.parse(dsl)));
  if (result._tag === "Failure") {
    console.error(`${result.failure.message} (at offset ${result.failure.offset})`);
    process.exitCode = 1;
  } else {
    const compiled = filter.compile(result.success);
    console.log(JSON.stringify({ dsl, ast: result.success, sql: compiled.sql, params: compiled.params }, null, 2));
  }
}
