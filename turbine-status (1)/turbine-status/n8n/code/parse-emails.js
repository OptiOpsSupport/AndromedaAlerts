// ─────────────────────────────────────────────────────────────
// Parse Emails  (n8n Code node, mode: "Run Once for All Items")
// Parses OpsControl turbine alarm emails into normalised events.
//
//   DATE:        2026-10-02 11:41:10
//   PARK:        Bealhill
//   Turbine:     4
//   S/N:          30124
//   CODE: (-10)
//   DESCRIPTION: Communication has been lost to the turbine
// ─────────────────────────────────────────────────────────────

const CONFIG = {
  repo: 'YOUR-GITHUB-USER/turbine-status', // owner/repo that GitHub Pages serves
  branch: 'main',
  timeZone: 'Europe/Dublin',               // timezone the DATE: field is written in
};

// PARK name as it appears in the email -> farm id used in users.json / farms.json.
// Anything not listed is slugified automatically ("Bealhill" -> "bealhill").
const FARM_ALIASES = {
  // 'Bealhill': 'bealhill',
};

// OpsControl all-clear: "CODE: (0)  DESCRIPTION: Turbine OK"
const CLEAR_CODES = ['0'];
const CLEAR_RE   = /\b(turbine ok|cleared?|reset|resolved|back in operation|restored|re-?established|normal operation)\b/i;
// DESCRIPTION text that should show amber rather than red
const WARNING_RE = /\b(warning|warn|ice|icing|curtail\w*)\b/i;

// ── helpers ──────────────────────────────────────────────────
const field = (text, label) => {
  const m = text.match(new RegExp(`^[ \\t]*${label}[ \\t]*:[ \\t]*(.*)$`, 'im'));
  return m ? m[1].trim() : null;
};
const slug = s => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
// HTML -> text, keeping line breaks so the "LABEL: value" lines survive
const htmlToText = h => (h || '')
  .replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\r/g, '');
const dayOf = d => new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.timeZone }).format(d); // YYYY-MM-DD

// "2026-10-02 11:41:10" in Europe/Dublin -> real instant (handles IST/GMT switch)
function localToDate(s) {
  const m = s && s.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const asUtc = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  const offsetAt = t => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: CONFIG.timeZone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(t)).map(x => [x.type, x.value]));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - t;
  };
  return new Date(asUtc - offsetAt(asUtc - offsetAt(asUtc)));
}

// ── main ─────────────────────────────────────────────────────
const events = [];

for (const item of $input.all()) {
  const j = item.json;
  // Works with the Microsoft Outlook trigger (raw) and the IMAP trigger
  const subject = j.subject || '';
  const body = j.textPlain || j.text
    || htmlToText(j.textHtml || j.html || j.body?.content)
    || j.bodyPreview || '';
  const received = new Date(j.receivedDateTime || j.date || Date.now());

  const park    = field(body, 'PARK');
  const turbine = field(body, 'Turbine')?.match(/\d+/)?.[0];
  const alarmAt = localToDate(field(body, 'DATE')) || received;

  if (!park || !turbine) {
    // Not an alarm we understand: keep a trace in the day's history, never drop silently
    events.push({ unparsed: true, ts: received.toISOString(), subject: subject.slice(0, 200) });
    continue;
  }

  const code = field(body, 'CODE')?.replace(/^\(\s*|\s*\)$/g, '') || null;   // "(-10)" -> "-10"
  const description = field(body, 'DESCRIPTION') || '';

  events.push({
    ts: alarmAt.toISOString(),
    farm: FARM_ALIASES[park] || slug(park),
    farmName: park,
    turbine: `T${String(parseInt(turbine, 10)).padStart(2, '0')}`,
    serial: field(body, 'S/N'),
    type: (CLEAR_CODES.includes(code) || CLEAR_RE.test(description)) ? 'clear'
        : WARNING_RE.test(description) ? 'warning' : 'fault',
    code,
    text: description.slice(0, 200),
  });
}

events.sort((a, b) => a.ts.localeCompare(b.ts));

return [{
  json: {
    repo: CONFIG.repo,
    branch: CONFIG.branch,
    date: dayOf(new Date()),
    timeZone: CONFIG.timeZone,
    events,
  },
}];
