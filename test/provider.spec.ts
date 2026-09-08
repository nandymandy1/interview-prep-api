import { describe, expect, it, vi } from 'vitest';
import { singleton } from '../src/common/providers/provider';

describe('singleton provider', () => {
  it('is lazy and returns the same instance after first resolution', () => {
    const factory = vi.fn(() => ({ id: Math.random() }));
    const provider = singleton(factory);

    expect(factory).not.toHaveBeenCalled();

    const first = provider();
    const second = provider();

    expect(factory).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });
});
