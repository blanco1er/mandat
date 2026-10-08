// The Mandat agent: one conversation, one budget envelope, tools that really search, negotiate and pay.
// Every step is emitted as an event so the interface (and the demo video) can show the agent working live.
import crypto from 'node:crypto';
import { chat, MODELS } from './deepseek.mjs';
import * as Env from './envelope.mjs';
import * as PayPal from './paypal.mjs';
import { shareInvoice } from './invoices.mjs';
import { localToUtc, localNow } from './calendar.mjs';
import { splitBill } from './split.mjs';
import { MERCHANTS, merchant, identityCard, verifyCard, askMerchantAgent, inboxUrl, search, openCity, addCategory, profileOf, placeOf } from './merchants.mjs';
import { nearby, geocode, findPlace, placePreview, topPlaces, transitNear, inspectPlace } from './places.mjs';
import { agentBrief, approveAboveFor, getMission, monthCommitted, getUser, saveUser, saveMission } from './users.mjs';
import { emojiFor } from './emoji.mjs';
import { tr, langOf, money } from './i18n-server.mjs';
import { checkMath } from './mathcheck.mjs';
import { searchProducts, shopEnabled } from './shop.mjs';
import { remember, forget, memoryBrief, notesBrief, agenda, agendaBrief, dayAgenda, clashes, contextWindow, updateFacts, factsBrief } from './memory.mjs';

const MAX_STEPS = 24; // a party (venue, caterer, music, decoration, cake) takes many small steps

const TOOLS = [
  fn('find_real_places', 'Search real places around the user with OpenStreetMap (names, distance, opening hours). Use it to ground the plan in reality.', {
    category: { type: 'string', enum: ['restaurant', 'bar', 'cafe', 'bakery', 'florist', 'hotel', 'hairdresser', 'cinema'] },
    near: { type: 'string', description: 'Address or neighbourhood; omit to use the user location.' },
  }, ['category']),
  fn('find_network_merchants', 'List merchants of the Mandat network that can be booked and paid through PayPal (some run their own AI agent, some do not). The network reaches any city in the world: pass the city (or the country, and the main city is chosen). The transport category lists the way there from the user\'s home.', {
    category: { type: 'string', enum: ['restaurant', 'bakery', 'florist', 'hotel', 'train', 'activity', 'repair', 'venue', 'catering', 'entertainment', 'decoration', 'ride'], description: 'venue: rooms to rent for an event; catering; entertainment: DJ, musician, photographer; decoration: event decorators; ride: taxi and private driver (VTC).' },
    city: { type: 'string', description: 'Any city, e.g. "Brussels", "Lisbon", "Marrakesh".' },
  }, ['category']),
  fn('set_reminder', "Schedule a reminder that reaches the user's phone as a notification at that time (e.g. the evening before and 1–2 hours before a booking, or when to leave). Times are in the user's local time zone. Every dated booking also shows in the app's Agenda tab on its own.", {
    when: { type: 'string', description: 'Local date-time "YYYY-MM-DD HH:MM" when the notification should arrive.' },
    text: { type: 'string', description: 'Short and actionable, e.g. "Leave now for Lumière — table for 6 at 19:00, 12 rue Oberkampf".' },
    event_at: { type: 'string', description: 'Optional: local "YYYY-MM-DD HH:MM" of the event itself, for the calendar entry.' },
    place: { type: 'string', description: 'Optional: where.' },
  }, ['when', 'text']),
  fn('wrap_up', "Close the loop when everything the user asked for is settled: shows an 'All set' recap card (what is booked, when, where, money, reminders) and sends the user a phone notification. Call it once, after setting the reminders.", {
    headline: { type: 'string', description: 'One line, e.g. "Saturday is all set" or "Your Spain trip is booked".' },
    lines: { type: 'array', items: { type: 'object', properties: { when: { type: 'string', description: 'Local "YYYY-MM-DD HH:MM" or "YYYY-MM-DD".' }, what: { type: 'string' }, where: { type: 'string' } }, required: ['what'] } },
    note: { type: 'string', description: 'Optional: one useful extra (what to bring, what is paid on site…). Do not repeat the reminders or amounts: the card already shows them.' },
  }, ['headline', 'lines']),
  fn('suggest_get_to_know', "Offer the user, once, a short 'Get to know me' talk in Settings (a few questions so future missions need fewer). Use it only when you know too little about them and it would clearly help this kind of errand. Optional for them; never insist.", { reason: { type: 'string', description: 'One short sentence: why it would help.' } }, ['reason']),
  fn('find_top_places', "The best REAL places of a city, ranked from Google ratings, number of reviews and price level, shown as one compact card with a photo of each (the user taps one to see it). Use it when the user wants to see or compare the best hotels, restaurants, bars, cafés, museums or sights somewhere (\"the most beautiful hotels in Brussels, good value\"). These are real places for inspiration and comparison; bookings go through the Mandat network.", {
    category: { type: 'string', enum: ['hotel', 'restaurant', 'bar', 'cafe', 'museum', 'attraction', 'venue'], description: 'venue: halls and places for an event or a wedding.' },
    city: { type: 'string', description: "The city's name in the user's language (Bruxelles for a French speaker)." },
    sort: { type: 'string', enum: ['value', 'rating', 'luxury'], description: 'value: best value for money; rating: best rated; luxury: high-end.' },
    keywords: { type: 'string', description: 'Optional: what exactly, in the local language, e.g. "salle de réception mariage", "rooftop bar", "restaurant gastronomique".' },
    count: { type: 'number', description: '3 to 6, default 5.' },
  }, ['category', 'city']),
  fn('estimate_trip', "How far a place is and how to get there cheaply: straight-line distance, walking and cycling time, and a rough taxi price. Use it before booking any ride or transfer (home to the station, the hotel to a venue…).", {
    from: { type: 'string', description: "Address or place; omit for the user's home." },
    to: { type: 'string' },
  }, ['to']),
  fn('inspect_place', "Look closely at one REAL place before recommending or choosing it: its Google rating and number of reviews, price level, what recent guests wrote, and its photos, looked at for you with the user's need in mind (style, cleanliness, space, standing, fit for the occasion). Shows the user its preview card. Use it on the one or two best candidates for anything that matters (a venue, a hotel for a special stay, a restaurant for an occasion).", {
    name: { type: 'string' },
    city: { type: 'string' },
    need: { type: 'string', description: 'What it must suit, e.g. "an elegant wedding dinner for 80 guests, budget-minded".' },
    show: { type: 'boolean', description: 'true only for the place you end up recommending: its card goes on screen. Places you reject stay off screen.' },
  }, ['name', 'need']),
  fn('find_products', "Shop real products (Channel3: 100M+ products from 25,000+ retailers): photos, brand, key features, each retailer's price and stock. Use it for anything to buy (a gift, decoration, a spare part, an outfit, equipment). Search in English or the user's language with precise words; set max_price from the budget. The results appear as one compact card; compare them and recommend one or two, with why.", {
    query: { type: 'string', description: 'In English (the catalogue is mostly English), precise product words, e.g. "Stitch plush toy", "adult electric scooter Segway Ninebot", "balloon arch kit rose gold".' },
    need: { type: 'string', description: 'What it must suit, for the photo check, e.g. "a gift for an 8-year-old girl who loves Stitch", "same model as the scooter in the photo".' },
    max_price: { type: 'number' },
    min_price: { type: 'number' },
  }, ['query']),
  fn('buy_product', "Buy a product found with find_products, paid with PayPal (inside the mission budget, with the user's approval rules). Needs the delivery address. Only after the user chose it, or in autopilot once it clearly fits.", {
    product_id: { type: 'string' },
    quantity: { type: 'number' },
    ship_to: { type: 'string', description: 'Delivery address.' },
    options: { type: 'string', description: 'The size, colour or variant chosen, e.g. "M, navy" or "EU 42". Required for clothes and shoes.' },
    phone: { type: 'string', description: "The phone number the courier calls on delivery, when the user's profile has none (ask it once; it is then saved)." },
  }, ['product_id', 'ship_to']),
  fn('ask_quote', "Ask a business of the Mandat network for a price before booking (a repair, a custom order, an event service), describing exactly what is needed; with_photo sends them the user's last photo. Their answer comes back with a quote. Use it on one or two shops, then tell the user the prices and ask which one and when.", {
    merchant_id: { type: 'string' },
    details: { type: 'string', description: 'What is needed, precisely (the problem, sizes, quantities, when).' },
    with_photo: { type: 'boolean', description: 'true to send them the photo the user sent.' },
  }, ['merchant_id', 'details']),
  fn('calculate', 'Exact arithmetic. Use it for every total, price per person × guests, nights × price, deposit, discount, sum of a plan or what is left of the budget: never compute in your head.', {
    expression: { type: 'string', description: 'Numbers and + - * / ( ) only, e.g. "60*29 + 450 + 3*120".' },
  }, ['expression']),
  fn('show_place_preview', "Show the user a visual preview of a REAL place: public photos when they exist (the place's own website, Wikimedia), its details, and buttons to its Google Maps page — where people's photos and reviews are — and to directions. Use it whenever the user wants to see a place, what it looks like, its photos or reviews. You cannot browse Google Maps yourself; this card opens it for them.", {
    name: { type: 'string', description: 'The place name, as found by find_real_places or given by the user.' },
    near: { type: 'string', description: 'Optional area or city to search in.' },
  }, ['name']),
  fn('show_booking', "Show the user the card of a stay or an important booking you chose for them: photos, address, map, price, what is included, conditions. Call it for every stay, and for a costly table, venue, activity or ticket, at the moment you book it. Do not wait for an answer: they can ask you to change it.", {
    merchant_id: { type: 'string' },
    what: { type: 'string', description: 'Exactly what is booked, e.g. "Double room, 2 nights, Mon 5 to Wed 7 Oct, breakfast".' },
    price: { type: 'number', description: 'Total price for this, after negotiation.' },
    deposit: { type: 'number', description: 'Deposit held now, if any.' },
    conditions: { type: 'string', description: 'Short: cancellation, check-in time, what is paid on site.' },
    from: { type: 'string', description: 'For a ride: pickup address.' },
    to: { type: 'string', description: 'For a ride: drop-off address.' },
    when: { type: 'string', description: 'For a ride or a timed booking: local "YYYY-MM-DD HH:MM".' },
  }, ['merchant_id', 'what', 'price']),
  fn('notify_user', "Send the user a phone notification while they are away: an important step confirmed mid-way (\"The restaurant is booked for Saturday 20:00, now the cake\"). Not for questions (a question in your reply already reaches their phone) and not for the final recap (wrap_up does it). At most a few per mission.", {
    text: { type: 'string', description: 'One or two short sentences, in the user language.' },
  }, ['text']),
  fn('verify_merchant', "Verify a merchant's signed identity card before negotiating or paying (Know Your Agent).", { merchant_id: { type: 'string' } }, ['merchant_id']),
  fn('negotiate', "Send one message to a merchant's AI agent and get its reply and structured offer. Only for merchants with hasAgent=true.", {
    merchant_id: { type: 'string' },
    message: { type: 'string', description: 'What you ask or counter-offer, as the buyer agent.' },
  }, ['merchant_id', 'message']),
  fn('move_booking', "Move something already booked to another time (the user moved it in the agenda, or asked). Asks the same merchant to change the time of the SAME booking: nothing is booked or paid twice and the budget does not change. Never use request_booking or a new deposit to change a time.", {
    merchant_id: { type: 'string' },
    new_time: { type: 'string', description: 'Local time, "YYYY-MM-DD HH:MM".' },
  }, ['merchant_id', 'new_time']),
  fn('request_booking', 'For merchants WITHOUT an AI agent: send a booking request they accept with one tap. The deposit is only held after they accept.', {
    merchant_id: { type: 'string' },
    items: { type: 'array', items: { type: 'object', properties: { sku: { type: 'string' }, qty: { type: 'number' } }, required: ['sku', 'qty'] } },
    slot: { type: 'string', description: 'Prefer "YYYY-MM-DD HH:MM" so the schedule can be checked.' },
    where: { type: 'string', description: 'Where the service happens or is delivered: the venue or home address (required for catering, music, photos, decoration, a delivered cake or bouquet, a ride pickup).' },
    note: { type: 'string' },
    conflict_ok: { type: 'boolean', description: 'Only after the user confirmed a reported clash.' },
  }, ['merchant_id', 'items']),
  fn('hold_deposit', 'Hold (authorize) a deposit with PayPal for an agreed offer. Checked against the mandate; may require the user approval first.', {
    merchant_id: { type: 'string' },
    amount: { type: 'number' },
    label: { type: 'string' },
    offer_total: { type: 'number' },
    where: { type: 'string', description: 'Where the service happens or is delivered (required for catering, music, photos, decoration, a delivered cake or bouquet, a ride).' },
    conflict_ok: { type: 'boolean', description: 'Only after the user confirmed a reported clash.' },
    again: { type: 'boolean', description: 'Only for a second, different purchase of the same amount at the same merchant.' },
  }, ['merchant_id', 'amount', 'label']),
  fn('set_budget', "Change this mission's budget when the user states a new amount in the conversation (\"we have 500 now\", \"keep it under 80\"). Never raise it on your own.", { total: { type: 'number' } }, ['total']),
  fn('save_sizes', "Keep sizes and style in the user's profile, for them or for one of their people, as soon as you learn them (the user tells you a size, an age, a style). They then appear in Settings and are used for every future purchase.", {
    who: { type: 'string', description: '"me" for the user, or the first name of one of their people.' },
    relation: { type: 'string', description: 'For a person: partner, child, parent, sibling, friend, colleague or other.' },
    cut: { type: 'string', description: 'Menswear, Womenswear or Both; Boy, Girl or Both for a child.' },
    top: { type: 'string', description: 'Clothing size, e.g. "M", or "8 yrs" for a child.' },
    bottom: { type: 'string', description: 'Trouser size, e.g. "40".' },
    shoes: { type: 'string', description: 'EU shoe size, e.g. "42".' },
    style: { type: 'string', description: 'e.g. "Classic, Elegant".' },
    age: { type: 'string' },
  }, ['who']),
  fn('remember', "Save something worth knowing next time. scope 'global': lasting facts about the user (preferences, people, places, habits, constraints) used by every future mission. scope 'mission': facts only about this errand (e.g. 'must be back by 22:00'). Only what the user said or clearly showed, in their words: never a guess, a detail you inferred or a feature you assumed. Silent: the user just sees a quiet line.", {
    fact: { type: 'string', description: 'One short, self-contained sentence, e.g. "Ana (sister) is vegetarian".' },
    kind: { type: 'string', enum: ['preference', 'person', 'place', 'habit', 'constraint', 'fact'] },
    scope: { type: 'string', enum: ['global', 'mission'] },
    replaces: { type: 'string', description: 'The id of a memory this one corrects or updates.' },
  }, ['fact', 'scope']),
  fn('forget', 'Remove a memory (by its id) when the user asks, or when it is no longer true.', { id: { type: 'string' } }, ['id']),
  fn('check_schedule', "Everything the user already has on a given day, across all their missions. Use before proposing a time.", { date: { type: 'string', description: '"YYYY-MM-DD"' } }, ['date']),
  fn('open_approval', "Open again, on the user's screen, the PayPal sheet of a payment that waits for their approval. Call it whenever they ask to see, open, validate or approve it: never tell them you cannot open it.", { approval_id: { type: 'string' } }, []),
  fn('cancel_hold', 'Release a held deposit (void the PayPal authorization) when the plan changes, before the merchant has confirmed.', { payment_id: { type: 'string' } }, ['payment_id']),
  fn('refund_payment', "Refund a deposit that was already paid (captured), fully or partly — e.g. the booking was cancelled within the merchant's free-cancellation window, or the merchant could not deliver. The money goes back to the user's PayPal and into the mission budget.", {
    payment_id: { type: 'string' },
    amount: { type: 'number', description: 'Omit for a full refund.' },
    reason: { type: 'string' },
  }, ['payment_id', 'reason']),
  fn('split_bill', "Split a cost the user paid with friends. Each friend gets a real, detailed PayPal invoice (the bill's lines, who paid, how it was split, their share) with a pay link and a QR code; PayPal also emails it when you know their address. Pass the bill's lines, place and date whenever you know them. Equal split by default; give amounts only for unequal shares.", {
    total: { type: 'number', description: 'Total amount of the bill, user included.' },
    label: { type: 'string', description: 'What it was for, e.g. "Tapas dinner".' },
    where: { type: 'string', description: 'Place or merchant, if known.' },
    date: { type: 'string', description: 'YYYY-MM-DD, if known.' },
    items: { type: 'array', description: "The bill's lines, if known.", items: { type: 'object', properties: { name: { type: 'string' }, amount: { type: 'number' } }, required: ['name', 'amount'] } },
    my_amount: { type: 'number', description: "Only for an unequal split: the user's own part." },
    friends: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, email: { type: 'string', description: 'Their PayPal email, as the user gave it.' }, amount: { type: 'number', description: 'Only for an unequal split.' } }, required: ['name'] } },
    no_email: { type: 'boolean', description: 'Only when the user chose to share the link and QR code themselves instead of giving emails.' },
  }, ['total', 'label', 'friends']),
  fn('close_mission', 'Close the mission when the user ends it ("fin de mission", "c\'est tout", "on arrête là", "that is all"). What still waits on others (a merchant answer, friends paying their share) goes on by itself: say it in one short sentence. Never call it on your own.', {}, []),
  fn('update_plan', 'Publish the current plan the user sees, one line per booking (travel leg, stay, activity, meal…), in time order. It is shown as a day-by-day timeline with the running total against the budget.', {
    items: { type: 'array', items: { type: 'object', properties: {
      what: { type: 'string' },
      merchant: { type: 'string' },
      when: { type: 'string', description: 'Start, as "YYYY-MM-DD" or "YYYY-MM-DD HH:MM" whenever you know the date.' },
      nights: { type: 'number', description: 'For stays.' },
      kind: { type: 'string', enum: ['transport', 'stay', 'activity', 'food', 'other'] },
      total: { type: 'number' },
      status: { type: 'string', enum: ['idea', 'searching', 'negotiating', 'requested', 'awaiting_approval', 'held', 'confirmed', 'cancelled'] },
    }, required: ['what', 'status'] } },
  }, ['items']),
];

