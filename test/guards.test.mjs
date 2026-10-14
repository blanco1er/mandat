import test from 'node:test';
import assert from 'node:assert/strict';
import { textLang, minutesOf, otherTime, localCategory } from '../lib/guards.mjs';

test('language of the request, not of the phone', () => {
  assert.equal(textLang('My mum turns 60 on Saturday: dinner for 8 around 8pm, a cake and flowers. 400 € max.'), 'en');
  assert.equal(textLang('Dîner pour 8 samedi soir pour les 60 ans de ma mère, un gâteau et des fleurs, 400 € max'), 'fr');
  assert.equal(textLang('Lumière 400', 'fr'), 'fr');
});
test('times read the way people write them', () => {
  assert.equal(minutesOf('around 8pm'), 20 * 60);
  assert.equal(minutesOf('8:30 PM'), 20 * 60 + 30);
  assert.equal(minutesOf('Saturday 2026-10-17 at 20:00'), 20 * 60);
  assert.equal(minutesOf('20h30'), 20 * 60 + 30);
  assert.equal(minutesOf('19h'), 19 * 60);
  assert.equal(minutesOf('no time here, 8 people'), null);
});
test('a counter-time is a different time, not the same one written differently', () => {
  assert.equal(otherTime('dinner for 8 on Saturday at 20:00', '19:00'), true);
  assert.equal(otherTime('at 8pm', '20:00'), false);
  assert.equal(otherTime('at 8pm', '20:15'), false);
  assert.equal(otherTime('Saturday', '19:00'), false);
});
test('a cake or flowers come from a local merchant, objects can ship', () => {
  assert.equal(localCategory('chocolate birthday cake delivery Paris'), 'bakery');
  assert.equal(localCategory('bouquet of roses'), 'florist');
  assert.equal(localCategory('birthday cake candles'), null);
  assert.equal(localCategory('cake tin'), null);
  assert.equal(localCategory('rose perfume'), null);
  assert.equal(localCategory('unicorn plush toy'), null);
});
import { deliberates } from '../lib/guards.mjs';
test('thinking out loud is caught, a normal reply is not', () => {
  assert.equal(deliberates("€-11.40 overspend if we keep the large cake? Wait compute: currently committed full price: €296.40"), true);
  assert.equal(deliberates('Actually we had €13.60 left.'), true);
  assert.equal(deliberates('Booked at L’Ombre Rouge for 20:00, deposit €59.28 paid. Wait for the bakery to confirm, I will tell you.'), false);
});
import { otherTimesOffered } from '../lib/guards.mjs';
test('other times offered, in the slot or only in the reply', () => {
  assert.deepEqual(otherTimesOffered('a table for 8 at 20:00', 'Sorry, 20:00 is taken. We can offer 19:00, 19:30 or 21:15.', null), ['19:00', '19:30', '21:15']);
  assert.deepEqual(otherTimesOffered('a table for 8 at 20:00', 'Yes, 20:00 works.', '20:00'), []);
  assert.deepEqual(otherTimesOffered('a table for 8 at 8pm', 'We can do it', '19:30'), ['19:30']);
  assert.deepEqual(otherTimesOffered('a table for 8 at 8pm', 'Confirmed for 8pm, 10% off for the group.', null), []);
  assert.deepEqual(otherTimesOffered('a table for 8 at 20:00', 'Yes, 20:00 is available; the kitchen closes at 23:00.', null), []);
});
import { needsUser } from '../lib/guards.mjs';
test('after the opening, only real decisions reach the user', () => {
  assert.equal(needsUser('Cake flavour or any allergies? Chocolate, vanilla | Fruit tart, lemon | You decide'), false);
  assert.equal(needsUser('Bouquet style? Red roses, mixed seasonal | White lilies, pastel mix | You decide'), false);
  assert.equal(needsUser('The bakery can deliver at 17:30 instead. 17:30 works | Look elsewhere'), true);
  assert.equal(needsUser('Flowers would go over the budget. Small flower gesture (~€12) | Increase budget | Skip flowers'), true);
  assert.equal(needsUser('Shall I book Trattoria Verde? Yes, book it | No, look elsewhere'), true);
});
