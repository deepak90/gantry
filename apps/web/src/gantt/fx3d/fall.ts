/**
 * Zooming straight into a bar. The camera starts exactly over the chart and drops: the chart grows with it (the page
 * is scaled to match, so the bar stays where the camera sees it) until the bar's own color is all there is to see.
 * That color clears on the work's room right below, still falling, and the camera comes to rest as the walls rise
 * around the work. Everything is a function of one number from 0 to 1, so leaving is the same move run backward, and a
 * change of mind turns it around anywhere.
 */
import { smooth, within } from './parts';

/** Where the chart ends and the room begins, along the fall. */
export const FALL_SPLIT = 0.42;
export const FALL_SECONDS = 2.5;
export const ESCAPE_SECONDS = 2.1;
/** How far the camera goes on past the chart: just enough to be through it. */
const THROUGH = 90;
export type FallStage = { stage: 'chart'; t: number } | { stage: 'room'; t: number };

export const fallStage = (value: number): FallStage => (value < FALL_SPLIT ? { stage: 'chart', t: value / FALL_SPLIT } : { stage: 'room', t: (value - FALL_SPLIT) / (1 - FALL_SPLIT) });

/** How high the camera is over the chart: it drops as anything falling does, slowly and then fast. */
export const dropHeight = (t: number, from: number, through = THROUGH): number => from - (from + through) * t * t * t;

/** How far the camera has moved over the bar: all the way before it reaches it. */
export const overBar = (t: number): number => smooth(within(t, 0, 0.66));

/** The height at which a bar of this size fills the whole view. */
export const fillHeight = (rect: { w: number; d: number }, halfTan: number, aspect: number): number => Math.min(rect.d, rect.w / aspect) / (2 * halfTan);

/**
 * How much of the screen the bar's own color fills, over the chart: it comes up as the bar's edges leave the view,
 * covering the blur of a page scaled that far.
 */
export const colorOverChart = (up: number, fill: number): number => 1 - smooth(within(up, fill, fill * 5));

/** The same color clearing over the room. */
export const colorOverRoom = (t: number): number => 1 - smooth(within(t, 0, 0.3));
