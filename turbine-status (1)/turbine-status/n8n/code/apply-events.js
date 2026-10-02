// ─────────────────────────────────────────────────────────────
// Apply Events  (n8n Code node, mode: "Run Once for All Items")
// Reads the current status.json + today's history file from GitHub,
// applies the new events, and outputs one item per file to commit.
// ─────────────────────────────────────────────────────────────

const RULES = {
  intermittentAlarms: 3, // >= this many alarms (or separate episodes) for one turbine in a day = intermittent
};

const parsed  = $('Parse Emails').first().json;
const stRes   = $('Get Status File').first().json;
const hiRes   = $('Get History File').first().json;

const decode = r => (r && typeof r.content === 'string')
  ? JSON.parse(Buffer.from(r.content, 'base64').toString('utf8'))
  : null;
const encode = o => Buffer.from(JSON.stringify(o, null, 2) + '\n', 'utf8').toString('base64');
const dayOf  = iso => new Intl.DateTimeFormat('en-CA', { timeZone: parsed.timeZone }).format(new Date(iso));
const idOf   = e => [e.ts, e.farm || '', e.turbine || '', e.type || '', e.text || e.subject || ''].join('|');

const today   = parsed.date;
const status  = decode(stRes) || { farms: {} };
const history = decode(hiRes) || { date: today, events: [] };

const seen = new Set(history.events.map(e => e.id));
const fresh = [];

for (const ev of parsed.events) {
  const id = idOf(ev);
  if (seen.has(id)) continue;           // already processed (retry / re-poll)
  seen.add(id);
  fresh.push({ id, ...ev });
}

const blankDay = date => ({ date, faults: 0, warnings: 0, clears: 0, onsets: 0 });

for (const ev of fresh) {
  if (ev.unparsed) continue;

  const farm = (status.farms[ev.farm] ||= { name: ev.farmName, turbines: {} });
  const t = (farm.turbines[ev.turbine] ||= {
    state: 'ok', since: null, code: null, text: null,
    lastEvent: null, lastCleared: null, today: blankDay(dayOf(ev.ts)), intermittent: false,
  });

  const evDay = dayOf(ev.ts);
  if (t.today.date !== evDay) t.today = blankDay(evDay);

  if (ev.type === 'clear') {
    if (t.state !== 'ok') {
      t.lastCleared = ev.ts;
      // keep the finished episode so the screen can say "down 08:02 → 10:15 (-10 Comms lost)"
      t.lastEpisode = { from: t.since, to: ev.ts, state: t.state, code: t.code, text: t.text };
    }
    t.state = 'ok';
    t.since = null;
    t.today.clears++;
  } else {
    if (t.state === 'ok') { t.since = ev.ts; t.today.onsets++; }    // new episode
    if (ev.type === 'fault') { t.state = 'fault'; t.today.faults++; }
    else { if (t.state !== 'fault') t.state = 'warning'; t.today.warnings++; }
    t.code = ev.code;
    t.text = ev.text;
  }

  t.lastEvent = ev.ts;
  if (ev.serial) t.serial = ev.serial;
  t.intermittent = t.today.onsets >= RULES.intermittentAlarms
                || (t.today.faults + t.today.warnings) >= RULES.intermittentAlarms;
}

// Roll over day counters for turbines that haven't had an event today
for (const farm of Object.values(status.farms))
  for (const t of Object.values(farm.turbines))
    if (t.today.date !== today) { t.today = blankDay(today); t.intermittent = false; }

status.updated = new Date().toISOString();
status.date = today;
history.events.push(...fresh);

const summary = fresh.filter(e => !e.unparsed).map(e => `${e.farm}/${e.turbine} ${e.type}`).join(', ') || 'unparsed alert';
const message = `alerts: ${summary}`.slice(0, 120);
const commit = (path, obj, sha) => ({
  json: {
    path,
    body: { message, content: encode(obj), branch: parsed.branch, ...(sha ? { sha } : {}) },
  },
});

if (!fresh.length) return [];   // nothing new -> nothing to commit

return [
  commit('data/status.json', status, stRes.sha),
  commit(`data/history/${today}.json`, history, hiRes.sha),
];
