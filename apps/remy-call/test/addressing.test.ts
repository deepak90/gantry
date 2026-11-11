import { describe, expect, it } from 'vitest';
import { Addressing, addressesRemy, addressesSomeoneElse, aloneOnCall, endsWithQuestion, firstName, isBackchannel, isSummons, mayContinue } from '../src/addressing.ts';

describe('addressesRemy', () => {
  it.each([
    "Remy, you on? Okay. So, um— I was out all last week. What'd I miss that actually costs us money?",
    'Remy, when do we get paid for the footings?',
    "Wait— wait, Remy, that's the slab. The footings are done already.",
    "Remy, can you— let's move the, uh, the crane to the Monday after Thanksgiving.",
    'Remy, um, does that still work with the slab pour?',
    "Hey Remy, what's the slab date?",
    'Can you check that, Remy?',
    'Thanks, Remy.',
    'Remy can you move the crane',
    "Okay Remy what's next",
    'So, Remy. The crane.',
    'Remi, can you send that over?',
    "Remy's the slab still on hold?",
    "Remy's, can you pull up the crane?",
    'Remy is the slab still on hold?',
    'Remy?',
    'And Remy, what about the slab?',
    'Remy... can you check the crane?',
    'Right, Remy?',
  ])('hears an address: %s', (text) => {
    expect(addressesRemy(text)).toBe(true);
  });

  it.each([
    "It's slipping. Remy's got it on hold till the, um, the footings get paid.",
    "Remy's got it on hold.",
    'Nora, uh, are we still pouring the slab on the twentieth? Or is that, uh, slipping?',
    'Yeah, yeah— I can have the crew there Monday morning.',
    'Did you ask Remy?',
    "I'll ask Remy about it later.",
    'Tony and Remy will sort it out.',
    'The remy crew starts Monday.',
    'Remys are on site Monday.',
    'Remy is checking the crane.',
    'Remy flagged it this morning.',
    'I told Remy the slab was late.',
    "Okay. So if that goes out today, um, we're pouring Monday?",
  ])('hears no address: %s', (text) => {
    expect(addressesRemy(text)).toBe(false);
  });
});

describe('the small rules', () => {
  it('knows a summons: the name alone, or a check-in', () => {
    for (const text of ['Remy?', 'Hey, Remy.', 'Remy. You on?', 'Remy, you there?', 'Hey Remy, quick question.', 'You there, Remy?', 'Remy, got a sec?']) {
      expect(isSummons(text), text).toBe(true);
    }
    for (const text of ['Remy, can you check?', 'Remy, the crane?', "Remy, you on? Okay. So, um— what'd I miss?"]) expect(isSummons(text), text).toBe(false);
  });

  it('knows an address that may not be over', () => {
    for (const text of ['Remy. You on?', 'Remy, can you—', 'Remy, can you...', 'Remy, the crane, um', 'Thanks, Remy.', 'Remy, the crane?']) {
      expect(mayContinue(text), text).toBe(true);
    }
    for (const text of ['Remy, when do we get paid for the footings?', "Wait— wait, Remy, that's the slab. The footings are done already.", 'Okay, so, um...', 'Nora, can you—']) {
      expect(mayContinue(text), text).toBe(false);
    }
  });

  it('knows a backchannel', () => {
    for (const text of ['Mm-hm.', 'Okay.', 'Got it, thanks.', 'Yeah.', 'Uh-huh.', 'All right, makes sense.']) expect(isBackchannel(text)).toBe(true);
    for (const text of ['No.', 'Okay, and the crane?', 'Yes, move it.', '']) expect(isBackchannel(text)).toBe(false);
  });

  it('knows a line for someone else', () => {
    expect(addressesSomeoneElse('Nora, are we still pouring Monday?', ['Nora', 'Tony'])).toBe(true);
    expect(addressesSomeoneElse('Are we still pouring Monday, Tony?', ['Nora', 'Tony'])).toBe(true);
    expect(addressesSomeoneElse('And when does the crane get here?', ['Nora', 'Tony'])).toBe(false);
    expect(addressesSomeoneElse('Remy, ask Nora.', ['Remy'])).toBe(false);
  });

  it('reads first names and questions', () => {
    expect(firstName('Tony (Granite Ridge)')).toBe('Tony');
    expect(firstName('Nora Bennett')).toBe('Nora');
    expect(endsWithQuestion('Want me to move the pour to match?')).toBe(true);
    expect(endsWithQuestion('Done. The crane arrives Monday.')).toBe(false);
  });
});

