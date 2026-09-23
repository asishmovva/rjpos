import { describe, expect, it } from 'vitest';
import { rjPosTokens } from '../src/tokens.js';

describe('RJ POS UI foundation', () => {
  it('uses restrained operational tokens without prohibited defaults', () => {
    expect(rjPosTokens.colors.brand).toBe('#245b4a');
    expect(rjPosTokens.typography.ui).not.toBe('Inter');
    expect(rjPosTokens.typography.ui).not.toBe('Geist');
    expect(Number.parseInt(rjPosTokens.geometry.panelRadius)).toBeLessThanOrEqual(8);
  });
});
