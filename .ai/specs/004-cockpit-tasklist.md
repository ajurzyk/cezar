# 004 — Lista tasków: PR-link, archiwizacja, koszt $

Status: ZAIMPLEMENTOWANE 2026-07-10 · Fala: 1 · Zależy od: — · Wzorzec: janitor `TasksTable` + `extractPullRequestUrl` + `cost`

## Cel

Lista tasków = centrum dowodzenia: od razu widać co biegnie, co czeka na
człowieka, co poszło do PR i ile kosztowało. Skończone rzeczy znikają do
archiwum jednym kliknięciem.

## UX (jak cep)

- Dwie zakładki nad listą: **Active** / **Archived** (z licznikami). Nic więcej.
- Na kafelku taska dochodzą maksymalnie dwa elementy: **`PR #123`** (link,
  tylko gdy istnieje) i **koszt `$0.42`** obok tokenów.
- Jeden przycisk **„Archive finished"** nad listą — zbiorczo archiwizuje
  wszystkie `done`/`failed`/`cancelled`.
- Pojedynczy task: ikonka archiwum na kafelku (toggle, działa w obie strony).
- Kolejność listy: `waiting` (czeka na Ciebie!) → `running` → `queued` →
  reszta po dacie malejąco.

## Zakres

1. **PR-link wyłuskiwany z transkryptu** (wzorzec janitora — agent i tak
   wypisuje URL po `gh pr create`): regex
   `https://github\.com/[^/\s]+/[^/\s]+/pull/\d+` na eventach `text`,
   `tool-result` i `check-output`; pierwszy trafiony → `run.pullRequestUrl`
   (raz zapisany, nie nadpisujemy). Wyliczane on-the-fly w silniku (hook na
   `appendEvent`), nie przy odczycie — prościej niż janitorowe
   `enrichTaskFromEvents`.
2. **Koszt w $**: event `result` z claude niesie `total_cost_usd` — runner
   emituje nowy event `cost {usd}`; store akumuluje `step.costUsd` /
   `run.costUsd` (obok tokenów). Brak danych = nie pokazujemy (bez zer).
3. **Archiwizacja**: pola `archived: boolean`, `archivedAt`; endpointy
   `POST /api/runs/:id/archive` `{archived}` i `POST /api/runs/archive-finished`;
   filtr w GUI. Delete zostaje (kasuje naprawdę), archiwum tylko chowa.
   Retencja `MAX_RUNS_KEPT` liczy się osobno dla archiwum (500).
4. **Sortowanie po statusie** (waiting/running na górze) + licznik `waiting`
   w nagłówku zakładki (żółta kropka gdy > 0) — user od progu wie, że coś
   na niego czeka.

## Poza zakresem

- Filtrowanie po repo/workflow (jedno repo per cockpit — bez sensu).
- Wykresy kosztów, budżety — nie teraz.

## Projekt techniczny

- `src/runs/store.ts`: `pullRequestUrl?`, `costUsd?`, `archived`, `archivedAt`
  w schemacie; migracja niepotrzebna (zod `optional` + stare pliki czytają się
  dalej).
- `src/core/claude-cli-runner.ts`: emit `cost` z `result.total_cost_usd`.
- `src/workflows/run.ts`: hook PR-regex w `emit`, akumulacja kosztu.
- `src/server/server.ts`: 2 endpointy archiwizacji.
- `web/app.js`: zakładki Active/Archived, badge PR, koszt, sort, przycisk
  zbiorczy. Bez nowych widoków.

## Kroki implementacji

1. Store: nowe pola + endpointy archiwizacji.
2. Runner: event `cost`; silnik: PR-regex + akumulacja.
3. GUI: zakładki, sort, badge PR, koszt.
4. Mock: dodać do `mock-claude.mjs` linijkę z fake PR-URL i `total_cost_usd`
   w result — testy bez GitHuba.

## Kryteria akceptacji

- Task, w którego transkrypcie padł URL PR-a, ma klikalny `PR #n` na kafelku
  i w headerze szczegółów.
- Koszt $ zgadza się z sumą `total_cost_usd` z eventów sesji.
- „Archive finished" chowa wszystkie skończone; Archived pokazuje je z
  możliwością przywrócenia; delete dalej działa.
- `waiting` zawsze na szczycie listy Active.
