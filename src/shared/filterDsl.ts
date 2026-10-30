import type { FilterExpr } from "./schemas";

// Values containing DSL syntax (whitespace, parentheses, quotes, escapes) must be quoted.
const needsQuotes = (value: string): boolean => value === "" || /[\s()"\\]/.test(value);

const formatValue = (value: string): string =>
  needsQuotes(value) ? `"${value.replace(/[\\"]/g, "\\$&")}"` : value;

const precedence = (expression: FilterExpr): number =>
  expression._tag === "Or" ? 0 : expression._tag === "And" ? 1 : 2;

const formatChild = (expression: FilterExpr, parentPrecedence: number): string => {
  const formatted = formatFilterExpr(expression);
  return precedence(expression) < parentPrecedence ? `(${formatted})` : formatted;
};

/**
 * Prints a FilterExpr as DSL text that BooleanFilter.parse reads back to an equivalent AST.
 * Empty condition values and empty groups have no DSL form; editors must not produce them.
 */
export const formatFilterExpr = (expression: FilterExpr): string => {
  switch (expression._tag) {
    case "Or":
    case "And": {
      if (expression.expressions.length === 1) return formatFilterExpr(expression.expressions[0]!);
      // Nested groups are always parenthesized: precedence alone (AND before OR) is easy to misread,
      // and same-operator groups keep their shape in the builder.
      return expression.expressions.map((child) => formatChild(child, 2)).join(` ${expression._tag.toUpperCase()} `);
    }
    case "Not":
      return `NOT ${formatChild(expression.expression, 2)}`;
    case "Is":
      return `is:${expression.value}`;
    case "Label":
      return `label:${formatValue(expression.value)}`;
    case "Contains":
      return `${expression.field}:${formatValue(expression.value)}`;
  }
};

/** Rewrites label conditions for renamed labels. Label matching is case-insensitive, so renames are too. */
export const renameFilterLabels = (expression: FilterExpr, renames: ReadonlyMap<string, string>): FilterExpr => {
  switch (expression._tag) {
    case "And":
    case "Or":
      return { _tag: expression._tag, expressions: expression.expressions.map((child) => renameFilterLabels(child, renames)) };
    case "Not":
      return { _tag: "Not", expression: renameFilterLabels(expression.expression, renames) };
    case "Label": {
      const renamed = renames.get(expression.value.toLowerCase());
      return renamed === undefined ? expression : { _tag: "Label", value: renamed };
    }
    default:
      return expression;
  }
};
