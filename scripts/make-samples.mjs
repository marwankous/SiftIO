// Generates the sample library in public/samples/ plus its manifest.
// Deterministic (seeded), so regenerating produces identical files.
//
// The set is deliberately varied: CSV and JSON, DATE and TIMESTAMP, booleans,
// nulls, negative numbers, unicode, quoted fields containing commas and quotes,
// and a filename starting with a digit — each of which has broken a naive
// ingest pipeline at some point.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'public/samples';
mkdirSync(OUT, { recursive: true });

// mulberry32 — small deterministic PRNG.
let seed = 20260830;
const rnd = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const num = (lo, hi, dp = 2) => +(lo + rnd() * (hi - lo)).toFixed(dp);
const chance = (p) => rnd() < p;

const DAY0 = Date.UTC(2025, 0, 1);
const day = (i) => new Date(DAY0 + i * 86400000).toISOString().slice(0, 10);
const stamp = (i, h, m) =>
  new Date(DAY0 + i * 86400000 + h * 3600000 + m * 60000).toISOString().replace('.000Z', 'Z');

/** RFC4180 quoting: only when needed, doubling embedded quotes. */
const cell = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
const csv = (name, headers, rows) => {
  const body = [headers.join(','), ...rows.map((r) => r.map(cell).join(','))].join('\n');
  writeFileSync(join(OUT, name), body + '\n');
  return rows.length;
};
const json = (name, rows) => {
  writeFileSync(join(OUT, name), JSON.stringify(rows, null, 1) + '\n');
  return rows.length;
};

const counts = {};

// 1. Bank transactions — includes refunds (negative amounts).
{
  const merchants = [
    ['Uber', 'transport'], ['TfL Oyster', 'transport'], ['Trainline', 'transport'],
    ['Pret A Manger', 'food'], ['Deliveroo', 'food'], ['Nando’s', 'food'],
    ['Tesco', 'groceries'], ['Sainsbury’s', 'groceries'],
    ['Spotify', 'subscriptions'], ['Netflix', 'subscriptions'],
    ['Amazon', 'shopping'], ['Uniqlo', 'shopping'],
    ['Boots', 'health'], ['PureGym', 'health'], ['Shell', 'transport'],
  ];
  const base = { transport: 12, food: 18, groceries: 42, subscriptions: 11, shopping: 55, health: 30 };
  const rows = [];
  let id = 1;
  for (let d = 0; d < 365; d++) {
    for (let k = int(1, 4); k > 0; k--) {
      const [m, c] = pick(merchants);
      const amt = chance(0.04) ? -num(5, 90) : num(0.35 * base[c], 1.9 * base[c]);
      rows.push([id++, day(d), m, c, amt]);
    }
  }
  counts['transactions.csv'] = csv('transactions.csv', ['id', 'day', 'merchant', 'category', 'amt'], rows);
}

// 2. Workouts.
{
  const rows = [];
  for (let d = 0; d < 365; d++) {
    if (!chance(0.55)) continue;
    const mins = int(20, 95);
    rows.push([day(d), pick(['run', 'cycle', 'swim', 'gym', 'walk']), mins, Math.round(mins * num(5.5, 11))]);
  }
  counts['workouts.csv'] = csv('workouts.csv', ['day', 'kind', 'minutes', 'calories'], rows);
}

// 3. Sleep — joins to transactions/workouts on day.
{
  const rows = [];
  for (let d = 0; d < 365; d++) {
    if (!chance(0.92)) continue;
    rows.push([day(d), num(4.2, 9.4, 1), pick(['poor', 'fair', 'good', 'great']), int(0, 74)]);
  }
  counts['sleep.csv'] = csv('sleep.csv', ['day', 'hours', 'quality', 'restless_min'], rows);
}

// 4. Steps.
{
  const rows = [];
  for (let d = 0; d < 365; d++) rows.push([day(d), int(1200, 21000), int(0, 28)]);
  counts['steps.csv'] = csv('steps.csv', ['day', 'steps', 'floors'], rows);
}

// 5. Weight — weekly, with missing body-fat readings (empty cells -> NULL).
{
  const rows = [];
  let kg = 78.4;
  for (let w = 0; w < 52; w++) {
    kg = +(kg + num(-0.6, 0.5)).toFixed(1);
    rows.push([day(w * 7), kg, chance(0.35) ? null : num(14, 24, 1)]);
  }
  counts['weight.csv'] = csv('weight.csv', ['day', 'kg', 'body_fat_pct'], rows);
}

