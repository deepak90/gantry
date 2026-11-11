/**
 * The walkthroughs, by name, each only on its own project and only when the address asks for it: `?rails=film`
 * (the film's story on Harbor) or `?rails=floors` (the light-fixture package alone). They load when asked for
 * (all.ts), so the page carries none of them until then. They run on a local build only: a hosted build has none at
 * all (`VITE_GANTRY_HOSTED=1` is written into the bundle, so the import below is left out of it).
 */
import type { RailScript } from '../types';

/** The walkthrough `?rails=` names, if it is one of this project's. */
export async function loadRailScript(projectId: string, search: string = window.location.search): Promise<RailScript | null> {
  if (import.meta.env.VITE_GANTRY_HOSTED === '1') return null;
  const wanted = new URLSearchParams(search).get('rails');
  if (!wanted) return null;
  const { RAIL_SCRIPTS } = await import('./all');
  return RAIL_SCRIPTS.find((script) => script.id === wanted && script.projectId === projectId) ?? null;
}