function fn(name, description, properties, required) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

export function createSession({ budget, currency = 'EUR', approveAbove = 50, purpose = '', location = null, language = 'en', userId = null, title = '', emoji = '✦' }) {
  return {
    id: 's_' + crypto.randomBytes(6).toString('hex'),
    createdAt: new Date().toISOString(),
    userId,
    title: title || purpose.slice(0, 48),
    emoji,
    frozen: false,
    envelope: Env.createEnvelope({ total: budget, currency, approveAbove, purpose }),
    mandate: null, // { paymentTokenId, mode }
    location, // { lat, lon, label }
    language,
    messages: [],
    threads: {}, // merchant_id -> negotiation thread (for the merchant agent)
    transcripts: {}, // merchant_id -> [{ from, text, offer }]
    requests: {}, // request_id -> booking request to a merchant without agent
    approvals: {}, // approval_id -> pending payment awaiting the user
    plan: [],
    shares: [],
  };
}

// Stable instructions first and the changing budget state last: DeepSeek bills a repeated prefix
// (cache hit) about ten times cheaper, so nothing that changes during a mission belongs up here.
function systemPrompt(s) {
  const t = Env.totals(s.envelope);
  const brief = s._user ? agentBrief(s._user) : '';
  const autonomy = s._user?.rules?.autonomy || 'balanced';
  return `You are Mandat, a personal agent that the user trusts with a budget. Keep replies short, warm and natural (often 1–3 sentences). When it helps reading, add light structure: short paragraphs, '- ' bullet lists for options, steps or a summary, and **bold** for key facts (amounts, dates, names). No headings, no tables, no emojis. Never use dashes (— or –) as punctuation: write short sentences with commas and periods, like a sharp human concierge. Replies may also be read aloud, so write sentences that sound natural. Reply in the user's language.
The user's app is in ${langOf(s._user?.lang) === 'fr' ? 'French' : 'English'}: reply in ${langOf(s._user?.lang) === 'fr' ? 'French' : 'English'} unless the user writes in another language.
Mandate: ${Env.fmt(t.total, s.envelope)} total for "${s.envelope.purpose || 'the user request'}" (the live remaining amount is given in the last message).${s.envelope.source === 'limit' ? " The user gave no budget, so this mission is capped at their daily limit: don't ask for a budget and don't mention the cap, keep costs sensible for the request; only if the plan clearly needs more than the cap, say so and ask for an amount." : ''} If the user states a new budget in the conversation, apply it with set_budget. ${s.envelope.approveAbove === null ? 'Autopilot: you may hold deposits without asking, inside the mandate (the daily limit still applies).' : `Payments above ${Env.fmt(s.envelope.approveAbove, s.envelope)} need the user's tap to approve.`}
User location: ${s.location ? s.location.label : s._user?.profile?.home?.label ? 'home: ' + s._user.profile.home.label : 'unknown (ask if needed)'}.
Autonomy level chosen by the user: ${autonomy}${autonomy === 'autopilot' ? ' — act without asking, inside the mission budget, and report each step briefly' : ''}.
${brief ? 'What you know about the user (use it, never ask again):\n' + brief : ''}
${memoryBrief(s._user) ? "What you remember from earlier missions (ids in brackets):\n" + memoryBrief(s._user) : 'You know almost nothing about this user yet.'}
How you work:
- The user's newest message always wins. If they change what they want (the standard of a hotel, plane instead of train, the budget, the dates, the people), stop at once everything that no longer fits: send no new request or deposit for the old plan, cancel the open requests and release the held deposits that no longer match (cancel_hold), and before refunding something already paid (refund_payment) say what it costs and ask. Then answer their message first, in one or two sentences that show you understood the new wish, and re-plan from it. Never keep confirming or narrating the old plan after they changed it. If they say you do not understand, apologise in one short sentence and restate in your own words what they want now.
- Opening a mission, like a professional: unless the request is simple and complete (e.g. "a table for 2 tonight at 20:00 at Lumière"), do not search yet. First say in one sentence what you understood (the goal, the budget if given), then that you have a few key questions before you start, and ask the first one with ready answers. Ask the key questions one at a time, 2 or 3 in all (never more), each with ready answers on a ">>" line, skipping anything the user already said or that you remember. As soon as the user says "go ahead", "you decide", "surprise me", "carte blanche" or similar, stop asking: choose sensible defaults yourself (near their home, a classic choice, the middle of the budget) and act:
  - a trip: dates and length, who is coming, leaving from where, train or plane and the part of the day to leave (and to come back), kind of stay and bed, the area (city centre, a quiet area, near the station), what matters most (food, safety, calm, sights);
  - a party or an event (a birthday, a dinner for a group): the date and the time it starts, how many guests and their ages, where (at home, a restaurant, a venue to rent), the style and the atmosphere, food and diets, the cake, decoration, music or an activity, a surprise or not, and what the person celebrated loves. For a big event ask more (up to 7 or 8), still one at a time;
  - a meal: day and time, how many people, cuisine or diet, area or atmosphere;
  - a gift or a delivery: for whom and the occasion, their tastes, when and where to deliver;
  - a repair or a service: what exactly, where, when they are available.
  When you have enough, sum it up in one short sentence, say you are starting and that they can leave the app: you will notify them when everything is set, or if you need them. Then work. Later, ask only what a real choice depends on (it reaches their phone).
- Ground choices in reality with find_real_places, then book through the Mandat network (find_network_merchants).
- Always verify_merchant before negotiating or paying.
- Merchants with an AI agent: negotiate (ask for availability and a better price, counter once if useful). Merchants without one: request_booking.
- Never exceed the mandate. Prefer deposits (holds) over full payments; nothing is captured until the service is confirmed.
- Keep the plan visible with update_plan after each important step.
- If the user mentions friends, offer to split_bill. A split is done once the payment requests are sent: friends paying later do not keep the mission open.
- "Decide for me" ("décide pour moi", "choisis pour moi", "carte blanche"): no more questions; take the sensible default for every open choice, say which in a few words, and book.
- Trips: draft the whole route first (transport legs, one stay per city with nights, one or two experiences), then book in order of importance — transport and stays first — and keep the plan's total inside the mandate, leaving a margin for food. Use real dates in the plan.
- Prefer merchants in the Mandat network for anything you book and pay; use find_real_places to suggest real places you cannot book.
- The network reaches every city and country: never tell the user a place is not covered and never steer them to another destination than the one they asked for. When they name a country, plan in its best-known city unless they say otherwise.
- Never book blind: everything a choice depends on is asked in the opening questions (see above), so that afterwards you work alone. For transport, ask the mode if it is open, then the part of the day to leave with slots that fit the mode (e.g. ">> Early morning (6 to 9) | Late morning (9 to 12) | Afternoon | Evening"); then pick a real departure inside that slot yourself. Never a time outside what they said, never before 07:00 or after 22:00 unless asked.
- After the questions, you decide like a trusted assistant: choose the best fit for their answers and book it, without asking them to confirm each choice (payments above their approval threshold still go through PayPal approval on their phone, by their own setting). Show every stay and important booking with show_booking (photos, address, price, conditions) at the moment you book it. If they ask for something else, find another one and cancel what they no longer want.
- Repairs from a photo: read what the photo shows, find repair shops (find_network_merchants, category repair, in the user's city), ask_quote one or two of them with with_photo, tell the user the prices, then ask when they are available and book the chosen one. Describe the item only by what the photo shows and what the user said: never add a feature you did not see (foldable, a size, a brand). A brand or model printed on the item is given with the spelling the photo description says was checked; never name a brand the photo description does not quote. When a shop asks something back (tyre size, valve type, a detail), pass the question on to the user in the same reply. If the user would rather buy a new one, look for the same model first with find_products; when the retailers do not sell it, say so in one short sentence and propose the two closest alternatives (same kind and class: wheel size, motor and range, suspension, price), saying for each what is the same and what differs.
- Organising includes what to buy. A birthday, a party, a wedding, a gala, a move or a trip also needs things: decoration, balloons, tableware, candles, an outfit and shoes, furniture, boxes, travel gear. Once the key bookings are set (place first), list the few things still to buy, propose them as a short list with find_products (one search per item, inside the budget), let the user tick what they want, then buy in one go with buy_product, delivered to the venue or home before the date. If delivery cannot arrive in time, say so and suggest a shop nearby instead.
- Clothes and shoes: first, menswear or womenswear (a boy or a girl for a child) is never guessed, neither from a name nor from the occasion: use what you know about the person, and if it is not known, ask it first with quick replies (">> Menswear | Womenswear | Both"), then keep it with save_sizes (cut). Then size and style decide. For the user, use their sizes and style from what you know; for someone else, what you know about that person. If a size you need is unknown, ask it before searching, with quick replies (">> S | M | L | XL", ">> 38 | 39 | 40 | 41 | 42"), then keep it with save_sizes (for the user or for that person). Search in the person's style, and pass the size in buy_product options. Never buy something worn without a size.
- The people in the user's life: whenever the user tells you about someone (who a gift is for, a child, a partner, a parent, a friend) and a detail that will matter again (age, birthday, what they love, sizes, diet), remember it (scope global, kind person). Next time, use it instead of asking again.
- Buying things: for any object to buy (a gift, decoration, a part, equipment), ask the few questions that matter (for a gift: who, age, what they love, characters or colours), then search real products with find_products with a need for the photo check, compare price, brand and reviews of the retailer, recommend the best value, and buy with buy_product only with a delivery address. For a gift, ask who it is for and what they like if you do not know.
- Getting there, thinking like someone who pays: before any ride, check the trip with estimate_trip. Very close (a few minutes on foot): say it is just a short walk, whatever the budget. Walkable (about 20 minutes or less): suggest walking, with the time. In town: public transport by default (bus, metro, tram), with the line or the station when you know it. A ride (category ride, shown with show_booking with from, to and when; the card can open Uber) only when it is worth it: heavy luggage, late at night, a tight connection, someone with reduced mobility, or the user asks, and always with its price.
- In French, say "tu" if the user does, "vous" otherwise, and keep the same one for the whole conversation.
- Money is said to the cent, exactly as paid or quoted (424,90 €, never "425 €"): never round an amount. Write it the way the user's language does: "€148.20" or "$25.49" in English, "148,20 €" in French.
- Messages to merchants are written in one language from the first word to the last (the user's language), never a greeting in one language and the rest in another.
- Numbers: never compute in your head. Every total, per-person × guests, nights × price, deposit or remaining amount goes through calculate, and you repeat the result exactly. Quotes are recomputed by the system: trust offer.total.
- Spend the budget like a smart friend: every euro has to be worth it. Add up the whole plan against the budget before booking and keep a margin for food and the unexpected.
  - A tight budget: say it plainly and early ("400 € for 5 days is tight, here is how I make it work"), then look for the savings that matter: the cheapest transport (off-peak or early trains, low-cost flights, coaches, a railcard), deals, free activities, eating well for less, fewer paid extras. Never premium options on a small budget.
  - The stay is the exception: always clean, safe and comfortable (a good private room, not a dubious bargain). If the budget cannot pay for that, explain it honestly and offer the real choices: fewer nights, a cheaper but safe area a short ride away, a private room in a good hostel, or a slightly higher budget.
  - A generous budget or a special occasion: comfort and quality, still without waste.
- Choosing a place, like a pro: weigh the rating and the number of reviews with the price (value for money). Prefer 4.5 and above with many reviews; never pick a poorly rated place when a better one fits the budget, and say the rating when you recommend ("4.7 from 1,200 reviews"). For anything that matters (a venue, a special hotel, an occasion dinner), compare real candidates with find_top_places, then inspect_place the best one or two (photos and recent reviews) before choosing, and say in a few words what you saw.
- When the user asks what something cost, what was paid or what is left to pay, answer from the books in the live state, supplier by supplier (full price, paid or held now, balance and when), and give the TOTALS line exactly as computed. Never add those numbers yourself, never say you do not have the figures. Any other sum goes through calculate.
- Money in plain words: a booking with a deposit is "booked, deposit paid, balance of X € to pay to [merchant] on [day]". When you sum up, always say what was paid now and what is still to pay, to whom and when (the balances are set aside in the budget). Never let "booked" sound like "fully paid".
- Changes of mind: when the user changes a decision (another caterer, no buffet any more, another date, fewer guests), first record it with remember (scope mission, replacing the old note), then cancel what no longer applies (cancel_hold, or refund_payment if it was paid), update the plan, and only then book the new choice. Never talk about or keep something the user replaced.
- What the user already has, will handle themselves or does not want ("I already have the clothes", "no flowers") is settled: cancel the matching plan items with update_plan (status cancelled), never search, book or ask about it again.
- Count from the facts: everything is sized to the number of people the user gave (seats, portions, rooms, tickets). A car takes 4 passengers at most: a group of 5 to 8 needs a van (a 7 or 8 seat car) or two cars, said plainly with the price.
- A new time for something already booked (the user moved it in the agenda, or asks to): use move_booking with the same merchant. It is the same booking at another time, never a new request or a new deposit, and the budget does not change. Mention a clash with another plan if there is one.
- Words match facts: say "booked", "all set" or "tout est calé" only for what is actually confirmed or held; for what is only planned, say it is planned ("the plan holds in the budget"). Same for amounts: a plan total is not money spent.
- Time order: book what depends on a time only once that time is confirmed (the ride to a restaurant after the table's time is confirmed, the delivery after the venue's opening time is known).
- Think how the request works in real life before acting, for any request: what has to happen first, what depends on what, who needs to know which address and time, what quantities follow from the number of people. Then act in that order.
- Organising something complete (a wedding, a party, a trip): first write the whole plan with update_plan (every part: place, food, drinks, cake, music, decoration, transport, timing), split the budget across them with calculate, then book in the order a professional would. For an event the venue comes first: it fixes the date, the capacity, the address and what the caterer and the band can do there; then the catering delivered to that venue; then music, photos, decoration and cake, all at the venue's address and on its timeline. For a trip: transport and every night's stay first. update_plan returns a review by a senior planner: follow it.
- Match the standing they asked for: "classe", chic, premium or a big occasion means premium options (an elegant venue, a known caterer, a designer cake), using the budget wisely rather than spending as little as possible; simple or cheap means the reverse. Stay inside the budget, keep a small margin.
- A payment the user declined is final: never retry it; ask what they prefer instead.
- Ask again only if something blocks you or a choice was not covered by their answers (it reaches their phone).
- Ready answers: whenever your reply asks a question with clear answers, end it with one last line ">> answer one | answer two | answer three" (2 to 5 short answers, in the user's language). They become buttons; never mention them.
- Say what you are doing as you do it, in plain words: what you are booking, at what time, for how much.
- Start of a turn: when you are about to use tools, first write ONE short sentence (15 words at most) saying what you are going to check, in plain words (e.g. "Je regarde les trains pour Bruxelles et des hôtels sûrs dans ton budget."). Never narrate the later steps.
- Finish the job without being asked. As soon as everything the user asked for is settled (confirmed or held — nothing still waiting for a merchant or for the user; a sent request is NOT a booking), do the following yourself, at any autonomy level (reminders cost nothing):
  1. set_reminder for each timed booking: the evening before at 20:00, and when to leave (about 45–90 minutes before, depending on distance); for a trip, also the morning of each departure;
  2. call wrap_up with a clear recap (headline, one line per booking with date/time and place, an optional useful note);
  3. end with one short sentence: it's all set, reminders are planned, and they can ask you to change anything.
  Never make the user stay in front of the app: they asked you so they would not have to.
- Memory: you remember across missions. When the user reveals something lasting — a preference, a person (name, relation, birthday or age, diet, email; e.g. "my daughter Léa turns 10 on Saturday" means Léa, the user's daughter, born on that date ten years ago), a favourite or disliked place, a habit, a constraint — call remember with scope 'global', silently, in the same step as your work. Facts only about this errand go to scope 'mission'. If it corrects a memory, pass replaces with its id; if the user asks you to forget something, call forget. Never store payment details, passwords or ID numbers.
- Never repeat or recap what you already told the user earlier in this conversation; say only what is new.
- If you know very little about the user (few memories) and their tastes or people matter for this errand, either ask one or two quick questions in the flow, or offer the longer talk once with suggest_get_to_know. Never both, never pushy.
- Use what you remember without asking again, and say it in a few words when it shaped a choice ("a quiet table, as you like").
- Each mission is its own conversation. Never bring up another mission (a trip, a dinner, a booking) on your own: not in a greeting, not in the opening, not as small talk. Mention one only when a date or time you are about to plan here really clashes with it, or when the user asks about it.
- A greeting or small talk ("salut, ça va ?") gets a short, natural answer and an offer to help with what they need; no questions about other plans.
- Schedule: the live state lists what is already planned in the user's other missions. Never propose a time that clashes with it; use check_schedule when a day matters. update_plan and request_booking also detect clashes: when one is reported, tell the user clearly (what, when, which mission) and propose an alternative. Never pay for a clashing booking unless the user confirms (conflict_ok: true). update_plan holds only this mission's own bookings: never copy lines from other missions into it.
- When the user wants to see a place (photos, "show me", what it looks like, reviews, Google Maps), call show_place_preview for a real place; for a business of the Mandat network (what you booked), call show_booking to show its card again.
- Be honest: these are demo merchants and PayPal sandbox payments.`;
}

// A reply in a script the user does not read (Chinese, Japanese, Korean, Cyrillic, Arabic…) is rewritten in
// their language before anyone sees it.
const FOREIGN = /[\u0400-\u04ff\u0600-\u06ff\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;
function foreign(text, s) {
  const lastUser = [...s.messages].reverse().find((m) => m.role === 'user' && !String(m.content).startsWith('[system]'));
  return FOREIGN.test(text) && !FOREIGN.test(String(lastUser?.content || ''));
}
async function relang(text, s) {
  const L = langOf(s._user?.lang) === 'fr' ? 'French' : 'English';
  const { message } = await chat({ model: MODELS.fast, fallback: MODELS.smart, temperature: 0, maxTokens: 3000, messages: [{ role: 'system', content: `Rewrite this message entirely in ${L}, same meaning, same tone, same markdown, names and amounts unchanged. If it ends with a line starting with ">>", keep that line and its "|" separators, translated. Reply with the message only.` }, { role: 'user', content: text }] });
  const out = String(message.content || '').trim();
  return out && !FOREIGN.test(out) ? out : text;
}

// French has two ways to address someone: Mandat says "tu" only to a user who does, "vous" otherwise, and
// never mixes them ("chez vous… dis-moi"). The model forgets, so the code checks every line the user reads.
const TU = /(^|[^\p{L}'’-])(tu|toi|ton|ta|tes|te)(?![\p{L}'’-])|(^|[^\p{L}])t['’]\p{L}|(^|[^\p{L}-])(dis|fais|montre|envoie|regarde|confirme|choisis|préviens|écris|rappelle|laisse|donne)-moi/iu;
const VOUS = /(^|[^\p{L}'’-])(vous|votre|vos)(?![\p{L}'’-])|\p{L}ez-(moi|nous)(?![\p{L}])/iu;
function saysTu(s) {
  return s.messages.filter((m) => m.role === 'user' && !String(m.content).startsWith('[system]')).slice(-8).some((m) => TU.test(String(m.content)));
}
function offAddress(text, s) {
  if (!text || langOf(s._user?.lang) !== 'fr') return false;
  return saysTu(s) ? VOUS.test(text) : TU.test(text);
}
async function readdress(text, s) {
  const tu = saysTu(s);
  const { message } = await chat({ model: MODELS.fast, fallback: MODELS.smart, temperature: 0, maxTokens: 3000, messages: [{ role: 'system', content: `Do not deliberate. Rewrite this French text so that it addresses the user with "${tu ? 'tu' : 'vous'}" everywhere (${tu ? 'tu, toi, ton, ta, tes, imperatives like "dis-moi"' : 'vous, votre, vos, imperatives like "dites-moi"'}), with verbs agreeing. Change nothing else: same words, meaning, markdown, names, amounts, and keep a last line starting with ">>" as it is apart from the form of address. Output only the text.` }, { role: 'user', content: text }] });
  const out = String(message.content || '').trim();
  return out && !offAddress(out, s) ? out : text;
}
const fixAddress = async (text, s) => (offAddress(text, s) ? readdress(text, s).catch(() => text) : text);

// Did the merchant agree? One small call, JSON only.
async function saysYes(reply, what) {
  const { message } = await chat({ model: MODELS.fast, fallback: MODELS.smart, json: true, temperature: 0, maxTokens: 1500, messages: [{ role: 'user', content: `Do not deliberate. A merchant was asked to ${what}. Their reply: "${String(reply || '').slice(0, 600)}". Did they agree to exactly that? JSON only: {"yes":true|false}` }] }).catch(() => ({ message: {} }));
  try { return JSON.parse(message.content || '{}').yes === true; } catch { return false; }
}

async function refigure(text, wrong, s) {
  const { message } = await chat({ model: MODELS.fast, fallback: MODELS.smart, temperature: 0, maxTokens: 3000, messages: [{ role: 'system', content: `This message contains arithmetic mistakes. The exact results are: ${wrong.join('; ')}. Rewrite the message with the correct numbers, and fix any total that depends on them (sums, what is left of the budget). Keep the same language, tone, markdown and the final ">>" line if there is one. Reply with the message only.` }, { role: 'user', content: text }] });
  return String(message.content || '').trim() || null;
}

// A booking whose money was entirely released or refunded is no longer on: its steps leave the plan (agenda,
// recap, reminders) and its request is closed, unless another payment to the same merchant is still active.
function dropBooking(s, e, emit) {
  const same = (m) => m && e.merchant && m === e.merchant; // the same merchant, never one with a similar name
  if (s.envelope.entries.some((x) => x.id !== e.id && same(x.merchant) && (x.state === 'held' || x.state === 'captured'))) return;
  let changed = false;
  for (const i of s.plan || []) if (same(i.merchant) && i.status !== 'cancelled') { i.status = 'cancelled'; changed = true; }
  for (const r of Object.values(s.requests || {})) if (r.paymentId === e.id && !['declined', 'cancelled'].includes(r.status)) r.status = 'cancelled';
  if (changed) emit('plan', { items: s.plan });
}

// Logic before money: whoever works on site or delivers must know where (the venue, the home, the pickup
// point). For an event, that means the place is booked first.
const ON_SITE = ['catering', 'entertainment', 'decoration', 'ride', 'florist', 'bakery'];
function needsPlace(m, a) {
  if (!ON_SITE.includes(m.category) || String(a.where || '').trim().length >= 6) return '';
  if ((m.category === 'bakery' || m.category === 'florist') && !/deliver|livr/i.test(JSON.stringify(a))) return ''; // picked up in store
  return `${m.name} needs to know where: give "where" (the exact address of the venue, the home or the pickup point). For an event, book the venue first, then tell every supplier its address and the time.`;
}

// One look at the photos of the candidates (one image each, 5 at most): does each really match the need?
async function lookAtProducts(picks, need, lang = 'en') {
  const imgs = await Promise.all(picks.map(async (p) => {
    const r = await fetch(p.image, { signal: AbortSignal.timeout(8000) }).catch(() => null);
    if (!r?.ok) return null;
    return `data:${r.headers.get('content-type') || 'image/jpeg'};base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}`;
  }));
  const ok = picks.map((p, i) => ({ p, img: imgs[i] })).filter((x) => x.img);
  if (!ok.length) return {};
  const ask = () => chat({ model: MODELS.fast, json: true, maxTokens: 9000, timeoutMs: 60000, messages: [{ role: 'user', content: [{ type: 'text', text: `Do not deliberate, answer at once. The customer needs: ${String(need).slice(0, 200)}. Here are ${ok.length} product photos, in order: ${ok.map((x, i) => `${i + 1}) ${x.p.title}`).join('; ')}. For each: would a sensible person buying for this need pick it (right kind of product for that person and age, right character or model, colour, quality)? Honestly: a perfume, make-up or an adult item for a child, an accessory or a spare part when the item itself is wanted, or something that does not work alone (needs another device) is fits:false. JSON only: {"1":{"fits":true,"note":"one short sentence in ${langOf(lang) === 'fr' ? 'French' : 'English'}: what the photo shows and why it fits or not"},"2":{...}, ... one entry for each photo}` }, ...ok.map((x) => ({ type: 'image_url', image_url: { url: x.img } }))] }] });
  // reasoning can eat the whole budget and cut the JSON: one more try before showing picks without a look
  let o = null;
  for (let i = 0; i < 2 && !o; i++) {
    try { const { message } = await ask(); o = JSON.parse(message.content || ''); } catch (e) { console.warn('[shop] photo look failed:', e.message); }
  }
  if (!o) return {};
  const out = {};
  ok.forEach((x, i) => { const v = o[i + 1]; if (v) out[x.p.id] = typeof v === 'string' ? { fits: true, note: v.slice(0, 220) } : { fits: v.fits !== false, note: String(v.note || '').slice(0, 220) }; });
  return out;
}

// After each new message of the user, before anything new is booked: what the user replaced is dealt with first.
// Checked once per user message (a second attempt goes through, e.g. when only a paid item waits for their answer).
async function obsoleteFirst(s) {
  const last = s.messages.reduce((at, m, i) => (m.role === 'user' && !String(m.content).startsWith('[system]') ? i : at), -1);
  if (last < 0 || s._obsoleteChecked === last) return null;
  s._obsoleteChecked = last;
  const review = await reviewPlan(s).catch(() => null);
  const obsolete = (review?.issues || []).filter((x) => /^obsol/i.test(x));
  return obsolete.length ? obsolete : null;
}

// A senior planner reviews the plan against what the user asked: the essentials a professional would never
// forget (a venue for a wedding before the caterer, a stay for every night of a trip) and what does not
// hold together (a caterer with no venue to serve at, times that do not fit). Kept on the mission, so the
// automatic "all set" also waits for it.
export async function reviewPlan(s) {
  const ask = String(s.messages.find((m) => m.role === 'user' && !String(m.content).startsWith('[system]'))?.content || s.envelope.purpose || '').slice(0, 700);
  const said = s.messages.filter((m) => m.role === 'user' && !String(m.content).startsWith('[system]')).slice(1, 12).map((m) => String(m.content).slice(0, 160)).join(' | ');
  const bookings = [
    ...Object.values(s.requests || {}).map((r) => `${r.merchant} [${r.status}]: ${r.items.map((i) => `${i.qty}x ${i.label}`).join(', ')} ${r.slot || ''}`),
    ...s.envelope.entries.filter((e) => e.state !== 'released' && e.state !== 'refunded').map((e) => `${e.merchant} [${e.state}]: ${e.label}`),
  ];
  const plan = (s.plan || []).map((i) => `${i.what} [${i.status || ''}] ${i.when || ''} ${i.where || ''}`);
  const decisions = notesBrief(s) || '';
  const { message } = await chat({ model: MODELS.fast, fallback: MODELS.smart, json: true, temperature: 0, maxTokens: 7000, timeoutMs: 40000, messages: [{ role: 'system', content: 'Do not deliberate, answer at once. You are a senior planner (events, trips, errands of any kind) reviewing a junior assistant\'s plan for a client. Think about how the request works in real life, step by step. List only real essentials: what this request cannot do without but is missing or not booked (a wedding or a party needs a venue before catering, music or decoration; a trip needs transport there and back and a stay for every night; a dinner needs a table), and real consistency problems: a supplier with no place to work at or not told the address, things booked in an order that cannot work, times that do not fit (a caterer arriving after the guests, a train leaving before the check-out), a booking in another city or on another date than the request, quantities that do not match the number of people, a total over the budget, and above all a booking that no longer matches what the client decided later (they changed their mind: e.g. a buffet still booked after they chose a caterer instead) — name it as an issue starting with "Obsolete:". "missing" is only an essential part of the request that has no booking at all (never a detail, an address, a pending confirmation or a nice-to-have). "issues" is only what would really go wrong. Simple errands (a taxi, a bouquet, a repair) almost always have nothing missing and no issue. What the client stated about themselves is true and never an issue (that they own the item, who it is for, what they already have). When in doubt, leave it out. JSON only: {"missing":["short phrase"],"issues":["short phrase"]}' }, { role: 'user', content: `Request: ${ask}\nWhat the client said since: ${said || '-'}\nDecisions noted for this mission: ${decisions || '-'}\nFacts set by the client: ${factsBrief(s) || '-'}\nPlan: ${plan.join(' ; ') || '-'}\nBookings: ${bookings.join(' ; ') || '-'}` }] });
  const o = JSON.parse(message.content || '{}');
  const review = { missing: (o.missing || []).slice(0, 5).map((x) => String(x).slice(0, 120)), issues: (o.issues || []).slice(0, 5).map((x) => String(x).slice(0, 160)), at: Date.now() };
  s.review = review;
  return review;
}

// Every business Mandat books is shown once as a card (photos, address, price, conditions), whether or not
// the model thought of it: the user always sees what was chosen for them, and can ask for another.
async function bookingCard(s, m, a, emit, { force = false } = {}) {
  if (m.category === 'shop') return; // a real retailer: its product card is already on screen
  s.shown ||= {};
  if (s.shown[m.id] && !force) return;
  s.shown[m.id] = true;
  const p = await withTimeout(profileOf(m), 12000).catch(() => ({}));
  // kept for the recap, so the final card can unfold the place with its real photos and address
  (s.placeInfo ||= {})[m.id] = { address: p?.address || '', photos: (p?.photos || []).map((x) => x?.url || x).filter((u) => typeof u === 'string').slice(0, 5) };
  emit('option', { merchant_id: m.id, name: m.name, category: m.category, city: m.city, rating: m.rating, pitch: m.pitch, address: p?.address || '', area: p?.area || '', highlights: (langOf(s._user?.lang) === 'fr' && p?.highlightsFr?.length ? p.highlightsFr : p?.highlights) || [], photos: p?.photos || [], what: String(a.what || '').slice(0, 160), price: round(Number(a.price) || 0), deposit: a.deposit ? round(Number(a.deposit)) : null, conditions: String(a.conditions || '').slice(0, 200), from: String(a.from || '').slice(0, 140), to: String(a.to || '').slice(0, 140), when: String(a.when || '').slice(0, 20), currency: s.envelope.currency });
}

// A payment the user declined stays declined until they speak again (a merchant's automatic reply does not count).
function refused(s, id) {
  const at = s.declined?.[id];
  return at != null && !s.messages.slice(at).some((x) => x.role === 'user' && !String(x.content).startsWith('[system]'));
}

// Run one user turn. `emit(type, data)` streams events to the interface.
export async function userTurn(s, text, emit, { images = [], image, urls = [] } = {}) {
  if (image) images = [image];
  s._searches = 0;
  if (images.length) {
    // Read each photo once with the vision model; keep a precise text description in the conversation.
    // The description and the check of the printed name run side by side: the name is read five times and the
    // majority spelling wins, so a blurry letter never turns into a wrong brand.
    const seen = await Promise.all(images.map(async (d) => {
      const [desc, printed] = await Promise.all([describeImage(d, text).catch(() => null), readPrinted(d).catch(() => null)]);
      return desc && printed ? `${desc}\nName printed on it, checked by five readings: "${printed}" (use this exact spelling for the brand and model).` : desc;
    }));
    const ok = seen.filter(Boolean);
    const L = s._user?.lang;
    emit('photo_read', { summary: ok.length ? (ok.length > 1 ? tr(L, 'Read {n} photos', { n: ok.length }) : tr(L, 'Read your photo')) : tr(L, "Couldn't read the photo right now. Tell me what it shows.") });
    // kept with the mission: a merchant can be sent the photo (a repair quote, the exact part to find)
    s.photos = [...(s.photos || []), ...seen.map((d, i) => ({ url: urls[i] || '', desc: d || '', at: Date.now() }))].slice(-6);
    text = `${text || (images.length > 1 ? 'Here are some photos.' : 'Here is a photo.')}\n` + seen.map((d, i) => `[Photo ${i + 1} the user sent — ${d ? 'what it shows: ' + d : 'it could not be read'}]`).join('\n');
  }
  // The facts the user set are updated before Mandat answers: the previous update is awaited, this one runs
  // while Mandat works (the new message itself is in the conversation anyway).
  if (s._facts) await s._facts.catch(() => {});
  if (!String(text).startsWith('[system]')) s._facts = updateFacts(s, text).then(() => saveMission(s)).catch((e) => console.warn('[facts]', e.message));
  s.messages.push({ role: 'user', content: text });
  let empty = 0;
  const fromUser = !String(text).startsWith('[system]');
  for (let step = 0; step < MAX_STEPS; step++) {
    if (s._cancelled) return; // the user deleted the mission: stop right here
    if (s.frozen) { // paused by the user: stop after the current step, resume picks up from here
      // Said once per pause, and only to the user: merchants' news waits silently in the conversation
      // (it is read on resume) instead of filling the screen with the same sentence.
      if (step === 0 && fromUser && !s._pauseSaid) {
        s._pauseSaid = true;
        emit('say', { text: tr(s._user?.lang, 'This mission is paused. Tap Paused at the top to resume, and I will carry on.') });
      }
      return;
    }
    const tz = s._user?.tz || 'UTC';
    const notes = notesBrief(s);
    const plans = agendaBrief(agenda(s._user, s, tz));
    const facts = factsBrief(s);
    const live = { role: 'system', content: `${facts ? `Mission facts set by the user (true until the user changes them: never contradict them, never ask them again, plan and count from them):\n${facts}\n` : ''}Live state — the user's local time is ${localNow(tz)} (${tz}); budget ${Env.fmt(s.envelope.total, s.envelope)}; already committed at full price (deposits, balances due on site, requests sent): ${Env.fmt(committedOf(s), s.envelope)}; really left to plan: ${Env.fmt(round(s.envelope.total - committedOf(s)), s.envelope)} (paid or held right now: ${Env.fmt(Env.totals(s.envelope).held + Env.totals(s.envelope).spent, s.envelope)}). Always reason with what is really left, never with the deposits alone.${ledgerBrief(s) ? `\nThe mission's books (exact, from the payments and requests; use these figures for any money question, line by line, never from memory):\n${ledgerBrief(s)}` : ''}${notes ? `\nNotes for this mission:\n${notes}` : ''}\n${plans ? `Already planned in the user's other missions (private background, only to avoid clashes: never mention it unless a time you are planning here really overlaps, or the user asks):\n${plans}` : 'Nothing else planned in other missions.'}${s._voice ? "\nVOICE: the user is talking with you out loud and hears your final reply. Speak like a sharp human assistant on the phone: one or two short sentences, 40 words at most. Before your first tool call, say in one short sentence what you are going to check; after that, no narration until you have something useful or need an answer. Never repeat, recap or re-explain anything already said in this conversation: only what is new. One question at a time; the '>>' line of ready answers is still welcome (it is not read out). No lists, markdown or links; say prices, dates and times the way people say them. The cards on screen carry the details, never read them out." : ''}${empty ? '\nYour previous attempt came back empty. Go on from where you are: call the next tools, or write your reply to the user.' : ''}` };
    const history = await contextWindow(s);
    const { message } = await chat({
      model: MODELS.fast, fallback: MODELS.smart, temperature: 0.4, maxTokens: 8000, tools: shopEnabled() ? TOOLS : TOOLS.filter((x) => !['find_products', 'buy_product'].includes(x.function.name)),
      messages: [{ role: 'system', content: systemPrompt(s) }, ...history, live],
      onDelta: (t) => emit('say_delta', { t }), // the reply appears word by word on screen
      onReset: () => emit('say_reset', {}),
    });
    const calls = message.tool_calls || [];
    // An empty answer (the model spent its length thinking) is never the end of the turn: try again.
    if (!calls.length && !String(message.content || '').trim() && empty < 2) { empty++; continue; }
    empty = 0;
    s.messages.push({ role: 'assistant', content: message.content || '', ...(calls.length ? { tool_calls: calls } : {}) });
    // A reply written alongside tool calls is a step, not the answer: shown, but never read aloud.
    // The model sometimes drifts into another script (Chinese) mid-conversation: never shown as is.
    if (message.content && foreign(message.content, s)) {
      message.content = await relang(message.content, s).catch(() => message.content);
      s.messages[s.messages.length - 1].content = message.content;
      emit('say_reset', {});
    }
    if (message.content && offAddress(message.content, s)) {
      message.content = await readdress(message.content, s).catch(() => message.content);
      s.messages[s.messages.length - 1].content = message.content;
      emit('say_reset', {});
    }
    // Numbers are checked by the code before anyone reads them: a wrong product or sum is rewritten.
    if (message.content) {
      const wrong = checkMath(message.content);
      if (wrong.length) {
        const fixed = await refigure(message.content, wrong, s).catch(() => null);
        if (fixed && !checkMath(fixed).length) {
          message.content = fixed;
          s.messages[s.messages.length - 1].content = fixed;
          emit('say_reset', {});
        }
      }
    }
    // Ready answers come as a last line ">> A | B | C": shown as buttons under the question, never in the text.
    let text = (message.content || '').trim(), choices = [];
    const tail = text.match(/\n?\s*>>\s*([^\n]+)\s*$/);
    if (tail) { choices = tail[1].split('|').map((x) => x.trim().replace(/^[*"«]+|[*"»]+$/g, '')).filter(Boolean).slice(0, 5); text = text.slice(0, tail.index).trim(); }
    if (text) emit('say', { text, ...(calls.length ? { step: true, ...(step === 0 ? { plan: true } : {}) } : {}) });
    if (!calls.length && choices.length >= 2) emit('choices', { choices });
    if (!calls.length) return;
    for (const call of calls) {
      if (s._cancelled) return;
      let args = {}, broken = false;
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch { broken = true; }
      if (!broken) emit('tool', { name: call.function.name, args });
      let result;
      try {
        // a malformed call is never run with empty arguments: the model is told exactly what went wrong
        result = broken ? { error: 'Your arguments were not valid JSON. Call the tool again with the same content, as valid JSON.' } : await runTool(s, call.function.name, args, emit);
      } catch (e) {
        result = { error: e.message };
      }
      s.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  // Out of steps: a real status, never a vague line.
  try {
    const history = await contextWindow(s);
    const { message } = await chat({ model: MODELS.fast, fallback: MODELS.smart, temperature: 0.3, maxTokens: 3000, messages: [{ role: 'system', content: systemPrompt(s) }, ...history, { role: 'system', content: 'Pause here. In 2 or 3 short sentences, tell the user exactly what is done (booked, held, requested) and what is left, then ask whether to continue. No tools.' }] });
    const text = String(message.content || '').trim();
    if (text) { s.messages.push({ role: 'assistant', content: text }); return emit('say', { text }); }
  } catch {}
  emit('say', { text: tr(s._user?.lang, "I've done what I can for now. Tell me how you'd like to continue.") });
}

async function runTool(s, name, a, emit) {
  switch (name) {
    case 'find_real_places': {
      let center = s.location;
      if (a.near) center = await withTimeout(geocode(a.near), 6000).catch(() => center);
      if (!center) return { error: 'No location yet. Ask the user where.' };
      const places = await withTimeout(nearby({ lat: center.lat, lon: center.lon, category: a.category, limit: 5 }), 7000).catch(() => []);
      emit('places', { category: a.category, center, places });
      s.lastPlaces = places;
      return { near: center.label, places: places.map(({ name, distance, openingHours, cuisine }) => ({ name, distance_m: distance, openingHours, cuisine })) };
    }
    case 'find_network_merchants': {
      let list = search({ category: a.category, city: a.city });
      if (!list.length && a.city) {
        // somewhere new: the network opens that city first (a few seconds, once for everyone)
        const from = s._user?.profile?.home?.label || s.location?.label || '';
        const city = await openCity(a.city, { from });
        if (city) list = search({ category: a.category, city });
        if (!list.length) { const c2 = await addCategory(city || a.city, a.category, { from }); if (c2) list = search({ category: a.category, city: c2 }); }
      }
      if (!list.length) return { merchants: [], note: 'No merchant of this kind there. Suggest real places with find_real_places, or another category.' };
      emit('merchants', { category: a.category, merchants: list });
      return { merchants: list };
    }
    case 'set_budget': {
      const n = Math.round(Number(a.total));
      const t = Env.totals(s.envelope);
      if (!(n > 0 && n <= 1000000)) return { error: 'A mission budget goes from 1 to 1,000,000.' };
      if (n > s.envelope.total) {
        const lastUser = [...s.messages].reverse().find((x) => x.role === 'user' && !String(x.content).startsWith('[system]'));
        if (!String(lastUser?.content || '').replace(/[\s\u202f\u00a0.,]/g, '').includes(String(n))) return { error: 'Only the user can raise the budget, by saying the new amount. Ask them.' };
      }
      if (n < committedOf(s)) return { error: `${Env.fmt(committedOf(s), s.envelope)} is already committed (everything booked at full price); the budget cannot go below that.` };
      if (s._user) {
        const others = monthCommitted(s._user, (s._user.missions || []).filter((id) => id !== s.id).map(getMission));
        if (others + n > s._user.rules.monthlyCap) {
          emit('limit', { kind: 'monthly', cap: s._user.rules.monthlyCap, used: others, need: n, currency: s.envelope.currency });
          return { error: `That would pass the user's monthly limit (${s._user.rules.monthlyCap}, ${others} already planned in other missions). A card with a button to raise it in Settings is on screen: say it in one short sentence, do not repeat the numbers at length.` };
        }
      }
      const before = s.envelope.total;
      s.envelope.total = n;
      s.envelope.source = 'words';
      emit('envelope', envelopeView(s));
      emit('budget_changed', { from: before, to: n, currency: s.envelope.currency });
      return { ok: true, total: n, remaining: round(s.envelope.total - committedOf(s)) };
    }
    case 'save_sizes': {
      const u = s._user && getUser(s._user.id);
      if (!u) return { error: 'No profile.' };
      const fit = Object.fromEntries(['cut', 'top', 'bottom', 'shoes', 'style', 'age'].map((k) => [k, String(a[k] ?? '').trim().slice(0, 60)]).filter(([, v]) => v));
      const who = String(a.who || '').trim();
      if (!who) return { error: 'Say who: "me" or a first name.' };
      if (/^(me|moi|user)$/i.test(who)) u.profile.fit = { ...(u.profile.fit || {}), ...fit };
      else {
        const list = u.profile.people || (u.profile.people = []);
        let x = list.find((y) => y.name.toLowerCase() === who.toLowerCase());
        if (!x) { x = { name: who.slice(0, 60), email: '' }; list.push(x); }
        if (a.relation) x.relation = String(a.relation).trim().replace(/^./, (c) => c.toUpperCase()).slice(0, 30);
        x.fit = { ...(x.fit || {}), ...fit };
      }
      saveUser(u);
      s._user = u;
      return { saved: true, note: 'Saved in their profile: do not ask it again.' };
    }
    case 'remember': {
      const r = remember(s, a);
      if (!r.error) emit('memory', { action: r.remembered, scope: r.scope, ...r.item });
      return r.error ? r : { remembered: r.remembered, scope: r.scope, id: r.id };
    }
    case 'forget': {
      const r = forget(s, a);
      if (!r.error) emit('memory', { action: 'forgotten', id: a.id });
      return r;
    }
    case 'check_schedule': {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(a.date || '')) return { error: 'Give the date as "YYYY-MM-DD".' };
      const day = dayAgenda(s._user, s, a.date, s._user?.tz || 'UTC');
      return { date: a.date, commitments: day, free: !day.length };
    }
    case 'wrap_up': {
      if (!a.headline || !a.lines?.length) return { error: 'Give a headline and one line per booking (what, when, where).' };
      pruneReminders(s, emit);
      settleApprovals(s, emit);
      // Never announce "all set" while a merchant or the user still has to answer.
      const waiting = [
        ...Object.values(s.requests || {}).filter((r) => r.status === 'pending' || r.status === 'countered').map((r) => `${r.merchant} has not accepted yet`),
        ...Object.values(s.approvals || {}).filter((x) => x.status === 'pending').map((x) => `the user still has to approve ${x.label}`),
        ...(s.plan || []).filter((i) => ['searching', 'negotiating', 'requested', 'awaiting_approval'].includes(i.status)).map((i) => `"${i.what}" is still ${i.status.replace('_', ' ')}`),
      ];
      if (waiting.length) return { error: `Not settled yet: ${[...new Set(waiting)].join('; ')}. Tell the user plainly what is pending (never say booked). You will be told when it moves; wrap up then.` };
      // Nothing essential may be missing when Mandat says "all set" (a wedding without a venue is not set).
      const review = await reviewPlan(s).catch(() => null);
      if (review?.missing?.length) return { error: `Not complete: ${review.missing.join('; ')}. Do not say it is all set. Tell the user in one sentence what is still missing and take care of it now.`, review };
      const obsolete = (review?.issues || []).filter((x) => /^obsol/i.test(x));
      if (obsolete.length) return { error: `Not consistent: ${obsolete.join('; ')}. Cancel or refund what the user replaced, update the plan, then wrap up.`, review };
      const [headline, note] = await Promise.all([fixAddress(a.headline, s), fixAddress(a.note || '', s)]);
      const card = wrapCard(s, { ...a, headline, note });
      emit('wrapup', card);
      s.wrapped = card;
      return { shown: true, note: 'The user also gets a phone notification. End with one short sentence: everything is set, reminders are planned, and they can ask you to change anything.' };
    }
    case 'set_reminder': {
      const tz = s._user?.tz || 'UTC';
      const at = localToUtc(a.when, tz);
      if (!at || isNaN(at)) return { error: 'Give the time as "YYYY-MM-DD HH:MM" in the user\'s local time.' };
      if (at.getTime() < Date.now() + 30000) return { error: 'That time has already passed. Pick a later time.' };
      if (at.getTime() > Date.now() + 366 * 864e5) return { error: 'Reminders can be set up to a year ahead.' };
      s.reminders ||= [];
      if (s.reminders.filter((r) => !r.sent).length >= 12) return { error: 'This mission already has many reminders.' };
      const r = { id: 'rm_' + crypto.randomBytes(4).toString('hex'), at: at.toISOString(), local: a.when, text: String(a.text).slice(0, 200), eventAt: a.event_at || null, place: a.place || '', sent: false };
      s.reminders.push(r);
      emit('reminder', r);
      return { scheduled: true, at_local: a.when, timezone: tz, note: 'The user will get a phone notification then. The booking is already in the app\'s Agenda: never ask them to add anything to a calendar.' };
    }
    case 'suggest_get_to_know': {
      const u = s.userId && getUser(s.userId);
      if (!u) return { skipped: true };
      if (u.suggestedInterviewAt && Date.now() - Date.parse(u.suggestedInterviewAt) < 21 * 864e5) return { skipped: true, info: 'Already offered recently: do not mention it again; ask one quick question if needed.' };
      u.suggestedInterviewAt = new Date().toISOString();
      saveUser(u);
      emit('suggest_profile', { reason: String(a.reason || '').slice(0, 160) });
      return { shown: true, info: 'A card offers it; mention it in a few words at most, and carry on with the mission.' };
    }
    case 'notify_user': {
      const text = (await fixAddress(String(a.text || '').trim(), s)).slice(0, 220);
      if (!text) return { error: 'Nothing to say.' };
      s.notified = (s.notified || 0) + 1;
      if (s.notified > 6) return { error: 'Enough notifications for this mission; keep the rest for the recap.' };
      emit('notify', { text });
      return { sent: true };
    }
    case 'show_booking': {
      await bookingCard(s, merchant(a.merchant_id), a, emit, { force: true });
      return { shown: true };
    }
    case 'estimate_trip': {
      const home = s._user?.profile?.home;
      const a1 = a.from ? await withTimeout(geocode(a.from), 6000).catch(() => null) : home?.lat ? home : s.location;
      const a2 = await withTimeout(geocode(a.to), 6000).catch(() => null);
      if (!a1 || !a2) return { error: 'Could not place one of the two addresses. Ask for the street or the exact name.' };
      const R = 6371, rad = (x) => (x * Math.PI) / 180;
      const dLat = rad(a2.lat - a1.lat), dLon = rad(a2.lon - a1.lon);
      const km = 2 * R * Math.asin(Math.sqrt(Math.sin(dLat / 2) ** 2 + Math.cos(rad(a1.lat)) * Math.cos(rad(a2.lat)) * Math.sin(dLon / 2) ** 2)) * 1.3; // streets are not straight lines
      const walk = Math.round((km / 4.8) * 60), bike = Math.round((km / 15) * 60);
      const taxi = Math.round(4 + km * 1.9);
      // the real lines at both ends, and the ones that link them directly
      let transit = null;
      if (walk > 12) {
        const [t1, t2] = await Promise.all([a1, a2].map((p) => withTimeout(transitNear(p.lat, p.lon), 10000).catch(() => null)));
        if (t1 && t2) {
          const key = (l) => l.mode + '|' + l.ref;
          const direct = t1.lines.filter((l) => t2.lines.some((m) => key(m) === key(l)));
          transit = { stops_near_start: t1.stops, stops_near_end: t2.stops, direct_lines: direct.slice(0, 6), lines_near_start: t1.lines.slice(0, 10), lines_near_end: t2.lines.slice(0, 10) };
        }
      }
      return { distance_km: Math.round(km * 10) / 10, walk_min: walk, bike_min: bike, taxi_estimate: taxi, transit, advice: walk <= 20 ? 'Walkable: suggest walking (free), a ride only if they have heavy luggage, it is late at night, or they ask.' : km <= 15 ? 'Public transport is the sensible default: name the real line and stop from transit (a direct line if there is one, else a change); a ride only if time, luggage or night makes it worth it, and say the price.' : 'Far: compare the train or a coach with a ride, cheapest first.' };
    }
    case 'find_top_places': {
      const list = await withTimeout(topPlaces({ category: a.category, city: a.city, sort: a.sort || 'rating', count: a.count || 5, lang: langOf(s._user?.lang), keywords: String(a.keywords || '').slice(0, 60) }), 20000).catch((e) => { console.warn('[top]', e.message); return null; });
      if (!list?.length) return { error: 'The ranking is not available right now. Suggest a few places with find_real_places instead, without ranking them.' };
      emit('top_places', { category: a.category, city: a.city, sort: a.sort || 'rating', places: list });
      return { shown: true, places: list.map((p) => ({ name: p.name, rating: p.rating, reviews: p.ratings, price_level: p.price, area: p.area })), note: 'The card is on screen: do not list them again; say in one or two sentences what stands out, and offer to plan the stay.' };
    }
    case 'show_place_preview': {
      // A business of the Mandat network has its own card (it is not on Google Maps).
      const own = MERCHANTS.find((x) => x.name.toLowerCase() === String(a.name || '').toLowerCase().trim());
      if (own) { await bookingCard(s, own, { what: own.pitch, price: own.offers[0]?.price || 0 }, emit, { force: true }); return { shown: true }; }
      const want = String(a.name || '').toLowerCase();
      let p = (s.lastPlaces || []).find((x) => x.name?.toLowerCase().includes(want) || want.includes(x.name?.toLowerCase()));
      if (!p) {
        let center = s.location;
        if (a.near) center = await withTimeout(geocode(a.near), 6000).catch(() => center);
        p = await withTimeout(findPlace(a.near ? `${a.name}, ${a.near}` : a.name, center), 7000).catch(() => null);
      }
      if (!p) return { error: 'Could not find that place on the map. Ask for the exact name or the street.' };
      const v = await withTimeout(placePreview({ ...p, near: a.near }), 9000).catch(() => null);
      if (!v) return { error: 'The preview could not be loaded right now.' };
      emit('preview', v);
      return { shown: true, photos: v.photos.length, note: v.photos.length ? 'Photos and details are on screen.' : 'No public photo was found; the card has a button to its Google Maps page with people\'s photos and reviews.' };
    }
    case 'verify_merchant': {
      const m = merchant(a.merchant_id);
      const card = identityCard(m);
      const ok = verifyCard(card);
      emit('verified', { merchant_id: m.id, name: m.name, ok, card });
      return { verified: ok, agent: card.agent, issuedBy: card.issuedBy };
    }
    case 'inspect_place': {
      // A business of the Mandat network is not on Google Maps: its own card and profile.
      const own = MERCHANTS.find((x) => x.name.toLowerCase() === String(a.name || '').toLowerCase().trim() || String(a.name || '').toLowerCase().includes(x.name.toLowerCase()));
      if (own) {
        if (a.show) await bookingCard(s, own, { what: own.pitch, price: own.offers[0]?.price || 0 }, emit, { force: true });
        const pr = await withTimeout(profileOf(own), 12000).catch(() => ({}));
        return { name: own.name, network_business: true, rating: own.rating, address: pr?.address, highlights: pr?.highlights, offers: own.offers, note: 'A business of the Mandat network (sandbox): judge it on its rating, offers and facts, not on photos.' };
      }
      const p = await withTimeout(inspectPlace({ name: a.name, city: a.city || '', lang: langOf(s._user?.lang) }), 25000).catch((e) => { console.warn('[inspect]', e.message); return null; });
      if (!p) return { error: 'This place could not be looked at right now (not found, or the daily allowance is used). Judge from the rating and what you know.' };
      if (p.notFound) return { error: `Google only knows a different place by a similar name (${p.foundInstead}). Do not present it; say you could not find photos of ${a.name}.` };
      // the photos, looked at with the user's need in mind
      let look = '';
      const imgs = p.photos.filter((x) => x.data).slice(0, 3);
      if (imgs.length) {
        try {
          const { message } = await chat({ model: MODELS.fast, maxTokens: 2500, messages: [{ role: 'user', content: [{ type: 'text', text: `These are photos of "${p.name}". The customer needs: ${String(a.need).slice(0, 200)}. In 3 short sentences: what the place looks like (style, space, light, cleanliness, standing) and whether it fits that need, honestly, with any warning.` }, ...imgs.map((x) => ({ type: 'image_url', image_url: { url: x.data } }))] }] });
          look = String(message.content || '').trim().slice(0, 700);
        } catch {}
      }
      if (a.show) emit('preview', { name: p.name, address: p.address, rating: p.rating, ratings: p.ratings, photos: p.photos.map(({ url, source }) => ({ url, source })), googleMaps: p.googleMaps, website: p.website, lat: p.lat, lon: p.lon, directions: p.lat ? `https://maps.apple.com/?daddr=${p.lat},${p.lon}&q=${encodeURIComponent(p.name)}` : null });
      return { name: p.name, rating: p.rating, reviews_count: p.ratings, price_level: p.price, summary: p.summary, what_the_photos_show: look || 'No photo could be looked at.', recent_reviews: p.reviews, note: a.show ? 'Its card is on screen. Tell the user in two sentences what you saw and why it fits.' : 'Nothing was shown. If it is the one you recommend, call inspect_place again with show: true (it is cached).' };
    }
    case 'find_products': {
      if (!shopEnabled()) return { error: 'Product search is not available right now. Suggest real shops with find_real_places instead.' };
      // a person who shops for you tries a few searches, then reports what they found
      if (++s._searches > 4) return { error: 'Enough searches for now: tell the user what you found (the best real options, even if not perfect), or ask them one precise question.' };
      const list = await withTimeout(searchProducts({ query: a.query, minPrice: Number(a.min_price) || 0, maxPrice: Number(a.max_price) || 0, limit: 8, lang: s.envelope.currency === 'USD' ? 'en' : 'fr', userId: s.userId || '' }), 20000).catch((e) => { console.warn('[shop]', e.message); return null; });
      if (!list) return { error: 'The product search did not answer. Try other words, or suggest real shops.' };
      if (!list.length) return { error: 'Nothing in stock for that. Try broader words or a higher price.' };
      s.products ||= {};
      for (const p of list) s.products[p.id] = p;
      // The 3 best value among the most relevant, and one look at their photos (3 images in all) for the need.
      // Relevant first: the products that carry the words that matter (a character, a brand, a model), then
      // the best prices among the most relevant of those. The photos decide in the end.
      const norm = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const GENERIC = new Set(['pour', 'avec', 'cadeau', 'gift', 'enfant', 'enfants', 'kids', 'fille', 'garcon', 'girl', 'boy', 'peluche', 'plush', 'jouet', 'toy', 'disney', 'the', 'and', 'des', 'les', 'une', 'set', 'pack']);
      const keys = norm(a.query).split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !GENERIC.has(w));
      const hay = (p) => norm(`${p.title} ${p.brand} ${p.category} ${p.description}`);
      const relevant = keys.length ? list.filter((p) => keys.some((k) => new RegExp(`\\b${k}\\b`).test(hay(p)))) : list; // the whole word: "stitched" is not Stitch
      const pool = (relevant.length >= 2 ? relevant : list).filter((p) => p.image).slice(0, 5);
      // all five are looked at, so one that does not suit (wrong product for the person) leaves room for the next
      let looks = {};
      if (a.need && pool.length) looks = await lookAtProducts(pool, a.need, s._user?.lang).catch(() => ({}));
      const picks = pool.filter((p) => looks[p.id]?.fits !== false).sort((x, y) => x.price - y.price).slice(0, 3);
      for (const p of list) { p.pick = picks.includes(p); p.look = looks[p.id]?.note || ''; }
      list.sort((x, y) => (y.pick ? 1 : 0) - (x.pick ? 1 : 0));
      emit('products', { query: a.query, products: list });
      return { shown: true, products: list.map((p) => ({ id: p.id, title: p.title, brand: p.brand, price: p.price, was: p.was, currency: p.currency, retailer: p.retailer, other_offers: p.offers.slice(1).map((o) => `${o.retailer} ${o.price}`), features: p.features, ...(p.pick ? { best_value_pick: true, what_the_photo_shows: p.look || undefined } : looks[p.id]?.fits === false ? { not_suitable: p.look || true } : {}) })), note: 'The card is on screen: do not list them all again. Unless the user already chose or told you to pick for them, present the best two in a sentence each (why it fits, the price, the real difference between them) and let them choose, with the two as quick replies; buy once they pick.' };
    }
    case 'buy_product': {
      const p = s.products?.[a.product_id];
      if (!p) return { error: 'Unknown product: search it with find_products first.' };
      if (String(a.ship_to || '').trim().length < 6) return { error: 'Where should it be delivered? Ask for the address (or use their home address).' };
      // Clothes and shoes are never bought without a size.
      const wearable = /\b(shirt|t-shirt|tee|dress|jacket|coat|blazer|suit|trousers?|pants|jeans|skirt|sweater|jumper|hoodie|cardigan|shoes?|sneakers?|trainers|boots?|heels|sandals|loafers|chemise|robe|veste|manteau|costume|pantalon|jupe|pull|sweat|chaussures?|baskets|bottes|escarpins)\b/i.test(`${p.title} ${p.category}`);
      if (wearable && String(a.options || '').trim().length < 1) return { error: `${p.title} is worn: give its size in options. Use the size you know for the person it is for; if you do not know it, ask the user first (quick replies with sizes).` };
      // A courier calls on delivery: no order without a phone number. Asked once, then kept in the profile.
      const owner = s._user && getUser(s._user.id);
      const phone = String(a.phone || owner?.profile?.phone || '').trim();
      if (phone.replace(/\D/g, '').length < 8) return { error: 'The courier needs a phone number to call on delivery. Ask the user for it in one short question, then call buy_product again with phone (it is then saved in their profile).' };
      if (owner && a.phone && !owner.profile.phone) { owner.profile.phone = phone.slice(0, 30); saveUser(owner); s._user = owner; }
      const qty = Math.min(10, Math.max(1, Math.round(Number(a.quantity) || 1)));
      // the retailer joins the network for this purchase: paid with PayPal like any other booking
      const id = 'shop_' + p.retailer.replace(/[^a-z0-9]+/gi, '_').toLowerCase().slice(0, 40);
      let m = MERCHANTS.find((x) => x.id === id);
      if (!m) { m = { id, name: p.retailer, category: 'shop', city: '', hasAgent: true, deposit: 1, pitch: 'Online retailer', rating: 4.5, offers: [], rules: 'Fixed online price.' }; MERCHANTS.push(m); }
      const total = round(p.price * qty);
      const opts = String(a.options || '').trim().slice(0, 60);
      const label = `${qty > 1 ? qty + ' × ' : ''}${p.title}${opts ? ` (${opts})` : ''} — ${langOf(s._user?.lang) === 'fr' ? 'livré à' : 'delivered to'} ${String(a.ship_to).slice(0, 80)}`;
      // The retailers do not give a delivery date: an estimate from usual times (3 to 7 working days), shown in
      // the Agenda once the order is paid, and said as an estimate.
      const day0 = localNow(s._user?.tz || 'UTC').slice(0, 10);
      const working = (n) => { let d = new Date(day0 + 'T12:00:00Z'), k = 0; while (k < n) { d.setUTCDate(d.getUTCDate() + 1); if (d.getUTCDay() % 6) k++; } return d.toISOString().slice(0, 10); };
      const delivery = { from: working(3), to: working(7) };
      const r = await runTool(s, 'hold_deposit', { merchant_id: m.id, amount: total, offer_total: total, label }, emit);
      if (r?.error) return r;
      (s.deliveries ||= []).push({ label, title: p.title, retailer: p.retailer, ...delivery, photo: p.image || p.photo || '', images: (p.images || []).slice(0, 5), price: p.price, qty, total, options: opts, url: p.url || '' });
      return { ...r, bought: p.title, total, retailer: p.retailer, link: p.url, delivery_estimate: delivery, courier_phone: maskedPhone(phone), note: `Paid with PayPal (or waiting for the user's approval). Tell the user in one or two sentences: what, how much, delivered where, the estimated delivery window (${delivery.from} to ${delivery.to}, an estimate from the retailer's usual times) and that the courier will call ${maskedPhone(phone)} (always write the number masked like this); the delivery is in their Agenda. In wrap_up, give the delivery its own line with when = "${delivery.from}".` };
    }
    case 'ask_quote': {
      const m = merchant(a.merchant_id);
      const photo = a.with_photo ? (s.photos || []).slice(-1)[0] : null;
      const thread = (s.threads[m.id] ||= []);
      const asked = `${String(a.details || '').slice(0, 600)}${photo?.desc ? `\n[The customer's photo shows: ${photo.desc}]` : ''}\nWhat would it cost, and when could you do it?`;
      emit('negotiation', { merchant_id: m.id, name: m.name, from: 'mandat', text: String(a.details || '').slice(0, 600), photo: photo?.url || '' });
      const r = await askMerchantAgent(m.id, thread, asked);
      if (r.offer?.items?.length) {
        const lines = r.offer.items.reduce((t, it) => t + (Number(it.qty) || 1) * (Number(it.unit_price) || 0), 0);
        const total = Math.round((lines - (Number(r.offer.discount) || 0)) * 100) / 100;
        if (Math.abs(total - (Number(r.offer.total) || 0)) > 0.5) r.offer.total = total;
      }
      emit('negotiation', { merchant_id: m.id, name: m.name, from: 'merchant', text: r.reply, offer: r.offer });
      return { ...r, note: 'Tell the user the price and what is included in one or two sentences, compare if you asked several shops, then ask whether to book and when they are available.' };
    }
    case 'calculate': {
      const expr = String(a.expression || '').replace(/,/g, '.').replace(/[×x]/g, '*').replace(/÷/g, '/').replace(/[€\s]/g, '');
      if (!/^[\d.+\-*/()%]+$/.test(expr) || expr.length > 200) return { error: 'Only numbers and + - * / ( ).' };
      try {
        const v = Function(`"use strict"; return (${expr});`)();
        if (!Number.isFinite(v)) return { error: 'Not a number.' };
        return { result: Math.round(v * 100) / 100 };
      } catch { return { error: 'That expression could not be read.' }; }
    }
    case 'negotiate': {
      const m = merchant(a.merchant_id);
      if (!m.hasAgent) return { error: `${m.name} has no AI agent. Use request_booking.` };
      const thread = (s.threads[m.id] ||= []);
      const tr = (s.transcripts[m.id] ||= []);
      tr.push({ from: 'mandat', text: a.message });
      emit('negotiation', { merchant_id: m.id, name: m.name, from: 'mandat', text: a.message });
      const r = await askMerchantAgent(m.id, thread, a.message);
      // A quote is checked by the code, never trusted: the total is recomputed from the lines.
      if (r.offer?.items?.length) {
        const lines = r.offer.items.reduce((t, it) => t + (Number(it.qty) || 1) * (Number(it.unit_price) || 0), 0);
        const total = Math.round((lines - (Number(r.offer.discount) || 0)) * 100) / 100;
        if (Math.abs(total - (Number(r.offer.total) || 0)) > 0.5) { r.offer.total_as_quoted = r.offer.total; r.offer.total = total; r.offer.note = 'Total corrected from the quote lines.'; }
      }
      tr.push({ from: 'merchant', text: r.reply, offer: r.offer });
      emit('negotiation', { merchant_id: m.id, name: m.name, from: 'merchant', text: r.reply, offer: r.offer });
      return r;
    }
    case 'move_booking': {
      const m = merchant(a.merchant_id);
      const when = String(a.new_time || '').trim().replace('T', ' ').slice(0, 16);
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(when)) return { error: 'new_time must be "YYYY-MM-DD HH:MM", in local time.' };
      const same = (x) => x && (x === m.name || x.includes(m.name) || m.name.includes(x));
      const r = Object.values(s.requests || {}).filter((x) => x.merchant_id === m.id && ['pending', 'accepted', 'confirmed', 'countered'].includes(x.status)).pop();
      const item = (s.plan || []).find((i) => i.status !== 'cancelled' && same(i.merchant));
      if (!r && !item) return { error: `Nothing is booked at ${m.name} to move. For a new booking, use request_booking.` };
      const from = r?.slot || item?.when || '';
      const what = r ? r.items.map((i) => `${i.qty}× ${i.label}`).join(', ') : item.what;
      if (m.hasAgent) {
        const thread = (s.threads[m.id] ||= []);
        const tr = (s.transcripts[m.id] ||= []);
        const ask = `Could we move our booking (${what}) from ${from} to ${when}? Same order, same price.`;
        tr.push({ from: 'mandat', text: ask });
        emit('negotiation', { merchant_id: m.id, name: m.name, from: 'mandat', text: ask });
        const rep = await askMerchantAgent(m.id, thread, ask);
        tr.push({ from: 'merchant', text: rep.reply });
        emit('negotiation', { merchant_id: m.id, name: m.name, from: 'merchant', text: rep.reply });
        if (!(await saysYes(rep.reply, `move the booking to ${when}`))) return { moved: false, merchant_reply: rep.reply, note: 'They cannot: the booking stays where it was. Tell the user and offer what they propose, if anything.' };
        if (r) r.slot = when;
        if (item) item.when = when;
        emit('plan', { items: s.plan });
        return { moved: true, from, to: when, merchant_reply: rep.reply, note: 'Moved, nothing more to pay. Move any reminder for it, then tell the user in one sentence.' };
      }
      if (!r) return { error: `${m.name} has no booking request to update: tell the user to contact them directly.` };
      if (r.status === 'countered') return { error: `${m.name} already proposed ${r.counterSlot}. To take it or ask for another time, send request_booking for that time.` };
      if (r.status === 'pending') { // not answered yet: the open request simply asks for the new time
        r.slot = when;
        r.note = `${r.note || ''}\nNEW TIME: ${when} (instead of ${from}).`.trim();
        if (item) item.when = when;
        emit('request', r);
        emit('plan', { items: s.plan });
        return { asked: true, from, to: when, note: `The request to ${m.name} now asks for ${when}; they have not answered yet. Nothing more is paid.` };
      }
      // An accepted booking stays exactly as it is (status, deposit, budget) while the merchant answers the
      // time change, which travels as its own question.
      r.move = { from: r.move?.from || from, to: when, at: new Date().toISOString(), itemStatus: r.move ? r.move.itemStatus : item?.status || 'confirmed' };
      if (item) { item.when = when; item.status = 'requested'; }
      emit('request', r);
      emit('plan', { items: s.plan });
      return { asked: true, from, to: when, note: `${m.name} confirms the new time from their inbox; you will be told. Tell the user it is asked and that nothing more is paid.` };
    }
    case 'request_booking': {
      const m = merchant(a.merchant_id);
      { const ob = await obsoleteFirst(s); if (ob) return { error: `Before booking anything new, deal with what the user replaced: ${ob.join('; ')}. Release those held deposits now with cancel_hold, mark the replaced items cancelled with update_plan, and ask the user before any refund_payment of something already paid (say what it costs). Then book the new choice.` }; }
      { const miss = needsPlace(m, a); if (miss) return { error: miss }; }
      if (refused(s, m.id)) return { error: `The user declined the payment at ${m.name}. Do not retry it: ask them what they prefer instead.` };
      // Never swap in another product, and never send a request the mandate cannot pay.
      const unknown = (a.items || []).filter((it) => !m.offers.some((x) => x.sku === it.sku));
      if (!a.items?.length || unknown.length) return { error: `${m.name} does not sell that. What they offer: ${m.offers.map((o) => `${o.sku} (${o.label}, ${o.price} €)`).join('; ')}. Tell the user honestly and look elsewhere if it does not fit.` };
      const items = a.items.map((it) => {
        const o = m.offers.find((x) => x.sku === it.sku);
        return { sku: o.sku, label: o.label, qty: Math.min(20, Math.max(1, Math.round(Number(it.qty) || 1))), unit_price: o.price };
      });
      const total = round(items.reduce((t, it) => t + it.qty * it.unit_price, 0));
      const left = round(s.envelope.total - committedOf(s)); // what is really free, every booking counted at full price
      if (total > left + 0.5) return { error: `This would cost ${Env.fmt(total, s.envelope)}, more than the ${Env.fmt(left, s.envelope)} really left in the budget (everything booked counted at full price). Request not sent. Tell the user and suggest a cheaper option or a higher budget.` };
      const when = String(a.slot || '').match(/\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?/)?.[0]?.replace('T', ' ');
      if (when && !a.conflict_ok) {
        const c = clashes(s._user, s, [{ what: `${m.name} booking`, merchant: m.name, when, kind: kindOf(m), status: 'requested' }], s._user?.tz || 'UTC').filter((x) => !x.with.mission || x.with.mission !== 'this mission' || x.with.what !== `${m.name} booking`);
        if (c.length) {
          showClashes(s, c, emit);
          return { not_sent: true, clashes: c.map((x) => x.text), info: 'Tell the user about the clash in one or two sentences and propose another time. If they confirm anyway, call again with conflict_ok: true.' };
        }
      }
      const id = 'r_' + crypto.randomBytes(4).toString('hex');
      const customer = s._user?.profile?.name || s._user?.paypal?.payerName || 'A Mandat customer';
      const req = { id, sessionId: s.id, merchant_id: m.id, merchant: m.name, items, total, deposit: round(total * m.deposit), slot: a.slot || '', where: String(a.where || '').slice(0, 160), note: a.note || '', customer, status: 'pending', inbox: inboxUrl(m.id, id), createdAt: new Date().toISOString() };
      s.requests[id] = req;
      await bookingCard(s, m, { what: [items.map((it) => (it.qty > 1 ? it.qty + ' × ' : '') + it.label).join(', '), a.slot].filter(Boolean).join(' · '), price: total, deposit: req.deposit, when: a.slot }, emit);
      emit('request', req);
      return { request_id: id, status: 'pending', total, deposit: req.deposit, info: 'The merchant will accept with one tap; you will be told. Continue with other bookings meanwhile.' };
    }
    case 'hold_deposit': {
      const m = merchant(a.merchant_id);
      { const ob = await obsoleteFirst(s); if (ob) return { error: `Before booking anything new, deal with what the user replaced: ${ob.join('; ')}. Release those held deposits now with cancel_hold, mark the replaced items cancelled with update_plan, and ask the user before any refund_payment of something already paid (say what it costs). Then book the new choice.` }; }
      { const miss = needsPlace(m, a); if (miss) return { error: miss }; }
      if (!refused(s, m.id)) await bookingCard(s, m, { what: a.label, price: Number(a.offer_total) || a.amount, deposit: Number(a.offer_total) > a.amount ? a.amount : null }, emit);
      if (refused(s, m.id)) return { error: `The user declined the payment at ${m.name}. Do not retry it: ask them what they prefer instead.` };
      const open = (s.clashes || []).filter((c) => c.what && (c.what.includes(m.name) || s.plan.some((i) => i.what === c.what && (i.merchant || '').includes(m.name))));
      if (open.length && !a.conflict_ok) return { error: `Not paid: this booking clashes — ${open.map((c) => c.text).join(' ')} Ask the user first; if they confirm, call again with conflict_ok: true.` };
      if (s._user) s.envelope.approveAbove = approveAboveFor(s._user); // autonomy changes apply immediately
      // the full price must fit in what is really left, not only the deposit
      const full = Math.max(Number(a.offer_total) || 0, a.amount);
      const linked = Object.values(s.requests || {}).some((r) => r.merchant_id === m.id && r.status === 'accepted' && !r.paymentId); // already counted as a request
      const free = round(s.envelope.total - committedOf(s) + (linked ? full : 0));
      if (full > free + 0.5) return { error: `Over budget at full price: ${Env.fmt(full, s.envelope)} for this, ${Env.fmt(free, s.envelope)} really left (everything booked counted at full price, balances due on site included). Not held. Tell the user and suggest a cheaper option or a higher budget.` };
      // The same payment is never made twice (a retry, a re-plan): the one already made stands.
      const twin = !a.again && s.envelope.entries.find((e) => e.merchant === m.name && Math.abs(e.amount - a.amount) < 0.01 && (e.state === 'held' || e.state === 'captured'));
      if (twin) return { error: `Already paid: ${Env.fmt(twin.amount, s.envelope)} at ${m.name} (${twin.label}), payment ${twin.id}. Never pay the same thing twice. Only if this is really another, different purchase, call again with again: true.` };
      const verdict = Env.check(s.envelope, a.amount);
      if (!verdict.ok) return { error: verdict.reason };
      const today = spentToday(s);
      const cap = s._user?.rules?.dailyCap;
      const overDaily = cap > 0 && today + a.amount > cap;
      if (verdict.needsApproval || overDaily) {
        // one open approval per merchant: the same request is shown again, a changed one replaces the old
        // just approved and being held right now: never shown again
        const deciding = Object.values(s.approvals).find((x) => x.status === 'deciding' && x.merchant_id === m.id && Math.abs(x.amount - a.amount) < 0.01);
        if (deciding) return { status: 'approved_being_held', approval_id: deciding.id, info: 'The user has just approved this payment; it is being held now. Do not ask again and do not call hold_deposit for it again.' };
        const open = Object.values(s.approvals).find((x) => x.status === 'pending' && x.merchant_id === m.id);
        if (open && Math.abs(open.amount - a.amount) < 0.01) {
          emit('approval', { ...open, place: placeOf(m) });
          return { status: 'awaiting_user_approval', approval_id: open.id, info: 'This payment is already waiting for the user: remind them to tap Approve on the payment card in Mandat. Do not ask for it again.' };
        }
        if (open) { open.status = 'superseded'; emit('approval_resolved', { id: open.id, superseded: true }); }
        const id = 'a_' + crypto.randomBytes(4).toString('hex');
        s.approvals[id] = { id, merchant_id: m.id, merchant: m.name, amount: round(a.amount), label: a.label, offer_total: a.offer_total, status: 'pending', at: Date.now(), ...(overDaily ? { reason: tr(s._user?.lang, 'Above your daily limit of {cap} ({today} already today)', { cap: money(s._user?.lang, cap, s.envelope.currency), today: money(s._user?.lang, today, s.envelope.currency) }) } : {}) };
        emit('approval', { ...s.approvals[id], place: placeOf(m) });
        return { status: 'awaiting_user_approval', approval_id: id, info: 'Ask the user to tap Approve on the payment card shown right here in Mandat (not in the PayPal app): PayPal then pays. Do not wait in silence.' };
      }
      return await doHold(s, { merchant: m, amount: a.amount, label: a.label, total: a.offer_total }, emit);
    }
    case 'refund_payment': {
      const e = s.envelope.entries.find((x) => x.id === a.payment_id);
      if (!e) return { error: 'Unknown payment' };
      if (e.state !== 'captured') return { error: e.state === 'held' ? 'Not paid yet: use cancel_hold to release it.' : `Nothing to refund: it is ${e.state}.` };
      const left = round(e.amount - (e.refunded || 0));
      const amount = round(Math.min(a.amount > 0 ? a.amount : left, left));
      const r = await PayPal.refund({ captureId: e.paypal.captureId, amount, currency: s.envelope.currency, note: a.reason });
      Env.refund(s.envelope, e.id, amount, { refundId: r.refundId, refundStatus: r.status });
      if (amount >= left) dropBooking(s, e, emit);
      emit('payment', { kind: 'refund', entry: { ...e, amount }, mode: r.mode, reason: a.reason });
      emit('envelope', envelopeView(s));
      return { refunded: amount, status: r.status, remaining: round(s.envelope.total - committedOf(s)) };
    }
    case 'open_approval': {
      const list = Object.values(s.approvals || {}).filter((x) => x.status === 'pending' && (!a.approval_id || x.id === a.approval_id));
      if (!list.length) return { error: 'Nothing is waiting for the user\'s approval right now.' };
      const ap = list[list.length - 1];
      let place;
      try { place = placeOf(merchant(ap.merchant_id)); } catch {}
      emit('approval', { ...ap, place });
      return { opened: ap.id, info: 'The PayPal sheet is now open on their screen. Tell them in one short sentence to hold the button to approve (or tap Refuse).' };
    }
    case 'cancel_hold': {
      const e = s.envelope.entries.find((x) => x.id === a.payment_id);
      if (!e) return { error: 'Unknown payment' };
      if (e.state !== 'held' || e.capturing) return { error: `It is ${e.capturing ? 'being collected' : e.state}, not held${e.state === 'captured' ? ': use refund_payment' : ''}.` };
      let r;
      try {
        r = await PayPal.release({ authorizationId: e.paypal.authorizationId });
      } catch (err) {
        // Said as it is, and not retried in a loop: the deposit is still held until PayPal releases it.
        e.releaseFailures = (e.releaseFailures || 0) + 1;
        return { error: `PayPal did not release this deposit (${err.message}). It is STILL HELD: never say it is cancelled.${e.releaseFailures >= 2 ? ' Do not try again in this turn: tell the user it is still held and that you will retry.' : ' You may try once more.'}` };
      }
      Env.release(s.envelope, e.id, { voidStatus: r.status });
      dropBooking(s, e, emit);
      emit('envelope', envelopeView(s));
      return { released: true, remaining: round(s.envelope.total - committedOf(s)) };
    }
    case 'close_mission': {
      s.closed = true;
      emit('closed', {});
      return { closed: true, note: 'Closed. Say in one short sentence that the mission is closed and what, if anything, still goes on by itself.' };
    }
    case 'split_bill': {
      const friends = (a.friends || []).map((f) => (typeof f === 'string' ? { name: f } : f)).filter((f) => f?.name);
      if (!friends.length || !(a.total > 0)) return { error: 'Give the total and at least one friend.' };
      const from = s._user?.profile?.name?.split(' ')[0] || s._user?.paypal?.payerName?.split(' ')[0] || 'A friend';
      let split;
      try {
        split = splitBill({ total: a.total, items: a.items, people: [{ name: from, payer: true, amount: a.my_amount }, ...friends.map((f) => ({ name: f.name, amount: f.amount }))] });
      } catch (e) {
        return { error: e.message };
      }
      const per = split.people[1]?.amount;
      const mail = (p) => p.email || (/@/.test(p.contact || '') ? p.contact : '');
      const known = Object.fromEntries((s._user?.profile?.people || []).filter(mail).map((p) => [p.name.toLowerCase(), mail(p)]));
      // Each friend's PayPal email is asked once (PayPal then sends them the request); the people already in the
      // profile are known. The user may prefer only the link and the QR code.
      const unknown = friends.filter((f) => !/@/.test(f.email || '') && !known[f.name.toLowerCase()]).map((f) => f.name);
      if (unknown.length && !a.no_email) return { error: `Before sending: ask the user, in one short question, for the PayPal email of ${unknown.join(', ')} so PayPal sends them the request (quick replies: "I'll type them" and "Just the link and QR code"). With the emails, call again with them; if they want only the link and QR code, call again with no_email: true.` };
      const links = await Promise.all(friends.map(async (f) => {
        const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email || '') ? f.email : known[f.name.toLowerCase()] || null;
        try {
          const person = split.people.find((p) => p.name === f.name);
          const r = await shareInvoice({ person, split, email, currency: s.envelope.currency, label: a.label, from, where: a.where, date: a.date, appUrl: publicUrl() });
          return { friend: f.name, email, amount: person.amount, ...r };
        } catch (e) {
          return { friend: f.name, amount: split.people.find((p) => p.name === f.name)?.amount, error: e.message.slice(0, 160) };
        }
      }));
      // New people with an email are saved, so next time "split with Sam" needs nothing more.
      const fresh = links.filter((l) => l.email && !known[l.friend.toLowerCase()]);
      const u = fresh.length && s.userId ? getUser(s.userId) : null;
      if (u) {
        u.profile.people ||= [];
        for (const l of fresh) if (!u.profile.people.some((p) => p.name.toLowerCase() === l.friend.toLowerCase())) u.profile.people.push({ name: l.friend, email: l.email });
        saveUser(u);
        if (s._user) s._user.profile.people = u.profile.people;
        for (const l of fresh) emit('memory', { action: 'added', scope: 'global', text: `${l.friend} · ${l.email}` });
      }
      const at = new Date().toISOString();
      s.shares.push(...links.map((l) => ({ ...l, label: a.label, at })));
      const breakdown = { total: split.total, equal: split.equal, rounding: split.rounding, where: a.where || '', date: a.date || '', people: split.people.map(({ name, amount, payer }) => ({ name, amount, payer })), items: split.people[0].lines.filter((l) => l.name).map(({ name, total }) => ({ name, total })) };
      emit('shares', { label: a.label, per, links, breakdown });
      return { shares: split.people.map(({ name, amount }) => ({ name, amount })), invoices: links.map((l) => ({ friend: l.friend, emailed: !!l.emailed, ok: !l.error, ...(l.error ? { error: l.error } : {}) })), info: 'Each friend can pay from the email, the link or the QR code on screen; you will see when they pay.' };
    }
    case 'update_plan': {
      s.plan = a.items || [];
      emit('plan', { items: s.plan });
      pruneReminders(s, emit);
      settleApprovals(s, emit);
      const c = clashes(s._user, s, s.plan, s._user?.tz || 'UTC');
      s.clashes = c;
      const fresh = showClashes(s, c, emit);
      // A senior planner looks at the plan: what is essential and missing, what is in the wrong order.
      const review = await reviewPlan(s).catch(() => null);
      const out = c.length ? { ok: true, clashes: c.map((x) => x.text), info: fresh.length ? 'Tell the user about each clash and propose a fix before paying anything that is affected.' : 'Known clashes, already shown to the user.' } : { ok: true };
      if (review?.missing?.length || review?.issues?.length) Object.assign(out, { review, must: 'Fix this before booking anything else: cancel what is obsolete, add the missing essentials to the plan and book them first, in a sensible order.' });
      return out;
    }
    default:
      return { error: 'Unknown tool ' + name };
  }
}

// Hold a deposit for real (PayPal authorization through the vaulted mandate) and book it in the envelope.
export async function doHold(s, { merchant: m, amount, label, total }, emit, { approved = false } = {}) {
  // The account is read again now: Stop everything and a revoked mandate apply even in the middle of a turn.
  if (s._cancelled) return { error: 'The mission was deleted.' };
  const fresh = s.userId ? getUser(s.userId) : null;
  if (fresh) s._user = fresh;
  if (s.frozen || fresh?.frozen) return { error: 'The user has stopped the agent. Do not pay; tell them the plan is paused.' };
  const mandate = fresh ? fresh.paypal?.mandate : s.mandate;
  if (!mandate) return { error: 'The user has not signed the PayPal mandate yet.' };
  amount = round(Number(amount));
  if (!(amount > 0)) return { error: 'Give a positive amount.' };
  // Checked again right before PayPal: several approvals can pile up on the same budget.
  const verdict = Env.check(s.envelope, amount);
  if (!verdict.ok) return { error: verdict.reason };
  const cap = fresh?.rules?.dailyCap;
  if (!approved && cap > 0 && spentToday(s) + amount > cap) return { error: 'Above the daily limit: ask the user to approve this payment.' };
  const ref = 'p_' + crypto.randomBytes(4).toString('hex');
  const pp = await PayPal.hold({ paymentTokenId: mandate.paymentTokenId, amount, currency: s.envelope.currency, merchant: m.name, description: label, reference: ref });
  let entry;
  try {
    entry = Env.hold(s.envelope, { id: ref, merchant: m.name, label, amount, paypal: pp });
  } catch (e) {
    await PayPal.release({ authorizationId: pp.authorizationId }).catch(() => {}); // never leave money held at PayPal unrecorded
    return { error: e.message };
  }
  emit('payment', { kind: 'hold', entry, mode: pp.mode, place: placeOf(m) });
  // A merchant without an AI: the deposit waits for them to confirm from their inbox.
  const req = Object.values(s.requests || {}).find((r) => r.merchant_id === m.id && r.status === 'accepted' && !r.paymentId);
  if (req) req.paymentId = entry.id;
  // the full price of what this deposit secures: the budget counts it whole, not just the deposit
  entry.total = round(Math.max(amount, Number(req?.total) || Number(total) || 0));
  // A merchant with its own agent confirms the booking on the spot: the deposit is paid now.
  if (m.hasAgent) {
    const c = await captureEntry(s, entry.id, emit, 'Confirmed by their AI agent');
    emit('envelope', envelopeView(s));
    return { payment_id: entry.id, status: 'paid', note: `${m.name}'s agent confirmed; deposit paid (capture ${c.captureId}). The rest is paid on site.`, remaining: round(s.envelope.total - committedOf(s)) };
  }
  emit('envelope', envelopeView(s));
  return { payment_id: entry.id, status: 'held', note: req ? `Held; ${m.name} collects it when they confirm from their inbox.` : 'Held until the merchant confirms.', paypal_authorization: pp.authorizationId, remaining: round(s.envelope.total - committedOf(s)) };
}

// The merchant confirmed: capture the held deposit (the money moves to the merchant).
export async function captureEntry(s, entryId, emit, why) {
  const e = s.envelope.entries.find((x) => x.id === entryId);
  if (!e || e.state !== 'held' || e.capturing) throw new Error('Nothing held to collect.');
  e.capturing = true; // a double tap or a release at the same moment cannot touch it now
  let pp;
  try {
    pp = await PayPal.capture({ authorizationId: e.paypal.authorizationId, amount: e.amount, currency: s.envelope.currency });
  } finally {
    delete e.capturing;
  }
  Env.capture(s.envelope, e.id, { captureId: pp.captureId, captureStatus: pp.status });
  emit('payment', { kind: 'capture', entry: e, mode: pp.mode, why });
  return pp;
}

// Money committed today (held or paid) across all of the user's missions, for the daily limit.
// Missions running right now are read from memory, not disk: two at once must not pass the daily limit together.
let liveOf = () => null;
export function setLiveLookup(fn) { liveOf = fn; }
function spentToday(s) {
  const day = new Date().toISOString().slice(0, 10);
  const missions = [s, ...(s._user?.missions || []).filter((id) => id !== s.id).map((id) => liveOf(id) || getMission(id)).filter(Boolean)];
  return round(missions.flatMap((m) => m.envelope.entries).filter((e) => (e.state === 'held' || e.state === 'captured') && String(e.at).startsWith(day)).reduce((t, e) => t + e.amount - (e.refunded || 0), 0));
}

// The user tapped Approve (or Decline) on a pending payment.
export async function resolveApproval(s, approvalId, approved, emit) {
  const ap = s.approvals[approvalId];
  // Already answered (a second tap, an old card, or settled meanwhile): nothing to do, and no error on screen.
  // The card is told its real state so it closes.
  if (!ap || (ap.status !== 'pending' && ap.status !== 'deciding')) {
    emit('approval_resolved', { id: approvalId, approved: ap?.status === 'approved', superseded: ap ? ap.status !== 'approved' && ap.status !== 'declined' : true });
    return;
  }
  ap.status = approved ? 'approved' : 'declined';
  if (!approved) {
    emit('approval_resolved', { id: approvalId, approved: false });
    (s.declined ||= {})[ap.merchant_id] = s.messages.length;
    return userTurn(s, `[system] The user declined the payment "${ap.label}" (${ap.amount}) at ${ap.merchant}. Respect it: do not book or pay that again. Ask them in one short sentence what they prefer instead (another option, another time, or drop it), with ready answers.`, emit);
  }
  const twin = s.envelope.entries.find((e) => e.merchant === ap.merchant && Math.abs(e.amount - ap.amount) < 0.01 && (e.state === 'held' || e.state === 'captured'));
  if (twin) {
    ap.status = 'superseded';
    emit('approval_resolved', { id: approvalId, superseded: true });
    return userTurn(s, `[system] That payment (${ap.label}, ${ap.amount} at ${ap.merchant}) was already made (payment ${twin.id}): nothing was paid twice. Tell the user in one short sentence that it is already paid.`, emit);
  }
  const r = await doHold(s, { merchant: merchant(ap.merchant_id), amount: ap.amount, label: ap.label, total: ap.offer_total }, emit, { approved: true });
  emit('approval_resolved', { id: approvalId, approved: true, result: r });
  if (r.error) return userTurn(s, `[system] The user approved ${ap.label} (${ap.amount}) but it could not be held: ${r.error} Tell the user plainly and adapt the plan.`, emit);
  return userTurn(s, `[system] The user approved: ${ap.label}, ${ap.amount} held with PayPal (${JSON.stringify(r)}). Continue the plan.`, emit);
}

// A merchant without an AI agent accepted (or declined) a booking request from its inbox.
// The merchant answered from their inbox: accept, decline, or propose another time.
export async function resolveRequest(s, requestId, { action, slot, message } = {}, emit) {
  const req = s.requests[requestId];
  if (req?.move) return resolveMove(s, req, { action, slot, message }, emit);
  if (!req || req.status !== 'pending') throw new Error('This request was already answered.');
  req.status = action === 'accept' ? 'accepted' : action === 'counter' ? 'countered' : 'declined';
  if (action === 'counter') req.counterSlot = String(slot || '').slice(0, 80);
  if (message) req.reply = String(message).slice(0, 300);
  req.answeredAt = new Date().toISOString();
  emit('request', req);
  const said = req.reply ? ` Their message: "${req.reply}".` : '';
  const note = action === 'accept'
    ? `[system] ${req.merchant} accepted the booking request (${req.slot}). Total ${req.total}, deposit ${req.deposit}.${said} Hold the deposit now with hold_deposit and update the plan.`
    : action === 'counter'
      ? `[system] ${req.merchant} cannot do ${req.slot || 'that time'} but proposes ${req.counterSlot}.${said} Ask the user if that works; if yes, send a new request_booking for that slot.`
      : `[system] ${req.merchant} declined the booking request.${said} Find an alternative.`;
  return userTurn(s, note, emit);
}

// The merchant answers a time change: the same booking moves, or stays where it was. Its status, deposit and
// budget never change; only the time does.
function resolveMove(s, req, { action, slot, message }, emit) {
  const { from, to, itemStatus } = req.move;
  const same = (x) => x && x === req.merchant;
  const item = (s.plan || []).find((i) => i.status !== 'cancelled' && same(i.merchant) && (i.when === to || i.when === from));
  if (message) req.reply = String(message).slice(0, 300);
  req.answeredAt = new Date().toISOString();
  const ok = action === 'accept';
  if (ok) req.slot = to;
  if (item) { item.when = ok ? to : from; item.status = itemStatus || 'confirmed'; }
  delete req.move;
  emit('request', { ...req, moved: ok ? 'yes' : 'no', proposed: action === 'counter' ? String(slot || '').slice(0, 80) : '' });
  emit('plan', { items: s.plan });
  const said = req.reply ? ` Their message: "${req.reply}".` : '';
  const note = ok
    ? `[system] ${req.merchant} accepted to move the booking from ${from} to ${to}.${said} Nothing more to pay; the plan is updated. Move any reminder for it and tell the user in one sentence.`
    : `[system] ${req.merchant} cannot move the booking to ${to}${action === 'counter' && slot ? `; they propose ${slot}` : ''}.${said} The booking stays at ${from}. Tell the user; if they want the proposed time, use move_booking again.`;
  return userTurn(s, note, emit);
}

// The brand and model printed on the main object, read five times independently; the majority spelling,
// letter by letter, is kept. Null when nothing is printed or the readings do not agree enough to trust.
async function readPrinted(dataUrl) {
  const once = () => chat({
    model: MODELS.fast, json: true, maxTokens: 6000, timeoutMs: 70000, temperature: 0.2,
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'Do not deliberate. Copy exactly the brand name and model name printed on the main object of this photo (on the object itself, not the background), letter by letter as written. Nothing printed or not readable: empty string. JSON only: {"printed":"..."}' },
      { type: 'image_url', image_url: { url: dataUrl } },
    ] }],
  }).then(({ message }) => String(JSON.parse(message.content || '{}').printed || '').trim()).catch(() => '');
  const reads = (await Promise.all([once(), once(), once(), once(), once()])).filter(Boolean);
  if (reads.length < 2) return null;
  const { message } = await chat({ model: MODELS.fast, json: true, maxTokens: 3000, temperature: 0, messages: [{ role: 'user', content: `Do not deliberate. Independent readings of the same printed label: ${reads.map((r) => JSON.stringify(r)).join(', ')}. Give the most likely exact spelling: the majority reading, letter by letter, with normal capitalisation of a brand name. A reader misses a letter far more often than it invents one: when readings differ only by one letter missing in some, keep that letter. If the readings are about different words altogether, trust none. JSON only: {"name":"..." or null}` }] });
  const name = JSON.parse(message.content || '{}').name;
  return typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : null;
}

