import { Context, Effect, Layer } from "effect";
import { FilterParseError } from "../../shared/errors";
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

interface Token {
  readonly value: string;
  readonly offset: number;
}

const isKeyword = (value: string): boolean =>
  value.toUpperCase() === "AND" || value.toUpperCase() === "OR" || value.toUpperCase() === "NOT";

const tokenize = (input: string): ReadonlyArray<Token> => {
  const tokens: Token[] = [];
  let index = 0;

  while (index < input.length) {
    if (/\s/.test(input[index]!)) {
      index += 1;
      continue;
    }

    const offset = index;
    if (input[index] === "(" || input[index] === ")") {
      tokens.push({ value: input[index]!, offset: index });
      index += 1;
      continue;
    }

    let value = "";
    let quoteStart = -1;
    let inQuote = false;
    while (index < input.length) {
      const char = input[index]!;
      if (inQuote) {
        if (char === "\\") {
          const next = input[index + 1];
          if (next === undefined) {
            throw new FilterParseError({
              input,
              message: "A quoted value cannot end with an escape character.",
              offset: index,
            });
          }
          value += next;
          index += 2;
          continue;
        }
        if (char === '"') {
          inQuote = false;
          index += 1;
          continue;
        }
        value += char;
        index += 1;
        continue;
      }

      if (char === '"') {
        inQuote = true;
        quoteStart = index;
        index += 1;
        continue;
      }
      if (/\s/.test(char) || char === "(" || char === ")") break;
      value += char;
      index += 1;
    }

    if (inQuote) {
      throw new FilterParseError({ input, message: "Unclosed quoted value.", offset: quoteStart });
    }
    if (!value) {
      throw new FilterParseError({ input, message: "Expected a filter condition.", offset });
    }
    tokens.push({ value, offset });
  }
  return tokens;
};

class Parser {
  private position = 0;

  constructor(
    private readonly input: string,
    private readonly tokens: ReadonlyArray<Token>,
  ) {}

  parse(): FilterExpr {
    if (this.tokens.length === 0) this.fail("Filter expression cannot be empty.", 0);
    const expression = this.parseOr();
    if (this.position !== this.tokens.length) {
      this.fail(`Unexpected token '${this.current()!.value}'.`, this.current()!.offset);
    }
    return expression;
  }

  private parseOr(): FilterExpr {
    const expressions = [this.parseAnd()];
    while (this.consumeKeyword("OR")) expressions.push(this.parseAnd());
    return expressions.length === 1 ? expressions[0]! : { _tag: "Or", expressions };
  }

  private parseAnd(): FilterExpr {
    const expressions = [this.parseUnary()];
    while (this.consumeKeyword("AND")) expressions.push(this.parseUnary());
    return expressions.length === 1 ? expressions[0]! : { _tag: "And", expressions };
  }

  private parseUnary(): FilterExpr {
    if (this.consumeKeyword("NOT")) return { _tag: "Not", expression: this.parseUnary() };

    if (this.consume("(")) {
      const expression = this.parseOr();
      if (!this.consume(")")) {
        const token = this.current();
        this.fail("Expected ')' to close this group.", token?.offset ?? this.input.length);
      }
      return expression;
    }

    const token = this.current();
    if (!token || token.value === ")" || isKeyword(token.value)) {
      this.fail("Expected a filter condition.", token?.offset ?? this.input.length);
    }
    this.position += 1;
    return this.parseCondition(token);
  }

  private parseCondition(token: Token): FilterExpr {
    const separator = token.value.indexOf(":");
    if (separator <= 0 || separator === token.value.length - 1) {
      this.fail(`Expected field:value, received '${token.value}'.`, token.offset);
    }
    const field = token.value.slice(0, separator).toLowerCase();
    const value = token.value.slice(separator + 1);

    if (field === "is") {
      if (value === "unread" || value === "read" || value === "starred" || value === "archived") {
        return { _tag: "Is", value };
      }
      this.fail(`Unsupported is: value '${value}'.`, token.offset);
    }
    if (field === "label") return { _tag: "Label", value };
    if (field === "from" || field === "subject") return { _tag: "Contains", field, value };
    this.fail(`Unsupported filter field '${field}'.`, token.offset);
  }

  private current(): Token | undefined {
    return this.tokens[this.position];
  }

  private consume(value: string): boolean {
    if (this.current()?.value !== value) return false;
    this.position += 1;
    return true;
  }

  private consumeKeyword(value: "AND" | "OR" | "NOT"): boolean {
    if (this.current()?.value.toUpperCase() !== value) return false;
    this.position += 1;
    return true;
  }

  private fail(message: string, offset: number): never {
    throw new FilterParseError({ input: this.input, message, offset });
  }
}

const parseDsl = (dsl: string): Effect.Effect<FilterExpr, FilterParseError> =>
  Effect.try({
    try: () => new Parser(dsl, tokenize(dsl)).parse(),
    catch: (error) =>
      error instanceof FilterParseError
        ? error
        : new FilterParseError({ input: dsl, message: String(error), offset: 0 }),
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
