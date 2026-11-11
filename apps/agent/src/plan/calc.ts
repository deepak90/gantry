/**
 * Exact arithmetic for the assistant, so it never does sums in its head: decimals to 64 digits (0.1 + 0.2 is 0.3),
 * percentages ("15% * 2400"), rounding, powers, square roots, logs and the sum, mean, median, min and max of some
 * figures. Named values carry numbers a tool returned ("forecast - budget"). Only numbers come back.
 *
 * Only plain arithmetic runs, whatever the expression asks for. It is read with mathjs's parser, kept private to this
 * module before the instance's own parse, evaluate and the rest are switched off, and the tree is checked whole before
 * anything is worked out. Allowed: number literals up to a trillion, the named values (up to a trillion too),
 * + - * / ^ %, a minus sign, brackets, and round, abs, min, max, sum, mean, median, sqrt and log; a list in square
 * brackets only as the one thing sum, mean, median, min or max takes. Anything else (matrices, ranges, factorials,
 * gamma, combinations, assignments, new functions, units, text, comparisons) is refused in plain words the assistant
 * can pass on. The tree is then worked out here, one mathjs operation on 64-digit decimals at a time, so no matrix is
 * ever built: each operation is small and bounded, the clock is read after every one and the working stops at 200 ms,
 * and a result of 1e15 or more (16 digits) is refused before it is written out.
 */
import { all, create, type BigNumber, type FactoryFunctionMap } from 'mathjs';

const math = create(all as FactoryFunctionMap, { number: 'BigNumber', precision: 64 });
/** mathjs's parser, for this module alone: the instance's own one is switched off with the rest just below. */
const parse = math.parse;
const disabled = (name: string) => () => {
  throw new Error(`${name} is not available`);
};
math.import(
  Object.fromEntries(['import', 'createUnit', 'reviver', 'evaluate', 'parse', 'simplify', 'derivative', 'resolve', 'compile', 'parser'].map((name) => [name, disabled(name)])),
  { override: true },
);

export const MAX_EXPRESSION = 400;
/** The biggest number a literal or a named value may be: a trillion. */
export const MAX_NUMBER = 1e12;
/** A result this big or bigger is refused: no figure on the project has 16 digits. */
export const MAX_RESULT = 1e15;
/** How long one expression may take to work out. */
export const TIME_BUDGET_MS = 200;
/** Names a value may have: letters, digits and underscores, starting with a letter. */
const VALUE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/** What may be worked out, in the words of a refusal. */
const ALLOWED = 'plain arithmetic on the project’s figures (+ - * / ^ %, brackets, round, abs, min, max, sum, mean, median, sqrt and log)';
const LIST_FUNCTIONS = new Set(['sum', 'mean', 'median', 'min', 'max']);
/** Each function and how many figures it takes. */
const ARITY: Record<string, [number, number]> = { round: [1, 2], abs: [1, 1], sqrt: [1, 1], log: [1, 2], sum: [1, 200], mean: [1, 200], median: [1, 200], min: [1, 200], max: [1, 200] };
const OPERATORS = new Set(['add', 'subtract', 'multiply', 'divide', 'pow', 'mod', 'unaryMinus', 'unaryPlus']);
/** What the parts of an expression that are refused are called. */
const REFUSED_NODES: Record<string, string> = {
  RangeNode: 'ranges (a:b)',
  AssignmentNode: 'assignments',
  FunctionAssignmentNode: 'new functions',
  BlockNode: 'more than one expression',
  ConditionalNode: 'conditions (a ? b : c)',
  RelationalNode: 'comparisons',
  IndexNode: 'picking from a list or table',
  AccessorNode: 'picking from a list or table',
  ObjectNode: 'objects',
  ArrayNode: 'lists in [ ] other than the one sum, mean, median, min or max takes, or tables (matrices)',
};
const REFUSED_OPERATORS: Record<string, string> = {
  factorial: 'factorials (!)',
  ctranspose: 'transposes',
  transpose: 'transposes',
  dotMultiply: 'element-wise math',
  dotDivide: 'element-wise math',
  dotPow: 'element-wise math',
  to: 'unit conversions',
  equal: 'comparisons',
  unequal: 'comparisons',
  larger: 'comparisons',
  largerEq: 'comparisons',
  smaller: 'comparisons',
  smallerEq: 'comparisons',
  and: 'logic (and, or, not)',
  or: 'logic (and, or, not)',
  xor: 'logic (and, or, not)',
  not: 'logic (and, or, not)',
};

export class CalcError extends Error {}

