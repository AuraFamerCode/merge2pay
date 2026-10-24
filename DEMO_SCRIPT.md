# merge2pay: 2-minute demo script

**Setup before recording**

- Terminal font size 18+, dark theme, window about 140×40. Clear the screen between shots.
- `npm install` done, so `dist/` exists. Run each command once beforehand to warm GitHub's rate limit (anonymous is 60 req/h; `export GITHUB_TOKEN=...` avoids surprises).
- Easiest: run `scripts/demo.sh`. It types each command and waits for Enter, so you only narrate.
- Optional browser tab for shot 1: a GitHub PR page, e.g. https://github.com/honojs/hono/pull/5547
- Record at 1080p. Target length 1:50 to 2:10.

---

### Shot 1: the problem (0:00 – 0:15)

**Screen:** title card, or the Gibwork bounty page next to a GitHub PR.

**Say:**
> "Gibwork makes it easy to post a bounty for a GitHub issue. The hard part comes after. Submissions are free text, so a maintainer has to open each one, find the PR, check it's merged, check it fixes the right issue, check the person actually wrote it, and then pay. merge2pay automates all of that with the Gibwork SDK."

---

### Shot 2: `doctor` (0:15 – 0:25)

```bash
merge2pay doctor
```

**Point at:** the `gibwork api` line.

**Say:**
> "It's a terminal tool built on the official Gibwork SDK. Even with no wallet configured, it makes real read-only SDK calls. Here it found 9 live bounties through `tasks.listAvailable`."

---

### Shot 3: fund an issue (0:25 – 0:45)

```bash
merge2pay fund honojs/hono#5520 --amount 15
```

**Point at:** "checked 9 live Gibwork bounties for duplicates", the title, and the 15.00 USDC.

**Say:**
> "Step one: turn a real GitHub issue into a bounty. merge2pay reads the issue, checks Gibwork for an existing bounty on it, and drafts the task. The draft tells contributors how to make their claim verifiable: say 'Fixes #5520' in the PR and put your Gibwork username in it. This is a dry run. With `--execute` it shows the SDK's fee quote, saves the intent to a ledger, and signs."

---

### Shot 4: verify one PR (0:45 – 1:00)

```bash
merge2pay verify https://github.com/honojs/hono/pull/5547 --issue honojs/hono#5345 --submitter usualoma
```

**Point at:** the green PAY, then `closes-issue`, `merged`, and `ci 19 checks green`.

**Say:**
> "This is the core check, run live against GitHub. It's a real merged Hono PR. merge2pay confirms it's in the right repo, closes the right issue, is merged, and has 19 green CI checks. Verdict: pay."

---

### Shot 5: settle everything (1:00 – 1:35), the money shot

```bash
merge2pay settle --fixtures examples/demo/gibwork-fixtures.json --ledger examples/demo/ledger.json --report /tmp/settlement-report.md
```

**Point at, top to bottom:**

1. **PAY** usualoma: merged PR, all checks pass.
2. **REJECT** quickclaimer: "already claimed by usualoma's submission".
3. **REJECT** driveby: Google Drive link, no PR.
4. **REJECT** impostor: "claims GitHub @impostor-dev, but PR is by @imharjot". Note it was submitted *first* and still lost.
5. **WAIT** imharjot: PR still open; they'll get one comment saying it pays on merge.
6. The **Plan** line: 1 to pay, 5 to reject, 1 to update.

**Say:**
> "Now the full loop: three bounties and seven submissions. Every PR here is a real Hono pull request checked live. One merged PR gets paid. A copycat who resubmitted the same PR is rejected. A Drive link is rejected. An impostor who pasted someone else's PR, and submitted first, is caught because the PR author doesn't match. The real author is told their PR pays as soon as it merges. Wrong repo, closed PR: rejected, each with a reason the contributor can read."

---

### Shot 6: report, safety, Action (1:35 – 1:55)

```bash
head -n 20 /tmp/settlement-report.md
```

Then quickly show `examples/github-action/merge2pay.yml` (scroll to `pull_request: closed`).

**Say:**
> "Each run exports a Markdown report with the evidence. With `--execute`, merge2pay uses the SDK's prepareApproval, shows the quote, writes the intent to the ledger before signing, and never retries an ambiguous submit, so nobody gets paid twice. Payout caps live in a reviewed policy file. Drop in the GitHub Action, and merging the PR pays the contributor."

---

### Shot 7: tests + close (1:55 – 2:05)

```bash
npm test --silent 2>&1 | tail -n 9
```

**Say:**
> "36 tests, plus a read-only MCP server so Claude or Codex can use the same verifier next to the official Gibwork MCP. merge2pay: merge the PR, and the bounty pays out."

**End card:** `github.com/AuraFamerCode/merge2pay` · built on @gibwork/sdk · CLI · GitHub Action · MCP

---

## Honesty notes for the voice-over

- The settle demo reads submissions from `examples/demo/gibwork-fixtures.json`, because only the bounty creator's wallet can list submissions. Say "fixture submissions, real PRs" if asked. The GitHub data and the `doctor`/`fund` Gibwork calls are live.
- Don't say anything was paid in the video. Every command shown is a dry run.
