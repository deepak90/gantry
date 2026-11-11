/** Every walkthrough, loaded only when the address asks for one (index.ts). */
import type { RailScript } from '../types';
import { filmWalk } from './film';
import { floorsProof } from './floors';

export const RAIL_SCRIPTS: readonly RailScript[] = [filmWalk, floorsProof];
