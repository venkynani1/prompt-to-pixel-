# Host operation guide

You need two screens: the **host console** on your laptop or tablet (`/host`), and the **projector** (`/e/CODE/screen?pk=…`). Open the projector link from *Screens & registration* in the console. Keep the projector link private — anyone with it can watch the screen view.

## The day before

1. Open the host console and log in with the event code and host password from `deploy-output.txt`.
2. **Round 1**: set the title, brief and minutes, then upload the reference image. Compression happens in your browser.
   - If the comparison mode shows `reference-description`, click **Generate with AI**. Read the text and correct anything wrong, because this is what entries are scored against. Then **Save description**.
3. **Round 2**: enter the three crossover concepts and the minutes.
4. **AI judge**: choose the model recommended in `docs/reports/BENCHMARK.md` and save.
5. **Run calibration** for both rounds (3 AI calls). An identical copy should score 75+ and a blank card 35 or less. If calibration fails, don't run that model.
6. The judge model is **locked when each round starts** and can't change silently. Check the settings now.

## Run of show

| Step | Button | Projector shows |
|---|---|---|
| Doors open | — | QR code + team counter |
| Teams register (one phone per team, please) | — | counter rises |
| Close registration when ready | *Close registration* | — |
| Brief | *Show Round 1 brief* | title, brief, scoring weights |
| Go | *Start Round 1* | big countdown + reference + submitted count |
| Time ends automatically (server clock) or early | *End Round 1 now* | "The judge is looking" + progress |
| All judged | *Reveal Round 1 results* | animated standings + Pixel Gallery reel |
| Round 2 | *Show Round 2 brief* → *Start Round 2* | three concepts + countdown |
| Finish | *Reveal Round 2 results* → *Show final standings* | podium (winner revealed last) |

Judging starts the moment each team uploads, so most entries are already scored when time runs out. Teams can see that their entry was judged, but not the score until you reveal results.

## Handling problems

| You see | Do |
|---|---|
| Entry **Held for review**: *Looks like the reference itself* | Open it. If they really just re-uploaded the reference, **Reject** (0 points). Otherwise **Approve**, and it gets judged. |
| *Identical to another team* | Two teams uploaded the same file. Talk to them, then Approve or Reject. |
| *Contains text aimed at the judge* | Someone wrote instructions in the picture. The score shown ignored the text. Approve or Reject. |
| **Judging failed** after 4 attempts | Click **Retry**. Points are never invented — a failed entry has no score until it's judged. |
| **Paused (AI quota)** | The daily AI budget is used up. Entries are safe. Raise *Daily neuron cap* (max 10,000) if there's room. Otherwise judging resumes automatically after 05:30 IST, or you can switch to the Ollama fallback and **Re-judge round**. |
| Usage bar for Worker requests turns red | Ask extra phones per team to close the page. Polling slows automatically. |
| Team forgot PIN or is locked out | *Teams → Reset PIN*. This signs out their old devices. |
| Wrong phase clicked | *Back to …* steps back one phase. Re-opening a round keeps its judge lock. |
| Projector frozen | Reload it. State comes from the server, so nothing is lost. |

Every host action is in the **Activity log**.

## After the event

The galleries stay available to logged-in teams. You can pull CSVs from Neon's SQL editor:
```sql
SELECT t.name, l.r1_score, l.r2_score, l.total, l.rank FROM leaderboard_entries l JOIN teams t ON t.id=l.team_id ORDER BY rank;
```