describe('Addressing: follow-ups', () => {
  const turn = (identity: string, text: string, startedAt: number, endedAt = startedAt + 1500) => ({ identity, text, startedAt, endedAt });

  it('addresses by name and never otherwise without a window', () => {
    const a = new Addressing();
    expect(a.decide(turn('deepak', 'Remy, what did I miss?', 0))).toMatchObject({ addressed: true, reason: 'name', summons: false });
    expect(a.decide(turn('deepak', 'And the crane?', 3000))).toMatchObject({ addressed: false });
  });

  it("takes the same person's next turn within 8 s of Remy answering them", () => {
    const a = new Addressing();
    a.answered('deepak', 10_000, false);
    expect(a.decide(turn('tony', 'Yeah, I can have the crew there Monday.', 11_000))).toMatchObject({ addressed: false });
    expect(a.decide(turn('deepak', 'And when does the crane get here?', 13_000))).toMatchObject({ addressed: true, reason: 'follow-up' });
    // only the next turn
    expect(a.decide(turn('deepak', 'And the slab?', 16_000))).toMatchObject({ addressed: false });
  });

  it('closes the window after 8 s', () => {
    const a = new Addressing();
    a.answered('deepak', 10_000, false);
    expect(a.decide(turn('deepak', 'And when does the crane get here?', 18_500))).toMatchObject({ addressed: false });
  });

  it('lets an acknowledgment through without spending the window, unless Remy asked something', () => {
    const a = new Addressing();
    a.answered('deepak', 10_000, false);
    expect(a.decide(turn('deepak', 'Okay.', 11_000))).toMatchObject({ addressed: false });
    expect(a.decide(turn('deepak', 'And the crane?', 13_000))).toMatchObject({ addressed: true, reason: 'follow-up' });

    a.answered('nora', 20_000, true);
    expect(a.decide(turn('nora', 'Yes.', 21_000))).toMatchObject({ addressed: true, reason: 'follow-up' });
  });

  it('leaves a line that names someone else to them', () => {
    const a = new Addressing();
    a.answered('deepak', 10_000, false);
    expect(a.decide(turn('deepak', 'Nora, can you send that to Tony?', 11_000), ['Nora', 'Tony'])).toMatchObject({ addressed: false });
  });

  it('closes a window when someone else asks the others something in between', () => {
    const rule = new Addressing(8000);
    rule.answered('deepak', 1000, false);
    // Chris cuts in, asking the room; Deepak's answer to Chris is not for Remy.
    expect(rule.decide({ identity: 'chris', text: 'Wait, over Thanksgiving? Who booked it over Thanksgiving?', startedAt: 1500, endedAt: 4500 })).toMatchObject({ addressed: false });
    expect(rule.decide({ identity: 'deepak', text: 'Uh... we did, apparently.', startedAt: 4800, endedAt: 6500 })).toMatchObject({ addressed: false });
    // A remark or a hum in between leaves it open.
    rule.answered('deepak', 10_000, false);
    expect(rule.decide({ identity: 'chris', text: 'Mm-hm.', startedAt: 10_500, endedAt: 11_000 })).toMatchObject({ addressed: false });
    expect(rule.decide({ identity: 'deepak', text: 'And the lift?', startedAt: 11_500, endedAt: 12_500 })).toMatchObject({ addressed: true, reason: 'follow-up' });
  });

  it('takes a remark after someone else started talking as theirs, even before their words are in', () => {
    const rule = new Addressing(8000);
    rule.answered('deepak', 1000, false);
    // Chris cuts in (his long turn is still being transcribed); Deepak's short reply to him is decided first.
    rule.heardSpeech('chris', 1500);
    expect(rule.decide({ identity: 'deepak', text: 'Uh, we did, apparently.', startedAt: 4800, endedAt: 6500 })).toMatchObject({ addressed: false });
    // A question still follows up with Remy.
    rule.answered('deepak', 10_000, false);
    rule.heardSpeech('chris', 10_500);
    expect(rule.decide({ identity: 'deepak', text: 'And when does the crane get here?', startedAt: 12_000, endedAt: 13_000 })).toMatchObject({ addressed: true, reason: 'follow-up' });
  });

  it('counts a cut-in that began just before the answer ended', () => {
    const a = new Addressing();
    a.answered('deepak', 10_000, false);
    expect(a.decide(turn('deepak', "Wait, that's the slab.", 9_800))).toMatchObject({ addressed: true, reason: 'follow-up' });
  });

  it('opens 8 s after a summons', () => {
    const a = new Addressing();
    expect(a.decide(turn('tony', 'Remy?', 0, 600))).toMatchObject({ addressed: true, summons: true });
    expect(a.decide(turn('tony', 'Can you check the crane booking?', 2000))).toMatchObject({ addressed: true, reason: 'summons' });
    expect(a.decide(turn('deepak', 'Remy. You on?', 10_000, 11_600))).toMatchObject({ addressed: true, summons: true });
    expect(a.decide(turn('deepak', "Okay, so, um... I was out all last week. What'd I miss that actually costs us money?", 12_400))).toMatchObject({ addressed: true, reason: 'summons' });
  });

  it('forgets a person who left', () => {
    const a = new Addressing();
    a.answered('deepak', 10_000, false);
    a.forget('deepak');
    expect(a.decide(turn('deepak', 'And the crane?', 11_000))).toMatchObject({ addressed: false });
  });
});

