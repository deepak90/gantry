/**
 * The walkthroughs load only when the address asks for one, each on its own project, and never on the hosted site.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadRailScript } from '../../src/rails/scripts';

const HARBOR = '00000000-0000-4000-8000-000000000002';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('loadRailScript', () => {
  it('loads the walkthrough the address names, on its own project only', async () => {
    await expect(loadRailScript(HARBOR, '')).resolves.toBeNull();
    expect((await loadRailScript(HARBOR, '?rails=film'))?.id).toBe('film');
    await expect(loadRailScript('00000000-0000-4000-8000-000000000001', '?rails=film')).resolves.toBeNull();
    await expect(loadRailScript(HARBOR, '?rails=nothing')).resolves.toBeNull();
  });

  it('has none on the hosted site', async () => {
    vi.stubEnv('VITE_GANTRY_HOSTED', '1');
    await expect(loadRailScript(HARBOR, '?rails=film')).resolves.toBeNull();
  });
});
