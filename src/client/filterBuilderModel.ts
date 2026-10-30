import type { FilterExpr } from "../shared/schemas";

// The visual filter builder edits a tree of groups and conditions. NOT is a flag on any node,
// so `NOT (a OR b)` is a negated Or group. Converting to and from FilterExpr keeps the builder
// and the DSL text box editing the same AST.

export type ConditionField = "is" | "label" | "from" | "subject";
export const IS_VALUES = ["unread", "read", "starred", "archived"] as const;

export interface BuilderCondition {
  readonly kind: "condition";
  readonly id: string;
  readonly negated: boolean;
  readonly field: ConditionField;
  readonly value: string;
}

export interface BuilderGroup {
  readonly kind: "group";
  readonly id: string;
  readonly negated: boolean;
  readonly operator: "And" | "Or";
  readonly children: ReadonlyArray<BuilderNode>;
}

export type BuilderNode = BuilderCondition | BuilderGroup;

let lastId = 0;
const nextId = () => `node-${++lastId}`;

export const newCondition = (field: ConditionField = "label"): BuilderCondition =>
  ({ kind: "condition", id: nextId(), negated: false, field, value: field === "is" ? "unread" : "" });

export const newGroup = (operator: "And" | "Or" = "Or"): BuilderGroup =>
  ({ kind: "group", id: nextId(), negated: false, operator, children: [newCondition()] });

const convert = (expression: FilterExpr, negated: boolean): BuilderNode => {
  switch (expression._tag) {
    case "Not":
      return convert(expression.expression, !negated);
    case "And":
    case "Or":
      return {
        kind: "group", id: nextId(), negated, operator: expression._tag,
        children: expression.expressions.map((child) => convert(child, false)),
      };
    case "Is":
      return { kind: "condition", id: nextId(), negated, field: "is", value: expression.value };
    case "Label":
      return { kind: "condition", id: nextId(), negated, field: "label", value: expression.value };
    case "Contains":
      return { kind: "condition", id: nextId(), negated, field: expression.field, value: expression.value };
  }
};

/** The builder always edits a root group; a lone condition (or no filter) becomes a one- (or zero-) child AND group. */
export const toBuilder = (expression: FilterExpr | null): BuilderGroup => {
  const node = expression ? convert(expression, false) : null;
  if (node?.kind === "group") return node;
  return { kind: "group", id: nextId(), negated: false, operator: "And", children: node ? [node] : [] };
};

export type BuildResult =
  | { readonly ok: true; readonly expression: FilterExpr | null }
  | { readonly ok: false; readonly nodeId: string; readonly error: string };

class IncompleteNode extends Error {
  constructor(readonly nodeId: string, message: string) {
    super(message);
  }
}

const build = (node: BuilderNode): FilterExpr => {
  let expression: FilterExpr;
  if (node.kind === "condition") {
    const value = node.value.trim();
    if (node.field === "is") {
      if (!IS_VALUES.some((candidate) => candidate === value)) throw new IncompleteNode(node.id, "Choose a state.");
      expression = { _tag: "Is", value: value as (typeof IS_VALUES)[number] };
    } else if (!value) {
      // Empty values have no DSL form, so incomplete conditions block the conversion.
      throw new IncompleteNode(node.id, "Enter a value.");
    } else {
      expression = node.field === "label" ? { _tag: "Label", value } : { _tag: "Contains", field: node.field, value };
    }
  } else {
    if (node.children.length === 0) throw new IncompleteNode(node.id, "Add a condition to this group.");
    const children = node.children.map(build);
    expression = children.length === 1 ? children[0]! : { _tag: node.operator, expressions: children };
  }
  return node.negated ? { _tag: "Not", expression } : expression;
};

/** Converts the builder tree back to an AST. An empty root group means "no filter". */
export const fromBuilder = (root: BuilderGroup): BuildResult => {
  if (root.children.length === 0 && !root.negated) return { ok: true, expression: null };
  try {
    return { ok: true, expression: build(root) };
  } catch (error) {
    if (error instanceof IncompleteNode) return { ok: false, nodeId: error.nodeId, error: error.message };
    throw error;
  }
};

const mapTree = (node: BuilderNode, visit: (node: BuilderNode) => BuilderNode | null): BuilderNode | null => {
  const visited = visit(node);
  if (!visited || visited.kind === "condition") return visited;
  return {
    ...visited,
    children: visited.children
      .map((child) => mapTree(child, visit))
      .filter((child): child is BuilderNode => child !== null),
  };
};

export const updateNode = (root: BuilderGroup, id: string, update: (node: BuilderNode) => BuilderNode): BuilderGroup =>
  mapTree(root, (node) => node.id === id ? update(node) : node) as BuilderGroup;

/** Removes a node anywhere below the root (the root itself cannot be removed). */
export const removeNode = (root: BuilderGroup, id: string): BuilderGroup =>
  mapTree(root, (node) => node.id === id && node !== root ? null : node) as BuilderGroup;

export const appendChild = (root: BuilderGroup, groupId: string, child: BuilderNode): BuilderGroup =>
  updateNode(root, groupId, (node) => node.kind === "group" ? { ...node, children: [...node.children, child] } : node);
