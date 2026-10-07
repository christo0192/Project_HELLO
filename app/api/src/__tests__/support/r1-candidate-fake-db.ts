/**
 * A deliberately small Supabase query double for the R1 candidate-route tests.
 *
 * It implements exactly the builder methods the routes use (`select`, `eq`,
 * `is`, `in`, `order`, `limit`, `update`, `insert`, `maybeSingle`, `single`
 * and awaiting the builder) over in-memory tables, plus `rpc` handlers. It
 * records which tables were touched so a test can assert that R1 never reads
 * or writes the legacy consent tables.
 */

export type Row = Record<string, any>;
export type Tables = Record<string, Row[]>;
export type RpcHandler = (args: any) => unknown | Promise<unknown>;

export interface FakeDbOptions {
  tables: Tables;
  rpc?: Record<string, RpcHandler>;
  /** table -> true when `candidate` would violate a unique index over `existing`. */
  unique?: Record<string, (existing: Row[], candidate: Row) => boolean>;
  /** table -> error returned for every operation on it. */
  failures?: Record<string, { message: string; code?: string }>;
}

export interface FakeDb {
  from: (table: string) => any;
  rpc: (fn: string, args: any) => Promise<{ data: any; error: any }>;
  tables: Tables;
  touched: Set<string>;
  rpcCalls: Array<{ fn: string; args: any }>;
}

export function createFakeDb(options: FakeDbOptions): FakeDb {
  const { tables } = options;
  const touched = new Set<string>();
  const rpcCalls: Array<{ fn: string; args: any }> = [];
  let inserted = 0;

  function query(table: string) {
    touched.add(table);
    let operation: 'select' | 'insert' | 'update' = 'select';
    let payload: Row | Row[] = {};
    const filters: Array<(row: Row) => boolean> = [];
    let orderBy: { column: string; ascending: boolean } | null = null;
    let max = Infinity;

    const run = (): { data: Row[] | null; error: any } => {
      const failure = options.failures?.[table];
      if (failure) return { data: null, error: failure };
      const rows = (tables[table] ??= []);
      if (operation === 'insert') {
        const out: Row[] = [];
        for (const item of Array.isArray(payload) ? payload : [payload]) {
          const row = { ...item };
          if (options.unique?.[table]?.(rows, row)) {
            return { data: null, error: { message: 'duplicate key', code: '23505' } };
          }
          row.id ??= `${table}-${++inserted}`;
          rows.push(row);
          out.push(row);
        }
        return { data: out, error: null };
      }
      let matched = rows.filter((row) => filters.every((filter) => filter(row)));
      if (operation === 'update') {
        for (const row of matched) Object.assign(row, payload);
        return { data: matched, error: null };
      }
      if (orderBy) {
        const { column, ascending } = orderBy;
        matched = [...matched].sort((a, b) => {
          const left = String(a[column] ?? '');
          const right = String(b[column] ?? '');
          return ascending ? left.localeCompare(right) : right.localeCompare(left);
        });
      }
      return { data: matched.slice(0, max), error: null };
    };

    const builder: any = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return builder;
      },
      is: (column: string, value: unknown) => {
        filters.push((row) => (row[column] ?? null) === value);
        return builder;
      },
      in: (column: string, values: unknown[]) => {
        filters.push((row) => values.includes(row[column]));
        return builder;
      },
      order: (column: string, opts?: { ascending?: boolean }) => {
        orderBy = { column, ascending: opts?.ascending ?? true };
        return builder;
      },
      limit: (count: number) => {
        max = count;
        return builder;
      },
      update: (patch: Row) => {
        operation = 'update';
        payload = patch;
        return builder;
      },
      insert: (rows: Row | Row[]) => {
        operation = 'insert';
        payload = rows;
        return builder;
      },
      maybeSingle: async () => {
        const result = run();
        return result.error ? result : { data: result.data?.[0] ?? null, error: null };
      },
      single: async () => {
        const result = run();
        if (result.error) return result;
        return result.data?.[0]
          ? { data: result.data[0], error: null }
          : { data: null, error: { message: 'no rows', code: 'PGRST116' } };
      },
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(run()).then(resolve, reject),
    };
    return builder;
  }

  return {
    from: (table: string) => query(table),
    rpc: async (fn: string, args: any) => {
      rpcCalls.push({ fn, args });
      const handler = options.rpc?.[fn];
      if (!handler) return { data: null, error: { message: `unmocked rpc ${fn}` } };
      return { data: await handler(args), error: null };
    },
    tables,
    touched,
    rpcCalls,
  };
}
