// Rebuilds turbine-status-workflow.json from the code/*.js files.
// Usage: node n8n/build-workflow.js
const fs = require('fs');
const path = require('path');
const code = f => fs.readFileSync(path.join(__dirname, 'code', f), 'utf8');

const ghHeaders = {
  parameters: [
    { name: 'Accept', value: 'application/vnd.github+json' },
    { name: 'User-Agent', value: 'n8n-turbine-status' },
  ],
};
const ghGet = (name, filePath, pos) => ({
  id: name.toLowerCase().replace(/\s+/g, '-'),
  name,
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.2,
  position: pos,
  parameters: {
    method: 'GET',
    url: `=https://api.github.com/repos/{{ $('Parse Emails').first().json.repo }}/contents/${filePath}?ref={{ $('Parse Emails').first().json.branch }}`,
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'githubApi',
    sendHeaders: true,
    headerParameters: ghHeaders,
    // 404 on first run is expected -> carry on with an empty file
    options: { response: { response: { neverError: true } } },
  },
});

const workflow = {
  name: 'Turbine Alerts → GitHub Status',
  nodes: [
    {
      id: 'outlook-trigger',
      name: 'New Alert Email (Outlook)',
      type: 'n8n-nodes-base.microsoftOutlookTrigger',
      typeVersion: 1,
      position: [0, 0],
      parameters: {
        pollTimes: { item: [{ mode: 'everyMinute' }] },
        output: 'raw',
        filters: {},
        options: {},
      },
    },
    {
      id: 'imap-trigger',
      name: 'New Alert Email (IMAP)',
      type: 'n8n-nodes-base.emailReadImap',
      typeVersion: 2,
      position: [0, 200],
      disabled: true,
      parameters: { mailbox: 'Turbine Alerts', postProcessAction: 'read', options: {} },
    },
    {
      id: 'parse-emails',
      name: 'Parse Emails',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [240, 100],
      parameters: { mode: 'runOnceForAllItems', jsCode: code('parse-emails.js') },
    },
    {
      id: 'has-events',
      name: 'Has Events?',
      type: 'n8n-nodes-base.if',
      typeVersion: 2,
      position: [460, 100],
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
          conditions: [{
            id: 'c1',
            leftValue: '={{ $json.events.length }}',
            rightValue: 0,
            operator: { type: 'number', operation: 'gt' },
          }],
          combinator: 'and',
        },
        options: {},
      },
    },
    ghGet('Get Status File', 'data/status.json', [680, 100]),
    ghGet('Get History File', "data/history/{{ $('Parse Emails').first().json.date }}.json", [900, 100]),
    {
      id: 'apply-events',
      name: 'Apply Events',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [1120, 100],
      parameters: { mode: 'runOnceForAllItems', jsCode: code('apply-events.js') },
    },
    {
      id: 'commit-file',
      name: 'Commit File',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [1340, 100],
      retryOnFail: true,
      maxTries: 3,
      waitBetweenTries: 3000,
      parameters: {
        method: 'PUT',
        url: "=https://api.github.com/repos/{{ $('Parse Emails').first().json.repo }}/contents/{{ $json.path }}",
        authentication: 'predefinedCredentialType',
        nodeCredentialType: 'githubApi',
        sendHeaders: true,
        headerParameters: ghHeaders,
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify($json.body) }}',
        options: { batching: { batch: { batchSize: 1, batchInterval: 1500 } } },
      },
    },
  ],
  connections: {
    'New Alert Email (Outlook)': { main: [[{ node: 'Parse Emails', type: 'main', index: 0 }]] },
    'New Alert Email (IMAP)':    { main: [[{ node: 'Parse Emails', type: 'main', index: 0 }]] },
    'Parse Emails':     { main: [[{ node: 'Has Events?', type: 'main', index: 0 }]] },
    'Has Events?':      { main: [[{ node: 'Get Status File', type: 'main', index: 0 }], []] },
    'Get Status File':  { main: [[{ node: 'Get History File', type: 'main', index: 0 }]] },
    'Get History File': { main: [[{ node: 'Apply Events', type: 'main', index: 0 }]] },
    'Apply Events':     { main: [[{ node: 'Commit File', type: 'main', index: 0 }]] },
  },
  settings: { executionOrder: 'v1', timezone: 'Europe/Dublin' },
};

fs.writeFileSync(path.join(__dirname, 'turbine-status-workflow.json'), JSON.stringify(workflow, null, 2));
console.log('wrote n8n/turbine-status-workflow.json');
