import type {
  KyselyPlugin,
  PluginTransformQueryArgs,
  PluginTransformResultArgs,
  QueryResult,
  RootOperationNode,
  UnknownRow,
} from 'kysely';

/**
 * Counts every statement Kysely *executes* (N+1 guard). Each recorded entry
 * keeps the operation tree so tests can ignore unrelated queries (e.g. auth).
 *
 * `transformQuery` also fires for nested sub-builders (a subquery in FROM)
 * that are never executed on their own, so it only remembers trees by query
 * id; the count happens in `transformResult`, which runs once per execution.
 */
export class QueryCounter implements KyselyPlugin {
  private readonly pending = new Map<unknown, RootOperationNode>();
  private recorded: RootOperationNode[] = [];

  transformQuery({ node, queryId }: PluginTransformQueryArgs): RootOperationNode {
    this.pending.set(queryId, node);
    return node;
  }

  transformResult({
    result,
    queryId,
  }: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    const node = this.pending.get(queryId);
    this.pending.delete(queryId);
    if (node) this.recorded.push(node);
    return Promise.resolve(result);
  }

  reset(): void {
    this.recorded = [];
  }

  /** Number of queries recorded since the last reset, optionally excluding some tables. */
  count(options: { excludingTables?: readonly string[] } = {}): number {
    return this.statements(options).length;
  }

  /**
   * One summary per recorded statement (operation kind + tables touched), so a
   * failing assertion shows *which* extra query ran, not just how many.
   */
  statements({ excludingTables = [] }: { excludingTables?: readonly string[] } = {}): string[] {
    return this.recorded
      .map((node) => {
        const tree = JSON.stringify(node);
        const tables = [
          ...new Set([...tree.matchAll(/"table":\{[^}]*"name":"(\w+)"/g)].map((m) => m[1])),
        ];
        const raw = [...tree.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+(\w+)/gi)].map((m) => m[1]);
        return { tree, summary: `${node.kind}: ${[...new Set([...tables, ...raw])].join(', ')}` };
      })
      .filter(({ tree }) => !excludingTables.some((table) => tree.includes(table)))
      .map(({ summary }) => summary);
  }
}
