import { InvalidCursorError } from '../errors/errors';
import { decodeCursor, encodeCursor } from './cursor';

const raw = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

describe('cursor codec', () => {
  it('round-trips an id', () => {
    expect(decodeCursor(encodeCursor('9007199254740993'))).toBe('9007199254740993');
  });

  it('produces an opaque, URL-safe token', () => {
    expect(encodeCursor('42')).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each([
    ['empty', ''],
    ['non-base64url characters', 'abc$%^'],
    ['not JSON', Buffer.from('not json').toString('base64url')],
    ['wrong version', raw({ v: 2, id: '1' })],
    ['missing id', raw({ v: 1 })],
    ['numeric id', raw({ v: 1, id: 5 })],
    ['negative id', raw({ v: 1, id: '-5' })],
    ['zero id', raw({ v: 1, id: '0' })],
    ['SQL in id', raw({ v: 1, id: '1 OR 1=1' })],
    ['JSON null', raw(null)],
    ['too long', 'a'.repeat(201)],
  ])('rejects a tampered cursor: %s', (_label, cursor) => {
    expect(() => decodeCursor(cursor)).toThrow(InvalidCursorError);
  });
});