describe('Addressing: one person alone with Remy', () => {
  const turn = (identity: string, text: string, startedAt: number, endedAt = startedAt + 1500) => ({ identity, text, startedAt, endedAt });
  const alone = { alone: true };

  it('counts who else is on the call: nobody else is alone', () => {
    expect(aloneOnCall('ana', ['ana'])).toBe(true);
    expect(aloneOnCall('ana', ['ana', 'ben'])).toBe(false);
    expect(aloneOnCall('ana', ['ben'])).toBe(false);
    // Their last words can arrive just after they left: nobody else is there either.
    expect(aloneOnCall('ana', [])).toBe(true);
  });

  it('takes every line as for Remy, name or not, at any time', () => {
    const a = new Addressing();
    expect(a.decide(turn('ana', "What's the crane costing us while it waits?", 0), [], alone)).toEqual({ addressed: true, reason: 'alone', summons: false });
    expect(a.decide(turn('ana', 'And the footings?', 60_000), [], alone)).toEqual({ addressed: true, reason: 'alone', summons: false });
    expect(a.decide(turn('ana', 'Take me to the slab.', 600_000), [], alone)).toMatchObject({ addressed: true, reason: 'alone' });
  });

  it('still hears her name as her name, and a summons as a summons (nothing to answer yet)', () => {
    const a = new Addressing();
    expect(a.decide(turn('ana', 'Remy, what does the crane cost?', 0), [], alone)).toMatchObject({ addressed: true, reason: 'name', summons: false });
    expect(a.decide(turn('ana', 'Remy?', 5000, 5400), [], alone)).toMatchObject({ addressed: true, summons: true });
  });

  it('leaves a plain "okay" or "thanks" after her answer alone, and takes the next real line', () => {
    const a = new Addressing();
    a.answered('ana', 10_000, false);
    for (const text of ['Okay.', 'Thanks.', 'Got it, thanks.', 'Mm-hm.']) expect(a.decide(turn('ana', text, 11_000), [], alone), text).toMatchObject({ addressed: false });
    expect(a.decide(turn('ana', 'Okay.', 90_000), [], alone)).toMatchObject({ addressed: false });
    expect(a.decide(turn('ana', 'And when does the crane get here?', 95_000), [], alone)).toMatchObject({ addressed: true, reason: 'alone' });
  });

  it('takes a "yes" as the answer to a question she asked, up to 30 s later', () => {
    const a = new Addressing();
    a.answered('ana', 10_000, true);
    expect(a.decide(turn('ana', 'Yes.', 35_000), [], alone)).toMatchObject({ addressed: true, reason: 'follow-up' });
    // Only once: the question was answered.
    expect(a.decide(turn('ana', 'Yeah.', 37_000), [], alone)).toMatchObject({ addressed: false });
    a.answered('ana', 50_000, true);
    expect(a.decide(turn('ana', 'Sure.', 81_000), [], alone)).toMatchObject({ addressed: false });
  });

  it('waits a little for a line trailing off, name or not', () => {
    expect(mayContinue('So, um, the crane—', true)).toBe(true);
    expect(mayContinue('Can you check the', true)).toBe(true);
    expect(mayContinue('So, um, the crane—')).toBe(false);
    expect(mayContinue('What does the crane cost?', true)).toBe(false);
    expect(mayContinue('The crane?', true)).toBe(false);
  });

  it('follows people joining and leaving: the name is needed again with two on the call, and not once one leaves', () => {
    const a = new Addressing();
    const people = ['ana'];
    const decide = (identity: string, text: string, at: number) => a.decide(turn(identity, text, at), people.filter((id) => id !== identity).map((id) => id.toUpperCase()), { alone: aloneOnCall(identity, people) });

    expect(decide('ana', 'How is the crane rental looking?', 0)).toMatchObject({ addressed: true, reason: 'alone' });
    people.push('ben'); // Ben joins
    expect(decide('ana', 'Ben, can you hear me?', 20_000)).toMatchObject({ addressed: false });
    expect(decide('ben', 'Loud and clear. What about the footings?', 25_000)).toMatchObject({ addressed: false });
    expect(decide('ana', 'Remy, what do we owe on the footings?', 30_000)).toMatchObject({ addressed: true, reason: 'name' });
    people.splice(people.indexOf('ben'), 1); // Ben leaves
    expect(decide('ana', 'What happens if we wait till Friday?', 120_000)).toMatchObject({ addressed: true, reason: 'alone' });
    people.splice(0, people.length, 'ana', 'cy'); // Cy joins
    expect(decide('ana', 'What are the odds we make the handover?', 150_000)).toMatchObject({ addressed: false });
  });
});
