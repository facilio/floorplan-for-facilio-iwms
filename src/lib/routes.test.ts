import { describe, expect, it } from 'vitest';
import { floorFromLocation, validRecordFloorId } from './routes';

describe('validRecordFloorId', () => {
  it('accepts positive integer ids', () => {
    expect(validRecordFloorId('123')).toBe('123');
    expect(validRecordFloorId(' 42 ')).toBe('42');
    expect(validRecordFloorId('007')).toBe('7');
  });
  it('rejects text, decimals, signs, zero and overflow', () => {
    for (const bad of ['abc', '12abc', '12.5', '-3', '+3', '0', '', '   ', '1e3', '99999999999999999999', '<script>']) {
      expect(validRecordFloorId(bad)).toBeNull();
    }
    expect(validRecordFloorId(null)).toBeNull();
    expect(validRecordFloorId(undefined)).toBeNull();
  });
});

describe('floorFromLocation', () => {
  it('reads the raw param and tolerates malformed query strings', () => {
    expect(floorFromLocation({ search: '?floor=abc' })).toBe('abc');
    expect(floorFromLocation({ search: '?floor=%E0%A4%A' })).not.toBeUndefined();
    expect(floorFromLocation({ search: '' })).toBeNull();
  });
});
