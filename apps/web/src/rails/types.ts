/**
 * The walkthrough's script: steps the assistant performs on the plan, one per press of Next, played like
 * a call. A step names itself for the counter, holds what you say before pressing Next, acts through the
 * real interface with the assistant's hand, has the assistant say its lines as it goes, and leaves a
 * one-line takeaway.
 */
import type { Gantt, ProjectModel } from '@bryntum/gantt';
import type { InspectorTabId } from '../inspector/Inspector';
import type { Call } from './call';
import type { Hand } from './hand';
import type { WaitOptions } from './wait';

/** What a step may reach in the app, beyond the page itself. */
export interface RailApp {
  gantt(): Gantt | undefined;
  project: ProjectModel;
  /** Who is signed in, as their profile names them ("Deepak Jayaram"): Remy greets them by first name. */
  you?: string;
  /** Opens a side panel, or does nothing if it is open already. */
  openPanel(panel: InspectorTabId): void;
  /** Closes the side panel, giving the chart its width back. */
  closePanel?(): void;
  showTasks(taskIds: readonly number[]): void;
  /** Selects a task and opens its panel (the task tab), as a double-click on its row does. */
  openTask?(taskId: number): void;
  /** Starts a fresh conversation with the assistant, so earlier cards don't answer for this one. */
  newConversation?(): void;
  /** Says something to the assistant as you: your message in the thread, which it answers. */
  send(text: string, channel: 'text' | 'voice'): Promise<boolean>;
  /**
   * Teammates simulated in the page, already at work on the plan when you arrive: their cursors and avatars, no
   * account, nothing written. `start` gives their names once they are coming in; `stop` sees them out.
   */
  team?: { start(people: number): Promise<readonly string[]>; stop(): void };
}

export interface RailContext {
  hand: Hand;
  call: Call;
  /** Aborted when Previous stops the step part way. */
  signal: AbortSignal;
  /** Your line for this step: as heard in the voice mode, the printed line otherwise. */
  said: string;
  app: RailApp;
  /** Looks until `probe` returns something; gives up with a plain message. */
  wait<T>(probe: () => T | null | undefined | false, options: Omit<WaitOptions, 'signal'>): Promise<T>;
  /** A pause, at the hand's pace. */
  pause(ms: number): Promise<void>;
  /** The assistant says a line, as captions coming up a few words at a time. Resolves when it's all said. */
  say(text: string): Promise<void>;
  /** Waits for `work` while the assistant is seen thinking. */
  think<T>(work: Promise<T>): Promise<T>;
  /** The assistant joins the call: its avatar comes in and its cursor fades in. */
  join(): Promise<void>;
  /** The assistant leaves the call. */
  leave(): Promise<void>;
}

/** Your line: what you say before pressing Next. */
export interface RailYou {
  text: string;
  /** Goes to the assistant as your message, and it answers. Without it, the assistant just acts on it. */
  ask?: boolean;
}

export interface RailStep {
  /** Stable name: the video's audio and the logs use it. */
  key: string;
  /** The counter's name for the step. */
  label: string;
  /** The step's takeaway: a short bold lead and one sentence, shown once everyone has stopped talking. */
  caption: { lead: string; text: string };
  you?: RailYou;
  /** Puts the screen where the step starts, whatever was clicked in between. */
  prepare?(context: RailContext): Promise<void>;
  /** The assistant's actions and lines. */
  run(context: RailContext): Promise<void>;
}

export interface RailScript {
  id: string;
  /** The project it runs on; it shows on no other. */
  projectId: string;
  /** The assistant's name on screen. */
  assistant: { name: string };
  steps: readonly RailStep[];
  /**
   * Played by a call, not by Next: once started, each step follows the one before, waiting on what is said on the
   * call; a step that fails is noted and the next one goes on. No counter.
   */
  auto?: boolean;
}
