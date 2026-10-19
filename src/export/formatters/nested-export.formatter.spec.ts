import { ExportFormat } from './export-formatter';
import { ExportFormatterRegistry } from './export-formatter.registry';
import { FlatExportFormatter } from './flat-export.formatter';
import { NestedExportFormatter } from './nested-export.formatter';

const nested = new NestedExportFormatter();
const render = async (entries: [string, string][]): Promise<unknown> =>
  JSON.parse(await nested.render(entries.map(([key, value]) => ({ key, value }))));

describe('NestedExportFormatter', () => {
  it('returns an empty object for empty input', async () => {
    expect(await nested.render([])).toBe('{}');
  });

  it('builds a tree from dot-notation keys', async () => {
    expect(
      await render([
        ['checkout.button.pay', 'Pay'],
        ['checkout.button.cancel', 'Cancel'],
        ['checkout.title', 'Checkout'],
        ['home', 'Home'],
      ]),
    ).toEqual({
      checkout: { button: { pay: 'Pay', cancel: 'Cancel' }, title: 'Checkout' },
      home: 'Home',
    });
  });

  it('keeps the leaf and writes the deeper key literally when a leaf is also a prefix', async () => {
    expect(
      await render([
        ['a.b', 'x'],
        ['a.b.c', 'y'],
      ]),
    ).toEqual({ a: { b: 'x', 'b.c': 'y' } });
  });

  it('applies the collision rule independently of input order', async () => {
    const forward = await render([
      ['a.b', 'x'],
      ['a.b.c', 'y'],
      ['a.b.d.e', 'z'],
    ]);
    const reversed = await render([
      ['a.b.d.e', 'z'],
      ['a.b.c', 'y'],
      ['a.b', 'x'],
    ]);
    expect(forward).toEqual({ a: { b: 'x', 'b.c': 'y', 'b.d.e': 'z' } });
    expect(reversed).toEqual(forward);
  });

  it('handles a top-level leaf that is also a prefix', async () => {
    expect(
      await render([
        ['a', 'root'],
        ['a.b', 'child'],
      ]),
    ).toEqual({ a: 'root', 'a.b': 'child' });
  });

  it('preserves unicode and emoji values verbatim', async () => {
    expect(
      await render([
        ['greet.ja', 'こんにちは'],
        ['greet.emoji', 'Hi 👋🏽 — "quoted" \\ backslash'],
      ]),
    ).toEqual({ greet: { ja: 'こんにちは', emoji: 'Hi 👋🏽 — "quoted" \\ backslash' } });
  });

  it('supports very deep keys', async () => {
    const segments = Array.from({ length: 60 }, (_, i) => `s${i}`);
    const tree = await nested.toTree([{ key: segments.join('.'), value: 'deep' }]);
    let node: unknown = tree;
    for (const segment of segments) node = (node as Record<string, unknown>)[segment];
    expect(node).toBe('deep');
  });

  it('never touches Object.prototype for hostile segment names', async () => {
    const tree = await nested.toTree([
      { key: '__proto__.polluted', value: 'yes' },
      { key: 'constructor.prototype.x', value: 'no' },
    ]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(tree)).toBeNull();
    expect(JSON.parse(JSON.stringify(tree))).toEqual({
      ['__proto__']: { polluted: 'yes' },
      constructor: { prototype: { x: 'no' } },
    });
  });

  it('yields to the event loop while rendering large inputs', async () => {
    const entries = Array.from({ length: 12_000 }, (_, i) => ({
      key: `m${i % 3}.k${i}`,
      value: 'v',
    }));
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 0);
    const json = await nested.render(entries);
    clearInterval(timer);
    expect(Object.keys(JSON.parse(json) as object)).toEqual(['m0', 'm1', 'm2']);
    expect(ticks).toBeGreaterThan(0);
  });
});

describe('FlatExportFormatter', () => {
  const flat = new FlatExportFormatter();

  it('renders an empty object', async () => {
    expect(await flat.render([])).toBe('{}');
  });

  it('renders valid JSON with escaped keys and values', async () => {
    const json = await flat.render([
      { key: 'a.b', value: 'He said "hi"\n' },
      { key: 'emoji', value: '🚀' },
    ]);
    expect(JSON.parse(json)).toEqual({ 'a.b': 'He said "hi"\n', emoji: '🚀' });
  });
});

describe('ExportFormatterRegistry', () => {
  it('resolves each registered strategy by format', () => {
    const registry = new ExportFormatterRegistry([
      new FlatExportFormatter(),
      new NestedExportFormatter(),
    ]);
    expect(registry.get(ExportFormat.Flat)).toBeInstanceOf(FlatExportFormatter);
    expect(registry.get(ExportFormat.Nested)).toBeInstanceOf(NestedExportFormatter);
  });

  it('fails loudly for an unregistered format', () => {
    const registry = new ExportFormatterRegistry([new FlatExportFormatter()]);
    expect(() => registry.get(ExportFormat.Nested)).toThrow('No export formatter registered');
  });
});
