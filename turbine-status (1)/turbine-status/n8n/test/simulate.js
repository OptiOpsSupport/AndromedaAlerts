// Offline test: runs both Code nodes against OpsControl-format emails,
// round-tripping the "GitHub" files in memory across several polls.
// Usage: node n8n/test/simulate.js
const fs = require('fs');
const path = require('path');
const src = f => fs.readFileSync(path.join(__dirname, '..', 'code', f), 'utf8');

const repo = {}; // path -> { content(b64), sha }
let shaN = 0;
const ghGet = p => repo[p] ? { ...repo[p] } : { message: 'Not Found', status: '404' };

function runCode(file, inputItems, nodes) {
  const $input = { all: () => inputItems.map(json => ({ json })) };
  const $ = name => ({ first: () => ({ json: nodes[name] }) });
  return new Function('$input', '$', 'Buffer', `return (()=>{${src(file)}})()`)($input, $, Buffer);
}

function poll(emails) {
  const parsed = runCode('parse-emails.js', emails, {})[0].json;
  if (!parsed.events.length) return parsed;
  const nodes = {
    'Parse Emails': parsed,
    'Get Status File': ghGet('data/status.json'),
    'Get History File': ghGet(`data/history/${parsed.date}.json`),
  };
  for (const { json } of runCode('apply-events.js', [], nodes)) {
    if (repo[json.path] && repo[json.path].sha !== json.body.sha) throw new Error('sha mismatch ' + json.path);
    repo[json.path] = { content: json.body.content, sha: 'sha' + ++shaN };
  }
  return parsed;
}

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' }).format(new Date());

// Exact OpsControl layout, as plain text
const ops = ({ time, park, turbine, sn, code, desc, date = today }) => ({
  subject: 'Turbine Alarm',
  textPlain: `Dan Aherne,

OpsControl have received the following turbine alarm:
DATE:        ${date} ${time}
PARK:        ${park}
Turbine:     ${turbine}
S/N:          ${sn}

Alarm Details:
CODE: (${code})
DESCRIPTION: ${desc}

Notes / comments:

-----------------

This is an automated message. Please do not reply.
For further info contact OpsControl:
By phone: +353 (0)49 489 0999
By Email: customersupport@opscontrol.eu


Best Regards,
OpsControl`,
});
// Same email as Outlook delivers it (HTML body, no textPlain)
const asOutlookHtml = m => ({
  subject: m.subject,
  receivedDateTime: new Date().toISOString(),
  body: { contentType: 'html', content: '<html><body><div>' + m.textPlain.split('\n').map(l => l.replace(/ /g, '&nbsp;')).join('<br>') + '</div></body></html>' },
});

const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('ok -', m); };

// 1. Field parsing on your sample (plain + HTML) and timezone handling
const sample = ops({ time: '11:41:10', park: 'Bealhill', turbine: 4, sn: 30124, code: -10, desc: 'Communication has been lost to the turbine', date: '2026-10-02' });
const p1 = runCode('parse-emails.js', [sample, asOutlookHtml(sample)], {})[0].json.events;
console.log(p1[0]);
assert(p1.length === 2 && !p1[0].unparsed && !p1[1].unparsed, 'plain-text and HTML versions both parse');
assert(p1[0].farm === 'bealhill' && p1[0].turbine === 'T04' && p1[0].serial === '30124', 'park / turbine / S/N');
assert(p1[0].code === '-10' && p1[0].text === 'Communication has been lost to the turbine', 'code + description');
assert(p1[0].ts === '2026-10-02T10:41:10.000Z', '11:41 Irish summer time -> 10:41 UTC');
const winter = runCode('parse-emails.js', [ops({ time: '11:41:10', park: 'X', turbine: 1, sn: 1, code: 1, desc: 'x', date: '2026-12-02' })], {})[0].json.events[0];
assert(winter.ts === '2026-12-02T11:41:10.000Z', '11:41 Irish winter time -> 11:41 UTC');

// 2. A day of alarms
poll([ops({ time: '08:02:00', park: 'Bealhill', turbine: 4, sn: 30124, code: -10, desc: 'Communication has been lost to the turbine' })]);
poll([ops({ time: '09:15:00', park: 'Bealhill', turbine: 7, sn: 30127, code: 512, desc: 'Generator temperature high' })]);
poll([ops({ time: '09:40:00', park: 'Bealhill', turbine: 7, sn: 30127, code: 512, desc: 'Generator temperature high' })]);
const dup = ops({ time: '10:05:00', park: 'Bealhill', turbine: 7, sn: 30127, code: 512, desc: 'Generator temperature high' });
poll([dup]); poll([dup]);   // same email twice -> de-duplicated
const t07ok = ops({ time: '10:20:00', park: 'Bealhill', turbine: 7, sn: 30127, code: 0, desc: 'Turbine OK' });
poll([t07ok]);
poll([ops({ time: '10:30:00', park: 'Mullananalt', turbine: 12, sn: 41012, code: 88, desc: 'Ice detected on blades' }),
      { subject: 'Newsletter', textPlain: 'nothing here' }]);

const read = p => JSON.parse(Buffer.from(repo[p].content, 'base64').toString());
const status = read('data/status.json');
const hist = read(`data/history/${today}.json`);
console.log(JSON.stringify(status.farms.bealhill.turbines, null, 2));

const b = status.farms.bealhill.turbines;
const t04Email = ops({ time: '08:02:00', park: 'Bealhill', turbine: 4, sn: 30124, code: -10, desc: 'x' });
assert(b.T04.state === 'fault' && b.T04.since === runCode('parse-emails.js', [t04Email], {})[0].json.events[0].ts, 'T04 in fault since 08:02');
assert(b.T07.today.faults === 3 && b.T07.intermittent, 'T07 flagged intermittent after 3 alarms');
assert(!b.T04.intermittent, 'T04 (single alarm) not intermittent');
assert(status.farms.mullananalt.turbines.T12.state === 'warning', 'icing shows as warning');
const parseOne = m => runCode('parse-emails.js', [m], {})[0].json.events[0];
const t07first = parseOne(ops({ time: '09:15:00', park: 'Bealhill', turbine: 7, sn: 30127, code: 512, desc: 'x' }));
assert(parseOne(t07ok).type === 'clear', '"CODE: (0) Turbine OK" parsed as clear');
assert(b.T07.state === 'ok' && b.T07.since === null, 'T07 back to OK after Turbine OK email');
assert(b.T07.lastEpisode.from === t07first.ts && b.T07.lastEpisode.to === parseOne(t07ok).ts && b.T07.lastEpisode.code === '512', 'T07 episode recorded 09:15 -> 10:20, code 512');
assert(b.T07.intermittent, 'T07 still flagged intermittent for the day after clearing');
assert(b.T04.state === 'fault', 'T04 (no OK email yet) still in fault');
assert(hist.events.length === 7, 'duplicate skipped, non-alarm email kept in history');
assert(hist.events.some(e => e.unparsed), 'non-alarm email logged as unparsed');
