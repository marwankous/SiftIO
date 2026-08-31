import { describe, it, expect } from 'vitest';
import { normalizeValue, normalizeRow, columnHints } from './duck';

// The DuckDB boot itself needs a real browser and is verified manually; what is
// testable here is the Arrow -> JSON-safe conversion, which is where the bugs are.
describe('normalizeValue', () => {
  it('converts bigint to number, which JSON.stringify cannot do alone', () => {
    expect(() => JSON.stringify({ n: 42n })).toThrow();
    expect(normalizeValue(42n)).toBe(42);
  });

  it('keeps a bigint beyond 2^53 exact as a string rather than corrupting it', () => {
    // Number(9223372036854775807n) === 9223372036854776000 — precision lost.
    expect(normalizeValue(9223372036854775807n)).toBe('9223372036854775807');
    expect(normalizeValue(9007199254740991n)).toBe(9007199254740991); // exactly 2^53-1, still safe
  });

  it('converts Date to an ISO string', () => {
    expect(normalizeValue(new Date('2025-01-01T00:00:00Z'))).toBe('2025-01-01T00:00:00.000Z');
  });

  it('passes primitives through untouched', () => {
    expect(normalizeValue('a')).toBe('a');
    expect(normalizeValue(1.5)).toBe(1.5);
    expect(normalizeValue(true)).toBe(true);
  });

  it('normalises null and undefined to null', () => {
    expect(normalizeValue(null)).toBeNull();
    expect(normalizeValue(undefined)).toBeNull();
  });

  it('handles a nested object containing a bigint', () => {
    expect(normalizeValue({ a: 1n, b: 'x' })).toEqual({ a: 1, b: 'x' });
  });
});

describe('column hints', () => {
  it('reads kinds off the Arrow schema and leaves text alone', () => {
    const map = columnHints([
      { name: 'joined', type: 'Date32<DAY>' },
      { name: 'seen_at', type: 'Timestamp<MICROSECOND>' },
      { name: 'name', type: 'Utf8' },
      { name: 'amt', type: 'Float64' },
      { name: 'total', type: 'Decimal<38,0>' },
    ]);
    expect([...map]).toEqual([
      ['joined', 'date'],
      ['seen_at', 'timestamp'],
      ['amt', 'numeric'],
      ['total', 'numeric'],
    ]);
  });

  it('converts a HUGEINT sum delivered as a string into a number', () => {
    // DuckDB sum() over integers is HUGEINT; Arrow serialises it as a string.
    expect(normalizeValue('216761584', 'numeric')).toBe(216761584);
    expect(normalizeValue('-2026.55', 'numeric')).toBe(-2026.55);
  });

  it('converts an Arrow Decimal128 limb array via its digits', () => {
    // DuckDB HUGEINT arrives as a Uint32Array whose toString gives the digits.
    const limbs = Object.assign(new Uint32Array([4168492]), {
      toString: () => '4168492',
    });
    expect(normalizeValue(limbs, 'numeric')).toBe(4168492);
  });

  it('refuses to guess when a numeric column stringifies to something odd', () => {
    const odd = Object.assign(new Uint32Array([1, 2]), { toString: () => '1,2' });
    expect(normalizeValue(odd, 'numeric')).toBe('1,2');
  });

  it('keeps an integer beyond 2^53 exact rather than converting', () => {
    expect(normalizeValue('9223372036854775807', 'numeric')).toBe('9223372036854775807');
  });

  it('never converts a string in a column Arrow does not call numeric', () => {
    // A zero-padded postcode or id must survive untouched.
    expect(normalizeValue('00123')).toBe('00123');
    expect(normalizeRow({ zip: '00123' }, new Map())).toEqual({ zip: '00123' });
  });

  it('renders a DATE as a plain day, not epoch millis', () => {
    // DuckDB DATE arrives from Arrow as a number; 1641427200000 is 2022-01-06.
    expect(normalizeValue(1641427200000, 'date')).toBe('2022-01-06');
  });

  it('keeps the time component for a TIMESTAMP', () => {
    expect(normalizeValue(1641427200000, 'timestamp')).toBe('2022-01-06T00:00:00.000Z');
  });

  it('handles a temporal value delivered as bigint', () => {
    expect(normalizeValue(1641427200000n, 'date')).toBe('2022-01-06');
  });

  it('leaves a null temporal value null', () => {
    expect(normalizeValue(null, 'date')).toBeNull();
  });

  it('does not touch a numeric column that is not temporal', () => {
    expect(normalizeValue(1641427200000)).toBe(1641427200000);
  });
});

describe('normalizeRow', () => {
  it('applies temporal kinds per column', () => {
    const row = normalizeRow(
      { joined: 1641427200000, amt: 1641427200000 },
      new Map([['joined', 'date' as const]]),
    );
    expect(row).toEqual({ joined: '2022-01-06', amt: 1641427200000 });
  });

  it('produces a row that survives JSON.stringify', () => {
    const row = normalizeRow({ id: 7n, day: new Date('2025-06-01T00:00:00Z'), amt: 2.5 });
    expect(row).toEqual({ id: 7, day: '2025-06-01T00:00:00.000Z', amt: 2.5 });
    expect(() => JSON.stringify(row)).not.toThrow();
  });
});
