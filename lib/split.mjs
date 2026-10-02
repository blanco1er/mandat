// Split a bill fairly, to the cent, and explain it line by line.
// people: [{ name, amount?, payer? }] — amounts are optional (unequal splits); the rest is shared equally.
// items:  [{ name, amount }] — the bill's lines, when known.
const cents = (v) => Math.round(v * 100);
const euros = (c) => c / 100;

export function splitBill({ total, people, items = [] }) {
  const T = cents(total);
  if (!(T > 0)) throw new Error('The total must be above zero.');
  if (!people?.length) throw new Error('Nobody to split with.');
  people = equalisedAmounts(T, people);
  const fixed = people.filter((p) => p.amount > 0);
  const fixedC = fixed.reduce((t, p) => t + cents(p.amount), 0);
  if (fixedC > T) throw new Error('The amounts given are more than the total.');
  const free = people.filter((p) => !(p.amount > 0));
  if (!free.length && fixedC !== T) throw new Error('The amounts given do not add up to the total.');
  // Equal parts of what is left; leftover cents go to whoever paid the bill (or the first free person).
  const base = free.length ? Math.floor((T - fixedC) / free.length) : 0;
  let left = T - fixedC - base * free.length;
  const shares = people.map((p) => ({ name: p.name, payer: !!p.payer, c: p.amount > 0 ? cents(p.amount) : base }));
  const absorber = shares.find((s) => s.payer && !(people.find((p) => p.name === s.name)?.amount > 0)) || shares.find((s) => free.some((f) => f.name === s.name));
  const rounding = left ? { name: absorber.name, amount: euros(left) } : null;
  if (left) absorber.c += left;

  // The bill's lines; anything not itemised becomes "Rest of the bill".
  let lines = (items || []).filter((i) => i?.name && i.amount > 0).map((i) => ({ name: String(i.name).slice(0, 120), c: cents(i.amount) }));
  const sumItems = lines.reduce((t, i) => t + i.c, 0);
  if (sumItems > T) lines = [];
  if (lines.length && T - sumItems > 0) lines.push({ name: 'Rest of the bill', c: T - sumItems });
  if (!lines.length) lines = [{ name: null, c: T }];

  return {
    total: euros(T),
    equal: !fixed.length,
    rounding,
    people: shares.map((s) => ({
      name: s.name,
      payer: s.payer,
      amount: euros(s.c),
      // This person's part of each line, adjusted on the last line so it adds up exactly.
      lines: lines.map((l, i, all) => {
        const part = i < all.length - 1 ? Math.round((l.c * s.c) / T) : s.c - all.slice(0, -1).reduce((t, x) => t + Math.round((x.c * s.c) / T), 0);
        return { name: l.name, total: euros(l.c), share: euros(part) };
      }),
    })),
  };
}

// Amounts that are just the equal share (an agent often spells out "29.33 each") are treated as
// "share equally", so the rounding cent goes to whoever paid, as it should.
function equalisedAmounts(T, people) {
  const given = people.filter((p) => p.amount > 0);
  for (const g of given) {
    const v = cents(g.amount);
    const same = given.filter((x) => Math.abs(cents(x.amount) - v) <= 2);
    const others = given.filter((x) => !same.includes(x)).reduce((t, x) => t + cents(x.amount), 0);
    const n = same.length + people.filter((p) => !(p.amount > 0)).length;
    if (n > 1 && Math.abs((T - others) / n - v) <= 2) return people.map((p) => (same.includes(p) ? { ...p, amount: undefined } : p));
  }
  return people;
}
