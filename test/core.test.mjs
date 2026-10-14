// The parts that keep the money and the words right whatever the model says. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readyAnswers } from '../lib/answers.mjs';
import * as Env from '../lib/envelope.mjs';
import { splitBill } from '../lib/split.mjs';
import { nextDays } from '../lib/calendar.mjs';

test('ready answers: one ">>" line becomes buttons', () => {
  assert.deepEqual(readyAnswers('Shop or mobile mechanic?\n>> Drop off at a shop | Mobile mechanic | Either'), { text: 'Shop or mobile mechanic?', choices: ['Drop off at a shop', 'Mobile mechanic', 'Either'] });
});
test('ready answers: several ">>" lines (one per day, as Nemotron sometimes writes) never show as text', () => {
  const r = readyAnswers('Which day?\n>> Monday morning | Monday afternoon\n>> Tuesday morning | Tuesday afternoon\n>> Wednesday morning | Wednesday evening');
  assert.equal(r.text, 'Which day?');
  assert.deepEqual(r.choices, ['Monday morning', 'Monday afternoon']);
});
test('ready answers: ">>" inside a sentence is left alone, at most five buttons', () => {
  assert.deepEqual(readyAnswers('Booked. 5 >> 3.'), { text: 'Booked. 5 >> 3.', choices: [] });
  assert.equal(readyAnswers('Pick\n>> a|b|c|d|e|f|g').choices.length, 5);
});
test('envelope: never a cent over the mandate', () => {
  const env = Env.createEnvelope({ total: 150, approveAbove: 100 });
  Env.hold(env, { id: 'a', merchant: 'Cycles', label: 'Deposit', amount: 120 });
  assert.equal(Env.check(env, 31).ok, false);
  assert.equal(Env.check(env, 30).ok, true);
  assert.throws(() => Env.hold(env, { id: 'b', merchant: 'X', label: 'Too much', amount: 30.01 }));
  Env.release(env, 'a');
  assert.equal(Env.totals(env).remaining, 150);
  assert.equal(Env.check(env, 101).needsApproval, true);
});
test('split: shares add up to the cent', () => {
  const r = splitBill({ total: 100, people: [{ name: 'Ana', payer: true }, { name: 'Ben' }, { name: 'Cy' }] });
  assert.equal(Math.round(r.people.reduce((t, p) => t + p.amount, 0) * 100), 10000);
});
test('calendar: fifteen exact days starting today', () => {
  const days = nextDays('Europe/Paris').split('; ');
  assert.equal(days.length, 15);
  assert.match(days[0], /^today (Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{4}-\d\d-\d\d$/);
});
