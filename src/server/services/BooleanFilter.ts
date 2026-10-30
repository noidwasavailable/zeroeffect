import { Context, Effect, Layer } from "effect";
import { FilterParseError } from "../../shared/errors";
import { parseFilterDsl } from "../../shared/filterParser";
import type { FilterExpr, FilterThread } from "../../shared/schemas";

export interface CompiledFilter {
  readonly sql: string;
  readonly params: ReadonlyArray<string | number>;
}

export interface BooleanFilterService {
  readonly parse: (dsl: string) => Effect.Effect<FilterExpr, FilterParseError>;
  readonly compile: (expression: FilterExpr) => CompiledFilter;
  readonly evaluate: (expression: FilterExpr, thread: FilterThread) => boolean;
}

export class BooleanFilter extends Context.Service<BooleanFilter, BooleanFilterService>()(
  "zeroeffect/BooleanFilter",
) {}

const parseDsl = (dsl: string): Effect.Effect<FilterExpr, FilterParseError> =>
  Effect.suspend(() => {
    const result = parseFilterDsl(dsl);
    return result.ok
      ? Effect.succeed(result.expression)
      : Effect.fail(new FilterParseError({ input: dsl, message: result.message, offset: result.offset }));
  });

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, "\\$&");

const compileExpression = (expression: FilterExpr): CompiledFilter => {
  switch (expression._tag) {
    case "And":
    case "Or": {
      const operator = expression._tag === "And" ? " AND " : " OR ";
      const compiled = expression.expressions.map(compileExpression);
      return {
        sql: `(${compiled.map((item) => item.sql).join(operator)})`,
        params: compiled.flatMap((item) => item.params),
      };
    }
    case "Not": {
      const compiled = compileExpression(expression.expression);
      return { sql: `(NOT ${compiled.sql})`, params: compiled.params };
    }
    case "Is": {
      const column = expression.value === "unread" || expression.value === "read"
        ? "is_unread"
        : expression.value === "starred"
          ? "is_starred"
          : "is_archived";
      const expected = expression.value === "read" ? 0 : 1;
      return { sql: `(threads.${column} = ${expected})`, params: [] };
    }
    case "Label":
      return {
        sql: "EXISTS (SELECT 1 FROM json_each(threads.labels_json) WHERE lower(json_each.value) = lower(?))",
        params: [expression.value],
      };
    case "Contains": {
      const column = expression.field === "from" ? "sender_summary" : "subject";
      return {
        sql: `(lower(threads.${column}) LIKE lower(?) ESCAPE '\\')`,
        params: [`%${escapeLike(expression.value)}%`],
      };
    }
  }
};

const evaluateExpression = (expression: FilterExpr, thread: FilterThread): boolean => {
  switch (expression._tag) {
    case "And":
      return expression.expressions.every((child) => evaluateExpression(child, thread));
    case "Or":
      return expression.expressions.some((child) => evaluateExpression(child, thread));
    case "Not":
      return !evaluateExpression(expression.expression, thread);
    case "Is":
      switch (expression.value) {
        case "unread": return thread.isUnread;
        case "read": return !thread.isUnread;
        case "starred": return thread.isStarred;
        case "archived": return thread.isArchived;
      }
    case "Label":
      return thread.labels.some((label) => label.toLowerCase() === expression.value.toLowerCase());
    case "Contains": {
      const source = expression.field === "from" ? thread.senderSummary : thread.subject;
      return source.toLowerCase().includes(expression.value.toLowerCase());
    }
  }
};

const service: BooleanFilterService = {
  parse: parseDsl,
  compile: compileExpression,
  evaluate: evaluateExpression,
};

export const BooleanFilterLive: Layer.Layer<BooleanFilter> = Layer.succeed(BooleanFilter, service);
export const BooleanFilterTest: Layer.Layer<BooleanFilter> = BooleanFilterLive;
