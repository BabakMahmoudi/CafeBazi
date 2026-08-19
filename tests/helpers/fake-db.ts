type Tok = string | { col: string; table: string } | { val: unknown };

type Atom =
  | { op: "and"; children: Atom[] }
  | { op: "or"; children: Atom[] }
  | { op: "="; column: string; value: unknown }
  | { op: "!="; column: string; value: unknown }
  | { op: ">"; column: string; value: unknown }
  | { op: ">="; column: string; value: unknown }
  | { op: "<"; column: string; value: unknown }
  | { op: "<="; column: string; value: unknown }
  | { op: "IN"; column: string; values: unknown[] }
  | { op: "ILIKE"; column: string; pattern: string }
  | { op: "ALWAYS"; value: true };

function tokenize(cond: unknown): Tok[] {
  const out: Tok[] = [];
  const TABLE_NAME_KEY = Symbol.for("drizzle:Name") as unknown as PropertyKey;
  const walk = (node: { queryChunks?: unknown[] }) => {
    for (const chunk of node.queryChunks ?? []) {
      const c = chunk as {
        constructor?: { name?: string };
        value?: unknown;
        name?: string;
        table?: Record<PropertyKey, unknown>;
      };
      const ctor = c.constructor?.name;
      if (ctor === "StringChunk") {
        const value = c.value;
        if (Array.isArray(value)) {
          out.push(...(value as string[]));
        } else {
          out.push(value as string);
        }
      } else if (typeof chunk === "string") {
        out.push({ val: chunk });
      } else if (ctor === "Param") {
        out.push({ val: c.value });
      } else if (chunk instanceof Date) {
        out.push({ val: chunk });
      } else if (Array.isArray(chunk)) {
        out.push("(");
        for (const item of chunk) {
          walk({ queryChunks: [item] });
        }
        out.push(")");
      } else if (ctor === "SQL") {
        walk(chunk as { queryChunks?: unknown[] });
      } else if (c && typeof c.name === "string" && c.table) {
        const tableObj = c.table;
        let jsKey = c.name;
        for (const key of Object.keys(tableObj)) {
          if (tableObj[key] === chunk) {
            jsKey = key;
            break;
          }
        }
        out.push({
          col: jsKey,
          table: tableObj[TABLE_NAME_KEY] as string,
        });
      }
    }
  };
  walk(cond as { queryChunks?: unknown[] });
  return out;
}

function isWrapped(tokens: Tok[]): boolean {
  if (tokens.length < 2 || tokens[0] !== "(" || tokens[tokens.length - 1] !== ")") {
    return false;
  }
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === "(") depth += 1;
    else if (tok === ")") depth -= 1;
    if (depth === 0 && i !== tokens.length - 1) {
      return false;
    }
    if (depth < 0) {
      return false;
    }
  }
  return depth === 0;
}

function normalizeOp(raw: string): string {
  const op = raw.replace(/\s+/g, " ").trim();
  if (/IN/i.test(op)) return "IN";
  if (/ILIKE/i.test(op)) return "ILIKE";
  if (op.includes(">=")) return ">=";
  if (op.includes("<=")) return "<=";
  if (op.includes("<>")) return "!=";
  if (op.includes("!=")) return "!=";
  if (op.includes(">")) return ">";
  if (op.includes("<")) return "<";
  if (op.includes("=")) return "=";
  return "";
}

