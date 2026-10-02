# n8n: turbine alert emails → GitHub status files

```
Alert email ─► Parse Emails ─► Has Events? ─► Get status.json ─► Get today's history ─► Apply Events ─► Commit (×2)
 (Outlook/IMAP)   (Code)                        (GitHub API)        (GitHub API)          (Code)        (GitHub API)
```

## What it writes to the repo

| File | What it's for |
|---|---|
| `data/status.json` | Current state of every turbine that's ever alerted. Drives the **alert screen**. |
| `data/history/YYYY-MM-DD.json` | Every event that day, in order, including unparsed emails. Drives the **day history** when you click a turbine. |

Per turbine in `status.json`:

```json
"T03": {
  "state": "fault",              // fault | warning | ok
  "since": "2026-10-02T07:00Z",  // start of the current episode ("down since 8am")
  "code": "7:1", "text": "FAULT WTG 03 - Site: Mountain Lodge",
  "lastEvent": "...", "lastCleared": "...",
  "today": { "date": "2026-10-02", "faults": 3, "warnings": 0, "clears": 2, "onsets": 3 },
  "intermittent": true           // >= 3 separate fault/warning episodes today
}
```

That covers your two cases: a turbine **down since 8am** has `state: fault` and `since` 08:00. A turbine that **keeps tripping and resetting** has `intermittent: true` and an onset count, even if it's currently `ok`.

## Setup (about 15 min)

1. **GitHub repo.** Create `turbine-status` and add `data/users.json` and `data/farms.json` from this folder's `../data`.
2. **GitHub token.** Create a fine-grained PAT with access to that repo only and *Contents: Read and write*. In n8n, add a **GitHub API** credential with it.
3. **Import.** Go to n8n → *Import from file* → `turbine-status-workflow.json`.
4. **Trigger.** Open *New Alert Email (Outlook)*, attach your Microsoft credential, and set a folder filter. The easiest way is an Outlook rule that moves alert emails into a `Turbine Alerts` folder. If you're on a non-M365 mailbox, disable Outlook and enable the IMAP node.
5. **Config.** In *Parse Emails*, set `CONFIG.repo` to `your-user/turbine-status`.
6. **Credentials.** Attach the GitHub credential to *Get Status File*, *Get History File* and *Commit File*.
7. **Activate.**

## The parser (OpsControl format)

*Parse Emails* reads these lines from each OpsControl alarm email:

| Email line | Stored as |
|---|---|
| `DATE: 2026-10-02 11:41:10` | `ts`, converted from Irish time (handles summer/winter time) |
| `PARK: Bealhill` | `farm: "bealhill"`, `farmName: "Bealhill"` |
| `Turbine: 4` | `turbine: "T04"` |
| `S/N: 30124` | `serial` |
| `CODE: (-10)` | `code: "-10"` |
| `DESCRIPTION: ...` | `text` |

It works with both the plain-text and HTML versions of the email. The greeting name and footer are ignored.

- **Severity.** Every alarm is red (`fault`), unless the description matches `WARNING_RE` (ice, curtailment, warning), which shows amber.
- **Clearing.** A description matching `CLEAR_RE` (cleared, reset, back in operation, restored) sets the turbine back to OK.
- **Intermittent.** A turbine is flagged intermittent after 3 or more alarms in one day.
- **Unparsed emails.** An email with no `PARK:`/`Turbine:` line is logged in the day's history as `unparsed`, not dropped.

`FARM_ALIASES` is only needed if a PARK name should map to a different ID.

## Testing without n8n

```
node n8n/test/simulate.js     # runs both Code nodes over fake emails
node n8n/build-workflow.js    # rebuild the workflow JSON after editing code/*.js
```

## Things to know

- **Duplicates.** Events are de-duplicated by timestamp, turbine, type and subject, so re-polls and retries are harmless.
- **Data is public.** On a free GitHub plan, a Pages site is public, so anyone with the URL can read `status.json`. The name-only login decides which farms each person *sees*; it isn't security. If that matters, the fix is Cloudflare Access in front of it, or a private host. Your call.
- **Deploys.** Each run makes 2 commits. Deploy with the included GitHub Actions Pages workflow, not "deploy from branch". The branch method has a ~10 builds/hour soft limit. Expect about 1 minute from email to screen.