async function describeImage(dataUrl, ask) {
  const { message } = await chat({
    model: MODELS.fast,
    maxTokens: 8000, // it reasons before writing: a small budget leaves the description empty
    timeoutMs: 70000,
    messages: [{ role: 'user', content: [
      { type: 'text', text: `The user sent this photo to their personal booking/paying agent${ask ? ` with the words: "${ask}"` : ''}. Describe precisely what matters to act on it. An object: first copy every word, number or logo printed on it exactly as you read it (letters you cannot read: ?). Name a brand or a model ONLY if you read it written on the item, and say where ("G2 MAX" on the stem); never guess a brand from the shape or colours, write "brand not readable" instead. Then what it is, colour, size, distinctive parts (wheel size, seat, bag, display), condition and any damage (where, how bad). A receipt, menu, ticket or document: business names, items with prices, dates and times, addresses, totals. A place: what it is and its atmosphere. A person or a style: what they wear or like, only when the request is about them (otherwise leave out people in the picture). Plain text, max 110 words.` },
      { type: 'image_url', image_url: { url: dataUrl } },
    ] }],
  });
  return (message.content || '').trim().slice(0, 900);
}

// One line per mission for the home screen.
// What the home screen needs to sort missions by urgency and say, in plain words, what is going on.
export function missionSummary(s, { busy = false } = {}) {
  const t = Env.totals(s.envelope);
  const approval = Object.values(s.approvals).find((a) => a.status === 'pending');
  const request = Object.values(s.requests || {}).find((r) => r.status === 'pending');
  const items = (s.plan || []).filter((i) => i.status !== 'cancelled');
  const done = items.filter((i) => ['held', 'confirmed'].includes(i.status)).length;
  const lastSay = [...s.messages].reverse().find((m) => m.role === 'assistant' && m.content?.trim())?.content.trim() || '';
  const lastUserIdx = s.messages.map((m) => m.role).lastIndexOf('user');
  const lastSayIdx = s.messages.map((m) => m.role === 'assistant' && !!m.content?.trim()).lastIndexOf(true);
  const asks = !busy && lastSayIdx > lastUserIdx && /\?\s*$/.test(lastSay); // the agent's last word is a question to you
  let status, needs = '';
  // `needs` stays in English (search, notifications); `need` lets the app write it in its own language.
  let need = null;
  if (s.frozen) status = 'stopped';
  else if (approval) { status = 'needs_you'; needs = `Approve ${Env.fmt(approval.amount, s.envelope)} at ${approval.merchant}`; need = { k: 'approve', amount: approval.amount, merchant: approval.merchant }; }
  else if (asks) { status = 'needs_you'; const question = lastSay.split(/(?<=[.!])\s+/).filter((x) => x.includes('?')).pop()?.slice(0, 110); needs = 'Answer: ' + question; need = { k: 'answer', question }; }
  else if (busy) status = 'working';
  else if (request) { status = 'waiting'; needs = `Waiting for ${request.merchant} to accept`; need = { k: 'accept', merchant: request.merchant }; }
  else if (Object.values(s.requests || {}).some((r) => r.status === 'accepted' && s.envelope.entries.find((e) => e.id === r.paymentId)?.state === 'held')) {
    const r = Object.values(s.requests).find((x) => x.status === 'accepted' && x.paymentId);
    status = 'waiting'; needs = `Deposit held · waiting for ${r.merchant} to confirm`; need = { k: 'confirm', merchant: r.merchant };
  }
  else if (items.length && done === items.length) status = 'done';
  // Closed with its recap, or a bill split whose payment requests are sent: done. A friend paying later (or never)
  // shows on the share, it does not keep the mission live.
  else if (s.wrapped || s.closed || ((s.shares || []).some((x) => x.invoiceId) && !items.some((i) => !['held', 'confirmed'].includes(i.status)))) status = 'done';
  else status = s.messages.length ? 'idle' : 'new';
  const lastAt = (s.feed?.length ? s.feed[s.feed.length - 1].at : null) || Date.parse(s.createdAt);
  return {
    id: s.id, title: s.title, emoji: !s.emoji || s.emoji === '✦' || s.emoji === '✨' ? emojiFor(`${s.title} ${s.envelope?.purpose || ''}`) : s.emoji, createdAt: s.createdAt, lastAt, archived: !!s.archived,
    status, needs, need, last: lastSay.slice(0, 140),
    total: t.total, remaining: round(t.total - committedOf(s)), held: t.held, spent: t.spent, currency: t.currency,
    progress: items.length ? { done, of: items.length } : null,
  };
}