// 6. Streaming history — TIMESTAMP rather than DATE, plus a boolean.
{
  const artists = [
    ['Khruangbin', '(Zhao’s Theme)'], ['Fela Kuti', 'Water No Get Enemy'],
    ['Björk', 'Hyperballad'], ['Sault', 'Wildfires'],
    ['Nala Sinephro', 'Space 1.8'], ['Tirzah', 'Devotion'],
    ['Caroline Polachek', 'Bunny Is a Rider'], ['Mdou Moctar', 'Afrique Victime'],
  ];
  const rows = [];
  for (let d = 0; d < 200; d++) {
    for (let k = int(0, 6); k > 0; k--) {
      const [a, t] = pick(artists);
      const skipped = chance(0.18);
      rows.push([stamp(d, int(7, 23), int(0, 59)), a, t, skipped ? int(3000, 40000) : int(90000, 380000), skipped]);
    }
  }
  counts['streaming.csv'] = csv('streaming.csv', ['played_at', 'artist', 'track', 'ms_played', 'skipped'], rows);
}

// 7. Screen time.
{
  const apps = ['Messages', 'Safari', 'Mail', 'Maps', 'Photos', 'Slack', 'Spotify', 'Kindle'];
  const rows = [];
  for (let d = 0; d < 180; d++) for (const app of apps) {
    if (!chance(0.7)) continue;
    rows.push([day(d), app, int(2, 145), int(1, 40)]);
  }
  counts['screen-time.csv'] = csv('screen-time.csv', ['day', 'app', 'minutes', 'pickups'], rows);
}

// 8. Commutes.
{
  const rows = [];
  for (let d = 0; d < 365; d++) {
    if (new Date(DAY0 + d * 86400000).getUTCDay() % 6 === 0) continue; // weekdays only
    const mode = pick(['tube', 'bus', 'bike', 'walk', 'train']);
    rows.push([day(d), mode, int(14, 78), num(1.2, 24.5, 1), chance(0.17)]);
  }
  counts['commutes.csv'] = csv('commutes.csv', ['day', 'mode', 'minutes', 'km', 'delayed'], rows);
}

// 9. Groceries — unicode item names and fields containing commas.
{
  const items = [
    'Café beans, whole', 'Crème fraîche', 'Jalapeño peppers',
    'Gruyère, aged', 'Açaí pulp', 'Smörgås crispbread',
    'Za’atar', 'Chèvre', 'Oat milk, barista', 'Sourdough, seeded',
  ];
  const rows = [];
  for (let d = 0; d < 120; d++) {
    if (!chance(0.45)) continue;
    for (let k = int(1, 5); k > 0; k--) {
      const q = int(1, 4);
      const p = num(0.9, 12.5);
      rows.push([day(d), pick(items), q, p, +(q * p).toFixed(2)]);
    }
  }
  counts['groceries.csv'] = csv('groceries.csv', ['day', 'item', 'qty', 'unit_price', 'total'], rows);
}

// 10. Email metadata — subjects with commas and embedded quotes.
{
  const subjects = [
    'Re: invoice #2291, revised',
    'Your order has shipped',
    'Standup notes, 14 May',
    'She said "ship it" — so we did',
    'Renewal reminder, action needed',
    'Weekly digest',
    'Re: Re: lunch?',
  ];
  const senders = ['billing@acme.test', 'no-reply@shop.example', 'team@work.example', 'digest@news.example'];
  const rows = [];
  for (let d = 0; d < 150; d++) for (let k = int(0, 5); k > 0; k--) {
    rows.push([stamp(d, int(6, 22), int(0, 59)), pick(senders), pick(subjects), int(2, 850), chance(0.3)]);
  }
  counts['emails.csv'] = csv('emails.csv', ['received_at', 'from_addr', 'subject', 'size_kb', 'unread'], rows);
}

// 11. Subscriptions — JSON array of objects.
{
  const rows = [
    ['Spotify', 'music', 11.99, '2025-01-14', true],
    ['Netflix', 'video', 15.99, '2025-01-03', true],
    ['Adobe Creative Cloud', 'software', 51.98, '2025-02-21', true],
    ['iCloud+', 'storage', 2.99, '2025-01-08', true],
    ['NYT', 'news', 8.0, '2025-03-02', false],
    ['PureGym', 'fitness', 24.99, '2025-01-01', true],
    ['Backblaze', 'storage', 7.0, '2025-04-11', true],
    ['Duolingo', 'education', 12.99, '2025-05-19', false],
  ].map(([name, category, monthly, renews_on, active]) => ({ name, category, monthly, renews_on, active }));
  counts['subscriptions.json'] = json('subscriptions.json', rows);
}

// 12. Heart rate — JSON with a TIMESTAMP field.
{
  const rows = [];
  for (let d = 0; d < 90; d++) for (let k = 0; k < 8; k++) {
    const context = pick(['rest', 'walk', 'workout', 'sleep']);
    const bpm = context === 'workout' ? int(118, 178) : context === 'sleep' ? int(46, 62) : int(58, 96);
    rows.push({ measured_at: stamp(d, k * 3, int(0, 59)), bpm, context });
  }
  counts['heart-rate.json'] = json('heart-rate.json', rows);
}

