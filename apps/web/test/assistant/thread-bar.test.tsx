/**
 * Who a conversation is for, and sharing costs in it: inviting someone who cannot see costs into a
 * conversation where someone can first shows a caution, and only a confirmation (by someone who sees
 * costs) brings them in, with the costs shared; a person who sees costs comes in at once; the header
 * says who shared the costs, and the General thread still says amounts are hidden.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentThreadRow } from '@collab/shared';
import { ThreadBar, type ThreadBarProps } from '../../src/assistant/ThreadBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT = '00000000-0000-4000-8000-000000000001';
const CHRIS = '00000000-0000-4000-8000-000000000012';
const PRIYA = '00000000-0000-4000-8000-000000000011';
const SAM = '00000000-0000-4000-8000-000000000013';
const THREAD = '00000000-0000-4000-8000-00000000a001';
const NAMES: Record<string, string> = { [CHRIS]: 'Chris Morgan', [PRIYA]: 'Priya Mehta', [SAM]: 'Sam Okafor' };

const thread = (overrides: Partial<AgentThreadRow> = {}): AgentThreadRow => ({
  id: THREAD,
  project_id: PROJECT,
  title: 'Rented equipment paid while it stands idle',
  created_by: CHRIS,
  created_at: '2026-10-25T09:00:00Z',
  last_message_at: '2026-10-25T09:00:00Z',
  title_source: 'person',
  visibility: 'private',
  costs_shared_by: null,
  costs_shared_at: null,
  ...overrides,
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(overrides: Partial<ThreadBarProps> = {}) {
  const props: ThreadBarProps = {
    threadId: THREAD,
    draft: false,
    threads: [thread()],
    invited: new Map(),
    members: [
      { userId: CHRIS, canViewCosts: true },
      { userId: PRIYA, canViewCosts: false },
      { userId: SAM, canViewCosts: true },
    ],
    unread: new Set(),
    busyThread: null,
    viewerId: CHRIS,
    viewerIsPm: false,
    mentionsAmounts: true,
    nameOf: (userId) => (userId ? (NAMES[userId] ?? null) : null),
    onOpen: () => undefined,
    onNew: () => undefined,
    onRename: async () => true,
    onDelete: async () => true,
    onInvite: vi.fn(async () => true),
    onRemove: async () => true,
    onShare: vi.fn(async () => true),
    ...overrides,
  };
  act(() => root.render(<ThreadBar {...props} />));
  return props;
}

const click = (element: Element | null | undefined) =>
  act(() => {
    (element as HTMLElement).click();
  });
const inviteMenu = (name: string) => {
  click(host.querySelector('[data-testid=thread-invite]'));
  return [...host.querySelectorAll('[data-testid=thread-invite-member]')].find((item) => item.textContent?.includes(name));
};

describe('sharing costs in a conversation', () => {
  it('cautions before someone who cannot see costs comes in, and brings them in only once the costs are shared', async () => {
    const props = render();
    click(inviteMenu('Priya'));
    const caution = host.querySelector('[data-testid=thread-caution]')!;
    expect(caution.getAttribute('role')).toBe('alertdialog');
    expect(caution.textContent).toContain('Invite Priya into this conversation?');
    expect(caution.textContent).toContain('Priya can’t see costs on this project. Everything in this conversation will be visible to Priya: what has been said, including the amounts already mentioned here,');
    expect(props.onInvite).not.toHaveBeenCalled();

    click(host.querySelector('[data-testid=thread-caution-cancel]'));
    expect(host.querySelector('[data-testid=thread-caution]')).toBeNull();
    expect(props.onInvite).not.toHaveBeenCalled();

    click(inviteMenu('Priya'));
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid=thread-caution-confirm]')!.click();
    });
    expect(props.onInvite).toHaveBeenCalledWith(PRIYA, true);
  });

  it('brings in someone who sees costs at once', async () => {
    const props = render();
    const sam = inviteMenu('Sam') as HTMLElement;
    await act(async () => {
      sam.click();
    });
    expect(host.querySelector('[data-testid=thread-caution]')).toBeNull();
    expect(props.onInvite).toHaveBeenCalledWith(SAM);
  });

  it('cautions before sharing the conversation with a project where some cannot see costs', async () => {
    const props = render();
    click([...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Share'));
    expect(host.querySelector('[data-testid=thread-caution]')!.textContent).toContain('Share this conversation with the whole project?');
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid=thread-caution-confirm]')!.click();
    });
    expect(props.onShare).toHaveBeenCalledWith('project', true);
  });

  it('lets only someone who sees costs share them', () => {
    // Priya's conversation with Chris in it: Priya cannot share its costs with Sam's colleague who cannot see them.
    render({
      viewerId: PRIYA,
      threads: [thread({ created_by: PRIYA })],
      invited: new Map([[THREAD, [CHRIS]]]),
      members: [
        { userId: CHRIS, canViewCosts: true },
        { userId: PRIYA, canViewCosts: false },
        { userId: SAM, canViewCosts: false },
      ],
    });
    click(inviteMenu('Sam'));
    const caution = host.querySelector('[data-testid=thread-caution]')!;
    expect(caution.textContent).toContain('Only someone who can see costs can share them.');
    expect(host.querySelector('[data-testid=thread-caution-confirm]')).toBeNull();
  });

  it('says who shared the costs, and that the General thread hides amounts from people who cannot see them', () => {
    render({ threads: [thread({ costs_shared_by: CHRIS, costs_shared_at: '2026-10-25T09:05:00Z' })], invited: new Map([[THREAD, [PRIYA]]]) });
    expect(host.querySelector('[data-testid=thread-costs-shared]')!.textContent).toContain('Costs shared by you');
    expect(host.textContent).not.toContain('Amounts hidden');
    render({ threadId: null, threads: [] });
    expect(host.textContent).toContain('Amounts hidden for Priya');
  });
});