// The budget, the way a person counts it: every booking at its full price (the deposit paid now and the
// balance paid on site), plus what merchants are being asked for. "left" is what is really free to plan.
// The full price a deposit secures (older deposits did not record it: found in the request or the plan).
function fullOf(s, e) {
  if (e.total) return Math.max(e.amount, e.total);
  const r = Object.values(s.requests || {}).find((x) => x.paymentId === e.id);
  if (r?.total) return Math.max(e.amount, Number(r.total));
  const i = (s.plan || []).find((x) => x.total > 0 && x.merchant && e.merchant && (x.merchant.includes(e.merchant) || e.merchant.includes(x.merchant)));
  return Math.max(e.amount, Number(i?.total) || 0);
}
// One booking per supplier: a deposit and its top-up (a caterer whose package grew from 3,480 to 3,980) are the
// same booking, counted once at its latest full price. Purchases paid in full stay one line each.
function bookingsOf(s) {
  const active = (e) => e.state === 'held' || e.state === 'captured';
  const groups = [], bySupplier = new Map();
  for (const e of s.envelope.entries.filter(active)) {
    const full = fullOf(s, e), paid = round(e.amount - (e.refunded || 0));
    if (!(full > e.amount + 0.5)) { groups.push({ merchant: e.merchant, label: e.label, total: Math.max(full, paid), paid, entries: [e] }); continue; }
    const g = bySupplier.get(e.merchant);
    if (g) { g.total = Math.max(g.total, full); g.paid = round(g.paid + paid); g.label = e.label; g.entries.push(e); continue; }
    const n = { merchant: e.merchant, label: e.label, total: full, paid, entries: [e] };
    bySupplier.set(e.merchant, n);
    groups.push(n);
  }
  return groups;
}
// A request still counts unless the plan dropped that supplier (and nothing is paid to it).
const requestStands = (s, r) => !((s.plan || []).some((i) => i.merchant === r.merchant && i.status === 'cancelled') && !(s.plan || []).some((i) => i.merchant === r.merchant && i.status !== 'cancelled'));
export function committedOf(s) {
  let c = 0;
  const active = (e) => e.state === 'held' || e.state === 'captured';
  const groups = bookingsOf(s);
  for (const g of groups) c += Math.max(g.total, g.paid);
  for (const r of Object.values(s.requests || {})) {
    if (!['pending', 'accepted', 'confirmed'].includes(r.status) || !requestStands(s, r)) continue;
    if (r.paymentId && s.envelope.entries.some((e) => e.id === r.paymentId && active(e))) continue; // already counted
    if (groups.some((g) => g.merchant === r.merchant && g.total > g.paid + 0.5)) continue; // same supplier, already booked
    c += Number(r.total) || 0;
  }
  return round(c);
}
// Who is still to be paid, how much, and when: the balance of every booking beyond its deposit, and what
// is owed to merchants who accepted but have not been paid anything yet. This money stays set aside.
export function balancesOf(s) {
  const out = [];
  const active = (e) => e.state === 'held' || e.state === 'captured';
  for (const g of bookingsOf(s)) {
    if (!(g.total > g.paid + 0.5)) continue;
    const ids = g.entries.map((e) => e.id);
    const r = Object.values(s.requests || {}).find((x) => ids.includes(x.paymentId));
    const item = (s.plan || []).find((i) => i.merchant && g.merchant && (i.merchant.includes(g.merchant) || g.merchant.includes(i.merchant)));
    out.push({ merchant: g.merchant, label: g.label, deposit: g.paid, total: g.total, balance: round(g.total - g.paid), when: r?.slot || item?.when || '', how: 'on site' });
  }
  for (const r of Object.values(s.requests || {})) {
    if (!['accepted', 'confirmed'].includes(r.status) || !requestStands(s, r) || (r.paymentId && s.envelope.entries.some((e) => e.id === r.paymentId && active(e)))) continue;
    if (out.some((x) => x.merchant === r.merchant)) continue;
    out.push({ merchant: r.merchant, label: r.items.map((i) => i.label).join(', '), deposit: 0, total: r.total, balance: r.total, when: r.slot || '', how: 'not paid yet' });
  }
  return out;
}
// The mission's books, line by line, straight from the payments and the requests: what each supplier is
// booked for, its full price, what was paid or held, the balance and when, what was cancelled or refunded.
// Given to the agent at every step, so it never answers a money question from memory.
export function ledgerBrief(s) {
  const f = (v) => Env.fmt(round(v), s.envelope);
  const day = (x) => (/^\d{4}-\d{2}-\d{2}/.test(x || '') ? String(x).slice(0, 16) : '');
  const lines = [];
  for (const e of s.envelope.entries) {
    const r = Object.values(s.requests || {}).find((x) => x.paymentId === e.id);
    if (e.state === 'held' || e.state === 'captured') {
      const full = fullOf(s, e), bal = round(full - e.amount);
      lines.push(`- ${e.merchant}: ${e.label}. Full price ${f(full)}; ${e.state === 'captured' ? 'paid' : 'held'} ${f(e.amount - (e.refunded || 0))}${bal > 0.5 ? `; balance ${f(bal)} to pay on site${day(r?.slot) ? ' ' + day(r.slot) : ''}` : '; nothing more to pay'}.`);
    } else lines.push(`- ${e.merchant}: ${e.label}. Cancelled: ${f(e.amount)} ${e.state === 'refunded' ? 'refunded' : 'released (never charged)'}.`);
  }
  for (const r of Object.values(s.requests || {})) {
    if (r.paymentId && s.envelope.entries.some((e) => e.id === r.paymentId)) continue;
    lines.push(`- ${r.merchant}: ${r.items.map((i) => `${i.qty}× ${i.label}`).join(', ')}${r.slot ? ' (' + r.slot + ')' : ''}. Request ${r.status}; total ${f(r.total)}; nothing paid yet.`);
  }
  if (!lines.length) return '';
  // The totals, computed here: the agent reads them, it never adds them up itself.
  const t = Env.totals(s.envelope), committed = committedOf(s);
  const due = round(balancesOf(s).reduce((x, b) => x + b.balance, 0));
  const asked = round(Object.values(s.requests || {}).filter((r) => ['pending', 'countered'].includes(r.status) && !r.paymentId).reduce((x, r) => x + (Number(r.total) || 0), 0));
  lines.push(`TOTALS (computed, read them as they are): booked or requested at full price ${f(committed)}; paid now ${f(t.spent)}; held now ${f(t.held)}; still to pay to suppliers ${f(due)}${asked ? `; of which waiting for an answer ${f(asked)}` : ''}; budget ${f(s.envelope.total)}; really left ${f(s.envelope.total - committed)}.`);
  return lines.join('\n');
}
export function envelopeView(s) {
  const committed = committedOf(s);
  const balances = balancesOf(s);
  return { ...Env.totals(s.envelope), committed, left: round(s.envelope.total - committed), balances, due: round(balances.reduce((t, b) => t + b.balance, 0)), approveAbove: s.envelope.approveAbove, entries: s.envelope.entries, mandate: s.mandate ? { mode: s.mandate.mode } : null };
}

