import { useId } from 'react';

const ICE = 'oklch(0.88 0.07 232)';
const DEEP = 'oklch(0.42 0.16 264)';
const SPARK_PATH = 'M12 1.5C12.7 7.2 16.8 11.3 22.5 12 16.8 12.7 12.7 16.8 12 22.5 11.3 16.8 7.2 12.7 1.5 12 7.2 11.3 11.3 7.2 12 1.5Z';

/** Gantry's mark: a tower crane lifting the spark, in a 120 by 120 box. */
export function GantryMark() {
  const id = `gantry-${useId().replace(/[^\w-]/g, '')}`;
  const fill = (name: string) => `url(#${id}-${name})`;
  return (
    <svg viewBox="0 0 120 120" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-cobalt`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="oklch(0.8 0.11 240)" />
          <stop offset="0.5" stopColor="oklch(0.62 0.19 262)" />
          <stop offset="1" stopColor={DEEP} />
        </linearGradient>
        <linearGradient id={`${id}-steel`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="oklch(0.97 0.015 240)" />
          <stop offset="0.55" stopColor="oklch(0.8 0.06 245)" />
          <stop offset="1" stopColor="oklch(0.6 0.1 255)" />
        </linearGradient>
        <linearGradient id={`${id}-spark`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="oklch(0.98 0.012 250)" />
          <stop offset="0.5" stopColor={ICE} />
          <stop offset="1" stopColor="oklch(0.66 0.17 258)" />
        </linearGradient>
      </defs>
      {/* The cab's peak and its ties to both ends of the jib. */}
      <path d="M43 6 L37 22 H49 Z" fill={fill('steel')} />
      <path d="M43 7 L108 22 M43 7 L14 22" stroke={ICE} strokeWidth={1.8} fill="none" />
      {/* The jib, the counterweight, the mast with its lattice, the cab and the base. */}
      <rect x={12} y={22} width={98} height={6} rx={1.5} fill={fill('cobalt')} />
      <rect x={12} y={28} width={12} height={11} rx={1.5} fill={DEEP} />
      <rect x={36} y={28} width={14} height={78} fill={fill('cobalt')} />
      <path d="M36 104 L50 92 L36 80 L50 68 L36 56 L50 44 L36 32" stroke={ICE} strokeWidth={1.8} fill="none" strokeLinejoin="round" />
      <rect x={50} y={28} width={10} height={9} rx={1.5} fill={ICE} />
      <rect x={28} y={104} width={30} height={8} rx={2} fill={DEEP} />
      {/* The trolley, and the spark on its hook. */}
      <rect x={83} y={28} width={12} height={4.5} rx={1} fill={ICE} />
      <path d="M89 32 V66" stroke={ICE} strokeWidth={1.6} />
      <path d="M89 66 a3.5 3.5 0 1 1 -3.5 3.5" stroke={ICE} strokeWidth={1.8} fill="none" strokeLinecap="round" />
      <path d={SPARK_PATH} fill={fill('spark')} transform="translate(75 70) scale(1.1667)" />
    </svg>
  );
}