export interface CalcResult {
  expression: string;
  /** The value, exact to 10 decimal places (trailing zeros dropped), e.g. "8.3333333333". */
  value: string;
  /** Rounded half away from zero to `decimals` places, e.g. "8.33". */
  rounded: string;
  decimals: number;
}

/** The parts of mathjs's tree read here (told apart by `type`). */
interface Node {
  type: string;
  toString(): string;
}
interface ConstantNode extends Node {
  value: unknown;
}
interface SymbolNode extends Node {
  name: string;
}
interface OperatorNode extends Node {
  op: string;
  fn: string;
  args: Node[];
}
interface FunctionNode extends Node {
  fn: Node;
  args: Node[];
}
interface ParenthesisNode extends Node {
  content: Node;
}
interface ArrayNode extends Node {
  items: Node[];
}

const notAllowed = (what: string) => new CalcError(`That isn’t a calculation I do: I only work out ${ALLOWED}, not ${what}.`);
const tooBig = (what: string) => new CalcError(`Figures in a calculation go up to 1,000,000,000,000 (a trillion), and ${what} is bigger than that.`);
const shortly = (node: Node) => {
  const text = node.toString();
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
};

/** "1,200.50" or "$600" -> "1200.50", "600": numbers may be given the way people write them. */
function cleanNumber(text: string): string {
  return text.replace(/(?<=\d),(?=\d{3}\b)/g, '').replace(/\$(?=\s?\d)/g, '');
}

/** A number literal as a 64-digit decimal: a number up to a trillion, and nothing else. */
function literal(node: ConstantNode): BigNumber {
  const { value } = node;
  const number = math.isBigNumber(value) ? value : typeof value === 'number' && Number.isFinite(value) ? math.bignumber(value) : null;
  if (!number) throw notAllowed(typeof value === 'string' ? 'words or text' : typeof value === 'boolean' ? 'true or false' : `"${shortly(node)}"`);
  if (!number.isFinite() || number.abs().gt(MAX_NUMBER)) throw tooBig(shortly(node));
  return number;
}

/** The figures a call works on: its arguments, or the items of the one list a list function was given. */
function figuresOf(name: string, call: FunctionNode): Node[] {
  const only = call.args.length === 1 ? call.args[0]! : null;
  return LIST_FUNCTIONS.has(name) && only?.type === 'ArrayNode' ? (only as ArrayNode).items : call.args;
}

/** The whole tree is checked before anything is worked out: whatever isn't plain arithmetic is refused here. */
function check(node: Node, names: ReadonlySet<string>): void {
  switch (node.type) {
    case 'ConstantNode':
      literal(node as ConstantNode);
      return;
    case 'SymbolNode': {
      const { name } = node as SymbolNode;
      if (!names.has(name)) throw new CalcError(`There is no figure called "${name}" here: pass each figure the tools gave in values.`);
      return;
    }
    case 'ParenthesisNode':
      check((node as ParenthesisNode).content, names);
      return;
    case 'OperatorNode': {
      const operator = node as OperatorNode;
      if (!OPERATORS.has(operator.fn)) throw notAllowed(REFUSED_OPERATORS[operator.fn] ?? `"${operator.op}"`);
      for (const arg of operator.args) check(arg, names);
      return;
    }
    case 'FunctionNode': {
      const call = node as FunctionNode;
      const name = call.fn.type === 'SymbolNode' ? (call.fn as SymbolNode).name : null;
      if (!name || !Object.hasOwn(ARITY, name)) throw notAllowed(name ? `${name}()` : `"${shortly(call)}"`);
      // A list's items are figures, never another list: a table is refused where the item is checked.
      const figures = figuresOf(name, call);
      const [least, most] = ARITY[name]!;
      if (figures.length < least || figures.length > most) throw new CalcError(`${name}() takes ${least === most ? `${least} figure` : `${least} to ${most} figures`}, not ${figures.length}.`);
      for (const figure of figures) check(figure, names);
      return;
    }
    default:
      throw notAllowed(REFUSED_NODES[node.type] ?? `"${shortly(node)}"`);
  }
}

/** One operation's answer: a real, finite 64-digit decimal, reached within the time budget. */
function settled(value: unknown, deadline: number, expression: string): BigNumber {
  if (!math.isBigNumber(value)) throw new CalcError(`"${expression}" has no answer in real numbers (a square root or log of a negative number?)`);
  if (!value.isFinite()) throw new CalcError(`"${expression}" has no finite value (a division by zero, or a number far too big?)`);
  if (performance.now() > deadline) throw new CalcError('That took too long to work out, so I stopped.');
  return value;
}