function publicUrl() {
  return process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:8790';
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

function round(x) {
  return Math.round(x * 100) / 100;
}

// The "All set" recap: what is booked, money, reminders — built from the agent's words and the mission state.
// What is left of the model's JSON around a sentence ('…rechange."]') never reaches the screen.
const tidy = (x) => { let v = String(x ?? '').trim().replace(/^[\["'{\s]+(?=\S)/, '').replace(/["']?[\]}]+\s*$/, ''); if (/"$/.test(v) && (v.match(/"/g) || []).length % 2) v = v.slice(0, -1); return v.trim(); };
// What a line of the recap is, to unfold it: the product bought (photos, price, link) or the place booked
// (photo, address, amount paid). Matched by name; nothing invented when nothing matches.
// Recaps already in the history are unfolded with what is known now (older ones had no previews).
export function refreshRecaps(s) {
  for (const e of s.feed || []) if (e.type === 'wrapup' && Array.isArray(e.data?.lines)) e.data.lines = e.data.lines.map((l) => ({ ...l, preview: linePreview(s, l) }));
}
function linePreview(s, l) {
  const words = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
  const hay = new Set(words(`${l.what} ${l.where || ''}`));
  const score = (t) => words(t).filter((w) => hay.has(w)).length;
  // The best matching order wins (its title or its shop in the line); a single strong word is enough when
  // the line is in French and the product name in another language.
  const ranked = (s.deliveries || []).map((x) => [x, score(`${x.title} ${x.retailer}`), words(`${x.title} ${x.retailer}`).filter((w) => hay.has(w) && w.length >= 6).length]).sort((a, b) => b[1] - a[1] || b[2] - a[2]);
  const d = ranked[0];
  if (d && (d[1] >= 2 || d[2] >= 1) && !(ranked[1] && ranked[1][1] === d[1] && ranked[1][2] === d[2])) {
    const x = d[0];
    // orders made before photos were kept: the product found earlier in the mission still has them
    const prod = Object.values(s.products || {}).find((p) => p.title === x.title && (!x.retailer || p.retailer === x.retailer)) || {};
    const images = (x.images?.length ? x.images : prod.images?.length ? prod.images : [x.photo || prod.image || prod.photo]).filter(Boolean).slice(0, 5);
    const price = Number(x.price ?? prod.price) || null;
    const qty = x.qty || 1;
    const paid = (s.envelope.entries || []).find((e) => e.label === x.label && (e.state === 'captured' || e.state === 'held'))?.amount;
    return { kind: 'product', title: x.title, photo: images[0] || '', images, price, qty, total: Number(x.total) || paid || (price ? price * qty : null), options: x.options || '', retailer: x.retailer, url: x.url || prod.url || '', from: x.from, to: x.to };
  }
  const m = MERCHANTS.find((x) => x.name && x.name === l.where) || MERCHANTS.find((x) => x.name && score(x.name) >= Math.min(2, words(x.name).length) && words(x.name).length > 0);
  if (!m) return null;
  let place = {};
  try { place = placeOf(m) || {}; } catch {}
  const kept = s.placeInfo?.[m.id] || {};
  const paid = (s.envelope.entries || []).filter((e) => e.merchant === m.name && (e.state === 'captured' || e.state === 'held')).reduce((t, e) => t + e.amount, 0);
  return { kind: 'place', title: m.name, photo: place.photo || kept.photos?.[0] || '', images: kept.photos?.length ? kept.photos : place.photo ? [place.photo] : [], address: place.address || kept.address || '', paid: round(paid), rating: m.rating || null };
}
export function wrapCard(s, a = {}) {
  a = { ...a, headline: a.headline && tidy(a.headline), note: a.note && tidy(a.note), lines: a.lines?.map((l) => ({ ...l, what: tidy(l.what), where: l.where && tidy(l.where) })) };
  const t = Env.totals(s.envelope);
  const items = (s.plan || []).filter((i) => i.status !== 'cancelled');
  const lines = (a.lines?.length ? a.lines : items.map((i) => ({ when: i.when, what: i.what, where: i.merchant }))).slice(0, 12).map((l) => ({ ...l, preview: linePreview(s, l) }));
  const reminders = (s.reminders || []).filter((r) => !r.sent).map((r) => ({ at: r.at, text: r.text }));
  return {
    headline: a.headline || tr(s._user?.lang, items.length > 1 ? 'Everything is booked' : 'All set'),
    lines, note: a.note || '',
    paid: t.spent, held: t.held, currency: t.currency, reminders,
    balances: balancesOf(s), due: round(balancesOf(s).reduce((x, b) => x + b.balance, 0)), left: round(s.envelope.total - committedOf(s)),
    at: new Date().toISOString(),
  };
}
// A phone number is only ever written masked ("06 •• •• •• 78"): it shows on screen, in recordings and screenshots.
const maskedPhone = (p) => { const n = (String(p).match(/\d/g) || []).length; let i = 0; return String(p).replace(/\d/g, (d) => (++i <= 2 || i > n - 2 ? d : '•')); };
// A cancelled booking takes its reminders with it: no "time to go" for an appointment that no longer exists.
// A reminder belongs to a booking when it names the merchant (in its place or text) and, when both are dated,
// is for the same time; it stays if another live booking still matches it.
function pruneReminders(s, emit) {
  const names = (m) => { const n = String(m || '').toLowerCase(); const w = n.split(/[^\p{L}\p{N}]+/u).filter((x) => x.length >= 5).sort((a, b) => b.length - a.length)[0]; return [n, w].filter(Boolean); };
  const about = (r, i) => {
    const hay = `${r.place || ''} ${r.text || ''}`.toLowerCase();
    if (!i.merchant || !names(i.merchant).some((n) => hay.includes(n))) return false;
    return !r.eventAt || !i.when || String(i.when).slice(0, 16) === String(r.eventAt).slice(0, 16);
  };
  const plan = s.plan || [];
  const gone = plan.filter((i) => i.status === 'cancelled');
  const live = plan.filter((i) => i.status !== 'cancelled');
  const drop = (s.reminders || []).filter((r) => !r.sent && gone.some((i) => about(r, i)) && !live.some((i) => about(r, i)));
  if (!drop.length) return 0;
  s.reminders = s.reminders.filter((r) => !drop.includes(r));
  for (const r of drop) emit('reminder_off', { id: r.id });
  return drop.length;
}
// Approvals that no longer stand are closed, so nothing asks the user to approve a payment that is already
// made, replaced by a newer request, or for a booking the plan dropped. Returns the ids it closed.
export function settleApprovals(s, emit = () => {}) {
  const list = Object.values(s.approvals || {});
  const closed = [];
  list.forEach((ap, k) => {
    if (ap.status !== 'pending') return;
    const paid = (s.envelope?.entries || []).some((e) => e.merchant === ap.merchant && Math.abs(e.amount - ap.amount) < 0.01 && (e.state === 'held' || e.state === 'captured'));
    // a newer request to the same merchant, or to another of the same kind (it changed baker), replaces it
    const kind = (x) => { try { return merchant(x.merchant_id).category; } catch { return ''; } };
    const newer = list.slice(k + 1).some((x) => x.merchant_id === ap.merchant_id || (x.status !== 'declined' && kind(x) && kind(x) !== 'shop' && kind(x) === kind(ap)));
    // dropped: cancelled in the plan, or a supplier (not an online shop) the plan no longer has at all
    const inPlan = (s.plan || []).some((i) => i.merchant === ap.merchant && i.status !== 'cancelled');
    const settled = !ap.at || Date.now() - ap.at > 10 * 60000; // a fresh request may come before its plan line
    const dropped = !inPlan && ((s.plan || []).some((i) => i.merchant === ap.merchant && i.status === 'cancelled') || (settled && (s.plan || []).length > 0 && !String(ap.merchant_id).startsWith('shop_')));
    if (paid || newer || dropped) { ap.status = 'superseded'; closed.push(ap.id); emit('approval_resolved', { id: ap.id, superseded: true }); }
  });
  return closed;
}
// Safety net: default reminders for timed bookings when the agent did not set any.
export function autoReminders(s, tz = 'UTC') {
  const out = [];
  if ((s.reminders || []).some((r) => !r.sent)) return out;
  for (const i of (s.plan || []).filter((x) => ['confirmed', 'held'].includes(x.status) && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(x.when || ''))) {
    const ev = localToUtc(i.when, tz);
    if (!ev) continue;
    const day = i.when.slice(0, 10);
    const prev = new Date(Date.parse(day + 'T12:00:00Z') - 864e5).toISOString().slice(0, 10);
    const leave = new Date(ev.getTime() - 60 * 60000);
    const L = s._user?.lang, v = { what: i.what, merchant: i.merchant, time: i.when.slice(11, 16) };
    const candidates = [
      { at: localToUtc(`${prev} 20:00`, tz), text: tr(L, i.merchant ? 'Tomorrow: {what}, {merchant} at {time}' : 'Tomorrow: {what} at {time}', v) },
      { at: leave, text: tr(L, i.merchant ? 'Time to go: {what} at {merchant}, {time}' : 'Time to go: {what}, {time}', v) },
    ];
    for (const c of candidates) {
      if (!c.at || c.at.getTime() < Date.now() + 60000) continue;
      const r = { id: 'rm_' + crypto.randomBytes(4).toString('hex'), at: c.at.toISOString(), local: null, text: c.text, eventAt: i.when, place: i.merchant || '', sent: false, auto: true };
      (s.reminders ||= []).push(r);
      out.push(r);
    }
  }
  return out;
}

// What kind of plan line a merchant's booking is (for the schedule).
function kindOf(m) {
  const c = m.category || '';
  if (/restaurant|bakery|cafe|bar/.test(c)) return 'food';
  if (/hotel|hostel/.test(c)) return 'stay';
  if (/train|bus|flight|taxi/.test(c)) return 'transport';
  if (/activity|tour|museum/.test(c)) return 'activity';
  return 'other';
}
// Show each clash once in the conversation; returns the new ones.
function showClashes(s, list, emit) {
  s.clashSeen ||= [];
  const fresh = list.filter((c) => !s.clashSeen.includes(c.key));
  for (const c of fresh) {
    s.clashSeen.push(c.key);
    emit('clash', c);
  }
  return fresh;
}