function parseAtoms(tokens: Tok[]): Atom {
  const meaningful = tokens.filter(
    (t): t is Tok => !(typeof t === "string" && t.trim() === ""),
  );

  if (meaningful.length === 0) {
    return { op: "ALWAYS", value: true };
  }

  if (isWrapped(meaningful)) {
    return parseAtoms(meaningful.slice(1, -1));
  }

  let depth = 0;
  for (let i = 0; i < meaningful.length; i++) {
    const tok = meaningful[i];
    const keyword = typeof tok === "string" ? tok.trim().toLowerCase() : "";
    if (tok === "(") depth += 1;
    else if (tok === ")") depth -= 1;
    else if (depth === 0 && (keyword === "and" || keyword === "or")) {
      const connector = keyword as "and" | "or";
      const left = parseAtoms(meaningful.slice(0, i));
      const right = parseAtoms(meaningful.slice(i + 1));
      return { op: connector === "and" ? "and" : "or", children: [left, right] };
    }
  }

  const colTok = meaningful.find(
    (t): t is { col: string; table: string } => typeof t !== "string" && "col" in t,
  );
  const valToks = meaningful.filter(
    (t): t is { val: unknown } => typeof t !== "string" && "val" in t,
  );
  const opString = meaningful.filter((t) => typeof t === "string").join(" ");
  const op = normalizeOp(opString);

  if (!colTok) {
    return { op: "ALWAYS", value: true };
  }

  if (op === "IN") {
    return { op, column: colTok.col, values: valToks.map((t) => t.val) };
  }
  if (op === "ILIKE") {
    const pattern = String(valToks[0]?.val ?? "");
    return { op, column: colTok.col, pattern: pattern.replace(/%/g, "") };
  }
  if (op === "=" || op === "!=" || op === ">" || op === ">=" || op === "<" || op === "<=") {
    return { op, column: colTok.col, value: valToks[0]?.val };
  }
  return { op: "ALWAYS", value: true };
}

function toComparable(value: unknown): number | bigint | string | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "bigint") return value;
  const n = Number(value);
  if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(n)) {
    return n;
  }
  return value as string | null;
}

function compare(a: unknown, b: unknown): number {
  const ca = toComparable(a);
  const cb = toComparable(b);
  if (ca === null || cb === null) return ca === cb ? 0 : -1;
  if (typeof ca === "bigint" || typeof cb === "bigint") {
    const la = BigInt(String(ca ?? 0));
    const lb = BigInt(String(cb ?? 0));
    return la < lb ? -1 : la > lb ? 1 : 0;
  }
  if (typeof ca === "number" || typeof cb === "number") {
    return Number(ca) < Number(cb) ? -1 : Number(ca) > Number(cb) ? 1 : 0;
  }
  return String(ca).localeCompare(String(cb));
}

function looseEquals(actual: unknown, expected: unknown): boolean {
  if (actual instanceof Date || expected instanceof Date) {
    const a = actual instanceof Date ? actual.getTime() : new Date(actual as string).getTime();
    const b = expected instanceof Date ? expected.getTime() : new Date(expected as string).getTime();
    return a === b;
  }
  if (typeof expected === "boolean") {
    return actual === expected;
  }
  if (typeof actual === "bigint" || typeof expected === "bigint") {
    return String(actual) === String(expected);
  }
  if (typeof actual === "number" || typeof expected === "number") {
    return Number(actual) === Number(expected);
  }
  return String(actual) === String(expected);
}

function matches(row: Record<string, unknown>, atom: Atom): boolean {
  switch (atom.op) {
    case "and":
      return atom.children.every((child) => matches(row, child));
    case "or":
      return atom.children.some((child) => matches(row, child));
    case "ALWAYS":
      return true;
    case "=":
      return looseEquals(row[atom.column], atom.value);
    case "!=":
      return !looseEquals(row[atom.column], atom.value);
    case ">":
      return compare(row[atom.column], atom.value) > 0;
    case ">=":
      return compare(row[atom.column], atom.value) >= 0;
    case "<":
      return compare(row[atom.column], atom.value) < 0;
    case "<=":
      return compare(row[atom.column], atom.value) <= 0;
    case "IN":
      return atom.values.some((value) => looseEquals(row[atom.column], value));
    case "ILIKE": {
      const actual = String(row[atom.column] ?? "");
      return actual.toLowerCase().includes(atom.pattern.toLowerCase());
    }
  }
}

function buildPredicate(cond: unknown): (row: Record<string, unknown>) => boolean {
  const atom = parseAtoms(tokenize(cond));
  return (row) => matches(row, atom);
}

class ResultSet<T> extends Array<T> {
  limit(n: number): ResultSet<T> {
    return new ResultSet(...this.slice(0, n));
  }

