import { describe, expect, it } from 'vitest';
import { hostOf } from '../src/host.ts';

describe('who hosts the call', () => {
  it('is whoever has been on it longest', () => {
    expect(hostOf([{ identity: 'chris', joinedAt: 2_000 }, { identity: 'deepak', joinedAt: 1_000 }, { identity: 'guest', joinedAt: 3_000 }])).toBe('deepak');
  });

  it('is nobody on an empty call', () => {
    expect(hostOf([])).toBeNull();
  });

  it('passes to the next longest when the host leaves', () => {
    const people = [
      { identity: 'deepak', joinedAt: 1_000 },
      { identity: 'chris', joinedAt: 2_000 },
      { identity: 'guest', joinedAt: 3_000 },
    ];
    expect(hostOf(people)).toBe('deepak');
    expect(hostOf(people.filter((person) => person.identity !== 'deepak'))).toBe('chris');
  });

  it('puts someone whose join time is not known last, and breaks ties by identity, as every tab does', () => {
    expect(hostOf([{ identity: 'a-unknown', joinedAt: 0 }, { identity: 'b-known', joinedAt: 5_000 }])).toBe('b-known');
    expect(hostOf([{ identity: 'b', joinedAt: 1_000 }, { identity: 'a', joinedAt: 1_000 }])).toBe('a');
    expect(hostOf([{ identity: 'b', joinedAt: 0 }, { identity: 'a', joinedAt: 0 }])).toBe('a');
  });

  it('is never a recording participant, even one that joined first', () => {
    expect(hostOf([{ identity: 'recorder-1', joinedAt: 500 }, { identity: 'deepak', joinedAt: 1_000 }])).toBe('deepak');
    expect(hostOf([{ identity: 'recorder-1', joinedAt: 500 }])).toBeNull();
  });
});