// 13. Filename starting with a digit — table name must be prefixed to stay valid SQL.
{
  const rows = [
    ['Employment income', 52400.0, false],
    ['Freelance income', 8125.5, false],
    ['Home office', -1240.0, true],
    ['Equipment', -2310.75, true],
    ['Travel', -845.2, true],
    ['Professional fees', -600.0, true],
    ['Charitable giving', -1500.0, true],
    ['Pension contributions', -4800.0, true],
  ];
  counts['2024-taxes.csv'] = csv('2024-taxes.csv', ['category', 'amount', 'deductible'], rows);
}

// 14. Location visits — floats that must not be mistaken for integers.
{
  const places = [
    ['Barbican Centre', 'London'], ['Peckham Levels', 'London'], ['Kew Gardens', 'Richmond'],
    ['Victoria Park', 'London'], ['Brighton Beach', 'Brighton'], ['Whitworth Gallery', 'Manchester'],
  ];
  const rows = [];
  for (let d = 0; d < 200; d++) {
    if (!chance(0.4)) continue;
    const [place, city] = pick(places);
    rows.push([day(d), place, city, num(50.8, 53.5, 4), num(-2.3, 0.15, 4), int(20, 260)]);
  }
  counts['location-visits.csv'] = csv('location-visits.csv', ['day', 'place', 'city', 'lat', 'lon', 'minutes'], rows);
}

// Manifest: what each sample is, and what its columns mean. Roles are applied on
// load, so the agent reads them in the generated tool descriptions.
const manifest = {
  samples: [
    {
      file: 'transactions.csv', title: 'Bank transactions',
      note: 'A year of spending, including refunds as negative amounts.',
      roles: { id: 'identifier', day: 'timestamp', merchant: 'label', category: 'category', amt: 'amount' },
    },
    {
      file: 'workouts.csv', title: 'Workouts',
      note: 'Exercise sessions. Joins to the other daily sets on day.',
      roles: { day: 'timestamp', kind: 'category', minutes: 'amount' },
    },
    {
      file: 'sleep.csv', title: 'Sleep',
      note: 'Nightly hours and quality.',
      roles: { day: 'timestamp', hours: 'amount', quality: 'category' },
    },
    {
      file: 'steps.csv', title: 'Daily steps',
      note: 'Step and floor counts for every day of 2025.',
      roles: { day: 'timestamp', steps: 'amount' },
    },
    {
      file: 'weight.csv', title: 'Body weight',
      note: 'Weekly readings, with some body-fat measurements missing.',
      roles: { day: 'timestamp', kg: 'amount' },
    },
    {
      file: 'streaming.csv', title: 'Music streaming',
      note: 'Play history with a full timestamp and a skipped flag.',
      roles: { played_at: 'timestamp', artist: 'category', track: 'label', ms_played: 'amount' },
    },
    {
      file: 'screen-time.csv', title: 'Screen time',
      note: 'Minutes and pickups per app per day.',
      roles: { day: 'timestamp', app: 'category', minutes: 'amount' },
    },
    {
      file: 'commutes.csv', title: 'Commutes',
      note: 'Weekday journeys by mode, with delays.',
      roles: { day: 'timestamp', mode: 'category', minutes: 'amount' },
    },
    {
      file: 'groceries.csv', title: 'Groceries',
      note: 'Receipt lines with unicode names and quoted commas.',
      roles: { day: 'timestamp', item: 'label', total: 'amount' },
    },
    {
      file: 'emails.csv', title: 'Email metadata',
      note: 'Headers only. Subjects contain commas and quotes.',
      roles: { received_at: 'timestamp', from_addr: 'category', subject: 'label', size_kb: 'amount' },
    },
    {
      file: 'subscriptions.json', title: 'Subscriptions',
      note: 'JSON. Recurring charges and renewal dates.',
      roles: { name: 'label', category: 'category', monthly: 'amount', renews_on: 'timestamp' },
    },
    {
      file: 'heart-rate.json', title: 'Heart rate',
      note: 'JSON with timestamped readings by context.',
      roles: { measured_at: 'timestamp', bpm: 'amount', context: 'category' },
    },
    {
      file: '2024-taxes.csv', title: '2024 taxes',
      note: 'Income and deductions. Filename starts with a digit.',
      roles: { category: 'category', amount: 'amount' },
    },
    {
      file: 'location-visits.csv', title: 'Location visits',
      note: 'Places visited, with coordinates.',
      roles: { day: 'timestamp', place: 'label', city: 'category', minutes: 'amount' },
    },
  ],
};

for (const s of manifest.samples) {
  if (!(s.file in counts)) throw new Error(`manifest lists ${s.file} but it was not generated`);
  s.rows = counts[s.file];
}
writeFileSync(join(OUT, 'index.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log(`${manifest.samples.length} samples`);
for (const s of manifest.samples) console.log(`  ${String(s.rows).padStart(5)}  ${s.file}`);