  orderBy(_cols?: unknown[]): ResultSet<T> {
    return this;
  }
}

export type FakeDbOptions = {
  unique?: Record<string, string[]>;
};

export function createFakeDb(
  seed?: Record<string, Array<Record<string, unknown>>>,
  options: FakeDbOptions = {},
) {
  const store = new Map<string, Record<string, unknown>[]>();
  for (const [table, rows] of Object.entries(seed ?? {})) {
    store.set(table, rows.map((row) => ({ ...row })));
  }

  const TABLE_NAME_KEY = Symbol.for("drizzle:Name") as unknown as PropertyKey;
  const tableName = (table: unknown) =>
    (table as Record<PropertyKey, unknown>)[TABLE_NAME_KEY] as string;

  const applyWhere = (table: unknown, cond: unknown) => {
    const rows = store.get(tableName(table)) ?? [];
    if (!cond) {
      return rows.map((row) => ({ ...row }));
    }
    const predicate = buildPredicate(cond);
    return rows.filter((row) => predicate(row)).map((row) => ({ ...row }));
  };

  const checkUnique = (table: string, row: Record<string, unknown>) => {
    for (const [column, value] of Object.entries(row)) {
      const uniqueColumns = options.unique?.[table];
      if (uniqueColumns?.includes(column) && value !== undefined) {
        const conflict = (store.get(table) ?? []).some(
          (existing) => looseEquals(existing[column], value),
        );
        if (conflict) {
          throw new Error(`duplicate key value violates unique constraint "${table}_${column}"`);
        }
      }
    }
  };

  const checkUniqueUpdate = (
    table: string,
    patch: Record<string, unknown>,
    matched: Array<Record<string, unknown>>,
  ) => {
    const uniqueColumns = options.unique?.[table] ?? [];
    const matchedSet = new Set(matched);
    const others = (store.get(table) ?? []).filter((row) => !matchedSet.has(row));
    for (const [column, value] of Object.entries(patch)) {
      if (uniqueColumns.includes(column) && value !== undefined) {
        const conflict = others.some((existing) => looseEquals(existing[column], value));
        if (conflict) {
          throw new Error(`duplicate key value violates unique constraint "${table}_${column}"`);
        }
      }
    }
  };

  return {
    tables: () => {
      const snapshot: Record<string, Array<Record<string, unknown>>> = {};
      for (const [name, rows] of store.entries()) {
        snapshot[name] = rows.map((row) => ({ ...row }));
      }
      return snapshot;
    },
    select: () => ({
      from: (table: unknown) => ({
        where: (cond: unknown) => new ResultSet(...applyWhere(table, cond)),
      }),
    }),
    insert: (table: unknown) => ({
      values: (value: Record<string, unknown>) => {
        const execute = () => {
          const name = tableName(table);
          const row = { ...value };
          if (!row.id) {
            row.id = `fake-${Math.random().toString(36).slice(2, 10)}`;
          }
          if (!store.has(name)) {
            store.set(name, []);
          }
          checkUnique(name, row);
          store.get(name)!.push(row);
          return [{ ...row }];
        };
        return {
          returning: () => execute(),
          then: (resolve: (value: unknown) => void, reject: (reason: unknown) => void) =>
            Promise.resolve(execute()).then(resolve, reject),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (cond: unknown) => {
          const execute = () => {
            const name = tableName(table);
            const rows = store.get(name) ?? [];
            const matched = rows.filter((row) =>
              cond ? buildPredicate(cond)(row) : true,
            );
            checkUniqueUpdate(name, patch, matched);
            for (const row of matched) {
              Object.assign(row, patch);
            }
            return matched.map((row) => ({ ...row }));
          };
          return {
            returning: () => execute(),
            then: (resolve: (value: unknown) => void, reject: (reason: unknown) => void) =>
              Promise.resolve(execute()).then(resolve, reject),
          };
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: () => ({
        returning: () => {
          const name = tableName(table);
          store.set(name, []);
          return [];
        },
      }),
    }),
  };
}
