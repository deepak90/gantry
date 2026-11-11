import { afterEach, describe, expect, it, vi } from 'vitest';
import { joinCodeTarget, startJoinCodeForms } from '../../src/site/join-code';

describe('joining with a code from the landing page', () => {
  it.each([
    ['482917', '/app?code=482917'],
    ['482 917', '/app?code=482917'],
    ['482-917', '/app?code=482917'],
    ['  482 917  ', '/app?code=482917'],
  ])('takes %j to the app with the six digits', (typed, href) => {
    expect(joinCodeTarget(typed)).toEqual({ href });
  });

  it.each(['48291', '4829170', 'abc123', '482.917', '48 29 1x'])('says plainly that %j is not a session code', (typed) => {
    expect(joinCodeTarget(typed)).toEqual({ error: 'A session code is 6 digits, like 482 917.' });
  });

  it('asks for the code when the field is empty', () => {
    expect(joinCodeTarget('   ')).toEqual({ error: 'Type the 6-digit code your teammate gave you.' });
  });
});

describe('the code field', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  const field = (go = vi.fn()) => {
    document.body.innerHTML = `
      <form action="/app" method="get" data-join-code novalidate>
        <input name="code" />
        <button type="submit">Join</button>
        <p data-join-error hidden></p>
      </form>`;
    startJoinCodeForms(document, go);
    return {
      go,
      form: document.querySelector('form')!,
      input: document.querySelector('input')!,
      error: document.querySelector<HTMLElement>('[data-join-error]')!,
    };
  };

  it('keeps digits only, in groups of three, as they are typed', () => {
    const { input } = field();
    input.value = '48a2-91';
    input.dispatchEvent(new Event('input'));
    expect(input.value).toBe('482 91');
  });

  it('shows the message instead of leaving the page when the code is short', () => {
    const { form, input, error, go } = field();
    input.value = '482 91';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(go).not.toHaveBeenCalled();
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe('A session code is 6 digits, like 482 917.');
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('goes to the app with the code when it is whole', () => {
    const { form, input, error, go } = field();
    input.value = '482 917';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(go).toHaveBeenCalledWith('/app?code=482917');
    expect(error.hidden).toBe(true);
  });
});
