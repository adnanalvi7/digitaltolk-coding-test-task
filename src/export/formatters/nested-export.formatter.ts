import { Injectable } from '@nestjs/common';
import { COOPERATIVE_CHUNK_SIZE, yieldToEventLoop } from '../../common/async/yield-to-event-loop';
import { type ExportEntry, ExportFormat, ExportFormatter } from './export-formatter';

interface Branch {
  [segment: string]: Branch | string;
}

const SEPARATOR = '.';

/**
 * Turns dot-notation keys into a tree (`a.b.c` → `{a:{b:{c:…}}}`) in O(total
 * key length), the shape Vue i18n / i18next expect.
 *
 * Collision rule (deterministic and independent of input order): a key that
 * is itself a leaf always owns its path. A deeper key whose path would pass
 * through that leaf is written as a literal dotted key in the deepest object
 * reachable: `{a.b: "x", a.b.c: "y"}` → `{ a: { b: "x", "b.c": "y" } }`.
 * Nothing is dropped and no leaf is ever replaced by an object.
 *
 * Nodes are null-prototype objects, so keys like `__proto__` or `constructor`
 * can never reach Object.prototype. Building and serialising both yield to
 * the event loop between chunks.
 */
@Injectable()
export class NestedExportFormatter extends ExportFormatter {
  readonly format = ExportFormat.Nested;
  readonly contentType = 'application/json; charset=utf-8';

  async render(entries: readonly ExportEntry[]): Promise<string> {
    const root = await this.toTree(entries);
    // Serialise one top-level branch at a time instead of one big stringify.
    const members: string[] = [];
    for (const [segment, child] of Object.entries(root)) {
      members.push(`${JSON.stringify(segment)}:${JSON.stringify(child)}`);
      await yieldToEventLoop();
    }
    return `{${members.join(',')}}`;
  }

  async toTree(entries: readonly ExportEntry[]): Promise<Branch> {
    const leafKeys = new Set(entries.map((entry) => entry.key));
    const root = NestedExportFormatter.branch();
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry) NestedExportFormatter.insert(root, leafKeys, entry);
      if ((index + 1) % COOPERATIVE_CHUNK_SIZE === 0) await yieldToEventLoop();
    }
    return root;
  }

  private static insert(root: Branch, leafKeys: ReadonlySet<string>, entry: ExportEntry): void {
    const segments = entry.key.split(SEPARATOR);
    let node = root;
    let depth = 0;
    let path = '';
    for (; depth < segments.length - 1; depth += 1) {
      const segment = segments[depth] ?? '';
      path = depth === 0 ? segment : `${path}${SEPARATOR}${segment}`;
      if (leafKeys.has(path)) break; // a leaf owns this path; stop descending
      const child = node[segment];
      if (typeof child === 'object') {
        node = child;
      } else {
        const created = NestedExportFormatter.branch();
        node[segment] = created;
        node = created;
      }
    }
    node[segments.slice(depth).join(SEPARATOR)] = entry.value;
  }

  private static branch(): Branch {
    return Object.create(null) as Branch;
  }
}
