/**
 * Plan data that reaches markup: anyone in a session can write the plan, so what it says is never taken as markup,
 * a style or a link. Colors and logos are checked as the plan loads and as changes apply; a task never carries a
 * link; and the strings Bryntum shows as HTML (a menu item's tooltip, a toast) encode the task's name.
 */
import type { ResourceModel, TaskModel } from '@bryntum/gantt';
import { describe, expect, it } from 'vitest';
import { crewColor } from '../../src/gantt/look';
import { NAMED_EVENT_COLORS, safeColor, safeImageUrl } from '../../src/gantt/model/safe-fields';
import { lockMessage, lockMessageHtml } from '../../src/gantt/payment-lock';
import { newProject } from '../sync/helpers';

const SCRIPT_NAME = '<img src=x onerror="alert(document.domain)">Pour & cure “slab”';

describe('colors', () => {
  it('takes #rgb, #rrggbb and Bryntum’s color names', () => {
    for (const color of ['#abc', '#A1B2C3', '#64594c', 'teal', 'deep-orange', 'light-gray', ...NAMED_EVENT_COLORS]) expect(safeColor(color)).toBe(color);
    expect(safeColor(' #64594c ')).toBe('#64594c');
  });

  it('refuses anything that could carry more than a color into a style', () => {
    for (const value of [
      'red;position:fixed;inset:0;z-index:99999',
      '#64594c;background:url(https://evil.example/x)',
      'url(https://evil.example/x)',
      'var(--x)',
      'rgb(1,2,3)',
      '#abcd',
      '#12345g',
      'expression(alert(1))',
      'notacolor',
      '',
      42,
      null,
      { toString: () => 'red' },
    ]) {
      expect(safeColor(value), String(value)).toBeNull();
    }
    // Left out stays left out.
    expect(safeColor(undefined)).toBeUndefined();
  });
});

describe('images', () => {
  it('takes this site’s own paths', () => {
    for (const path of ['/crews/site-crew.png', '/crews/logos/granite-concrete.png', '/assets/logo-3f9a.webp']) expect(safeImageUrl(path)).toBe(path);
  });

  it('drops every other address', () => {
    for (const value of [
      'https://evil.example/pixel.png',
      'http://gantry-pearl.vercel.app/crews/x.png',
      '//evil.example/x.png',
      '/\\evil.example/x.png',
      '/crews//evil.example',
      'javascript:alert(1)',
      'data:image/svg+xml,<svg onload=alert(1)>',
      'blob:https://gantry-pearl.vercel.app/1',
      'crews/x.png',
      '/crews/x.png?track=1',
      '/crews/x.png#a',
      '/crews/%2e%2e/x.png',
      `/${'a'.repeat(400)}`,
      '',
      7,
      null,
    ]) {
      expect(safeImageUrl(value), String(value)).toBeNull();
    }
    expect(safeImageUrl(undefined)).toBeUndefined();
  });
});

/** What the record holds for a field (Bryntum's own getters can read a stored null back as undefined). */
const stored = (record: object, field: string): unknown => (record as { data: Record<string, unknown> }).data[field];

async function loadPlan() {
  const project = newProject();
  await project.loadInlineData({
    tasksData: [
      { id: 1, name: 'Good', duration: 1, eventColor: 'teal' },
      { id: 2, name: 'Hex', duration: 1, eventColor: '#1d777b' },
      { id: 3, name: 'Linked', duration: 1, href: 'javascript:alert(document.domain)', target: '_top', eventColor: 'red;position:fixed;inset:0' },
    ],
    resourcesData: [
      { id: 10, name: 'Granite Ridge Concrete', eventColor: '#4e5c6b', imageUrl: '/crews/logos/granite-concrete.png' },
      { id: 11, name: 'Evil crew', eventColor: 'blue;background-image:url(https://evil.example/t)', imageUrl: 'https://evil.example/t.png' },
      { id: 12, name: 'Plain crew' },
    ],
  });
  await project.commitAsync();
  return project;
}

describe('the plan as it loads and changes', () => {
  it('keeps real colors and the site’s own logos, and reads the rest as not set', async () => {
    const project = await loadPlan();
    const task = (id: number) => project.taskStore.getById(id) as TaskModel & { eventColor?: string };
    const crew = (id: number) => project.resourceStore.getById(id) as ResourceModel;
    expect(task(1).eventColor).toBe('teal');
    expect(task(2).eventColor).toBe('#1d777b');
    expect(stored(task(3), 'eventColor')).toBeNull();
    expect(task(3).eventColor).toBeFalsy();
    expect(crew(10).eventColor).toBe('#4e5c6b');
    expect(crew(10).imageUrl).toBe('/crews/logos/granite-concrete.png');
    expect(stored(crew(11), 'eventColor')).toBeNull();
    expect(stored(crew(11), 'imageUrl')).toBeNull();
    expect(crew(11).eventColor).toBeFalsy();
    expect(crew(11).imageUrl).toBeFalsy();
    // Nothing is added to a record that never had the field.
    expect(Object.keys((crew(12) as unknown as { data: object }).data)).not.toContain('imageUrl');
    // The fallback color, never the injected one.
    expect(crewColor(crew(11))).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('never gives a task a link: Bryntum’s tree column draws a name with a href as an <a>', async () => {
    const project = await loadPlan();
    const linked = project.taskStore.getById(3) as TaskModel & { href?: string; target?: string };
    expect(linked.href).toBeUndefined();
    expect(linked.target).toBeUndefined();
    linked.set({ href: 'javascript:alert(1)', target: '_blank' } as never);
    expect(linked.href).toBeUndefined();
    expect(JSON.stringify((linked as unknown as { data: object }).data)).not.toContain('javascript:');
  });

  it('checks a change as it applies, as from another person’s revision', async () => {
    const project = await loadPlan();
    const task = project.taskStore.getById(1) as TaskModel & { eventColor?: string };
    const crew = project.resourceStore.getById(10) as ResourceModel;
    task.set('eventColor', 'teal;outline:9999px solid red');
    crew.set({ eventColor: 'url(https://evil.example/x)', imageUrl: '//evil.example/x.png' });
    expect(stored(task, 'eventColor')).toBeNull();
    expect(stored(crew, 'eventColor')).toBeNull();
    expect(stored(crew, 'imageUrl')).toBeNull();
    task.set('eventColor', 'lime');
    crew.set('imageUrl', '/crews/crane.png');
    expect(task.eventColor).toBe('lime');
    expect(crew.imageUrl).toBe('/crews/crane.png');
  });

  it('a crew color that isn’t one never reaches a style through crewColor', () => {
    expect(crewColor({ id: 3, eventColor: 'red;position:fixed' } as unknown as ResourceModel)).toMatch(/^#[0-9a-f]{6}$/);
    expect(crewColor({ id: 3, eventColor: '#64594c' } as unknown as ResourceModel)).toBe('#64594c');
  });
});

describe('the lock message', () => {
  it('as text for React, and encoded for Bryntum’s HTML tooltip', async () => {
    const project = newProject();
    await project.loadInlineData({ tasksData: [{ id: 1, name: SCRIPT_NAME, duration: 1 }] });
    const task = project.taskStore.getById(1) as TaskModel;
    expect(lockMessage(task)).toContain(SCRIPT_NAME);
    const html = lockMessageHtml(task);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(document.domain)&quot;&gt;Pour &amp; cure');
    // Inserted as HTML, it reads back as the plain message, with no element in it.
    const host = document.createElement('div');
    host.innerHTML = html;
    expect(host.children).toHaveLength(0);
    expect(host.textContent).toBe(lockMessage(task));
  });
});
