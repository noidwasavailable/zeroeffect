import type { FilterExpr } from "./schemas";

// The Boolean filter DSL parser, shared by the server (BooleanFilter) and the browser
// (live validation in the filter builder). It has no Effect dependency so the client
// bundle stays small; BooleanFilter.parse wraps failures in FilterParseError.

export type FilterParseResult =
  | { readonly ok: true; readonly expression: FilterExpr }
  | { readonly ok: false; readonly message: string; readonly offset: number };

class DslSyntaxError extends Error {
  constructor(message: string, readonly offset: number) {
    super(message);
  }
}

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
            throw new DslSyntaxError("A quoted value cannot end with an escape character.", index);
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
      throw new DslSyntaxError("Unclosed quoted value.", quoteStart);
    }
    if (!value) {
      throw new DslSyntaxError("Expected a filter condition.", offset);
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
    throw new DslSyntaxError(message, offset);
  }
}

/** Parses DSL such as `is:unread AND (label:"Label A" OR NOT from:noreply@)`. */
export const parseFilterDsl = (input: string): FilterParseResult => {
  try {
    return { ok: true, expression: new Parser(input, tokenize(input)).parse() };
  } catch (error) {
    if (error instanceof DslSyntaxError) return { ok: false, message: error.message, offset: error.offset };
    return { ok: false, message: String(error), offset: 0 };
  }
};