/** Works out a checked tree, one mathjs operation at a time. */
function work(node: Node, values: ReadonlyMap<string, BigNumber>, deadline: number, expression: string): BigNumber {
  const next = (child: Node) => work(child, values, deadline, expression);
  const done = (value: unknown) => settled(value, deadline, expression);
  switch (node.type) {
    case 'ConstantNode':
      return literal(node as ConstantNode);
    case 'SymbolNode':
      return values.get((node as SymbolNode).name)!;
    case 'ParenthesisNode':
      return next((node as ParenthesisNode).content);
    case 'OperatorNode': {
      const { fn, args } = node as OperatorNode;
      const a = next(args[0]!);
      if (fn === 'unaryPlus') return a;
      if (fn === 'unaryMinus') return done(math.unaryMinus(a));
      const b = next(args[1]!);
      switch (fn) {
        case 'add':
          return done(math.add(a, b));
        case 'subtract':
          return done(math.subtract(a, b));
        case 'multiply':
          return done(math.multiply(a, b));
        case 'divide':
          return done(math.divide(a, b));
        case 'pow':
          return done(math.pow(a, b));
        case 'mod':
          return done(math.mod(a, b));
      }
      throw notAllowed(`"${shortly(node)}"`);
    }
    case 'FunctionNode': {
      const call = node as FunctionNode;
      const name = (call.fn as SymbolNode).name;
      const figures = figuresOf(name, call).map(next);
      const [x, y] = figures as [BigNumber, BigNumber | undefined];
      switch (name) {
        case 'round':
          if (y && (!y.isInteger() || y.lt(0) || y.gt(10))) throw new CalcError('round(x, n) rounds to n places, a whole number from 0 to 10.');
          return done(y ? math.round(x, y) : math.round(x));
        case 'abs':
          return done(math.abs(x));
        case 'sqrt':
          return done(math.sqrt(x));
        case 'log':
          return done(y ? math.log(x, y) : math.log(x));
        // The figures go in one by one, never as a list, so mathjs builds no matrix.
        case 'sum':
          return done(math.sum(...figures));
        case 'mean':
          return done(math.mean(...figures));
        case 'median':
          return done(math.median(...figures));
        case 'min':
          return done(math.min(...figures));
        case 'max':
          return done(math.max(...figures));
      }
      throw notAllowed(`${name}()`);
    }
    default:
      throw notAllowed(`"${shortly(node)}"`);
  }
}

export function calculate(expression: string, values: Readonly<Record<string, number | string>> = {}, decimals = 2): CalcResult {
  const deadline = performance.now() + TIME_BUDGET_MS;
  const text = cleanNumber(expression.trim());
  if (!text) throw new CalcError('Give an expression, e.g. "(5200 - 4800) / 4800 * 100"');
  if (text.length > MAX_EXPRESSION) throw new CalcError(`An expression is at most ${MAX_EXPRESSION} characters`);
  if (/[=;]/.test(text.replace(/[<>!=]=/g, ''))) throw new CalcError('Use one expression without assignments; pass named numbers in values');
  const scope = new Map<string, BigNumber>();
  for (const [name, raw] of Object.entries(values)) {
    if (!VALUE_NAME.test(name)) throw new CalcError(`"${name}" cannot name a value (letters, digits and _ only)`);
    const number = typeof raw === 'number' ? raw : Number(cleanNumber(String(raw)));
    if (!Number.isFinite(number)) throw new CalcError(`${name} is not a number`);
    const big = math.bignumber(typeof raw === 'number' ? raw : cleanNumber(String(raw)));
    if (!big.isFinite() || big.abs().gt(MAX_NUMBER)) throw tooBig(name);
    scope.set(name, big);
  }
  let tree: Node;
  try {
    tree = parse(text) as unknown as Node;
  } catch (error) {
    throw new CalcError(`Could not work out "${expression}": ${error instanceof Error ? error.message : String(error)}`);
  }
  check(tree, new Set(scope.keys()));
  let result: BigNumber;
  try {
    result = work(tree, scope, deadline, expression);
  } catch (error) {
    if (error instanceof CalcError) throw error;
    throw new CalcError(`Could not work out "${expression}": ${error instanceof Error ? error.message : String(error)}`);
  }
  if (result.abs().gte(MAX_RESULT)) throw new CalcError('That comes to a number of 16 digits or more, bigger than any figure on this project, so I didn’t work it out.');
  const places = Math.min(10, Math.max(0, Math.trunc(decimals)));
  return {
    expression: text,
    value: trimZeros(result.toDecimalPlaces(10, 4).toFixed(10)),
    rounded: result.toDecimalPlaces(places, 4).toFixed(places),
    decimals: places,
  };
}

function trimZeros(fixed: string): string {
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
}
