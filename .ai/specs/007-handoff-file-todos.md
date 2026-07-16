# 007 — `handoff.md` per task + globalny inbox `todos.json`

Status: ZAIMPLEMENTOWANE 2026-07-10 · Fala: 2 · Zależy od: 002 · Wzorzec: janitor `seedHandoffFile`/`appendHandoffHeartbeat` + `todos.ts` (to jest to "sprytne globalne zarządzanie")

## Cel

Ciągłość między sesjami i taskami bez żadnej bazy: każdy task prowadzi
dziennik (`handoff.md`), a follow-upy ze wszystkich tasków spływają do
jednego inboxa, z którego kolejny task odpala się jednym klikiem.

## UX (jak cep)

- W szczegółach taska karta **„Notatki"** (render markdown `handoff.md`) —
  czytasz, co agent zrobił i co zostało, ludzkim językiem. Zero edycji w GUI.
- Nowa zakładka **Inbox** (obok Runs/Repo/Skills): płaska lista follow-upów
  ze wszystkich tasków. Wykonywalny wpis ma „▶ Odpal" (tworzy task z
  zasugerowanym skillem/promptem) i odhaczenie; notatka bez akcji ma
  „Acknowledge", które tylko ją usuwa.
- Kropka z liczbą na zakładce Inbox, gdy coś czeka.

## Zakres

1. **`handoff.md` per task**: `.ai/cezar/runs/<id>.handoff.md`
   (poza worktree — przeżywa jego skasowanie):
   - seed szkieletu przy starcie taska: nagłówek (task, repo, branch),
     `## Goal` (prompt), `## Progress log`, `## Resume notes`; idempotentny
     (resume nie nadpisuje),
   - agent dostaje ścieżkę przez env `CEZ_HANDOFF_FILE` + instrukcję w
     `--append-system-prompt`: „czytaj na starcie, dopisuj wpis po każdym
     milestone (najnowsze na górze), przed pauzą uzupełnij Resume notes",
   - heartbeat od Ceza po każdej turze: `- <ts> — turn complete — status=…
     ($koszt)` (plik aktualny nawet gdy agent zapomni — wzorzec janitora),
   - `GET /api/runs/:id/handoff` (markdown) + karta w GUI.
2. **Globalny inbox**: `.ai/cezar/todos.json`:
   - format wpisu: `{ id, ts, taskId, summary, action?, prUrl?,
     suggestedSkill?, suggestedArgs?, suggestedPrompt?, runnable? }`;
     `runnable` jawnie zapisuje intencję, a stary wpis bez tego pola jest
     wykonywalny tylko wtedy, gdy ma `suggestedSkill` lub `suggestedPrompt`,
   - agent dostaje env `CEZ_TODOS_FILE` + instrukcję: „po skończeniu dopisz
     wpis JSON do tablicy; nigdy nie modyfikuj istniejących"; ta instrukcja
     (`HANDOFF_INSTRUCTIONS`) jest jedynym producentem wpisów, więc opisuje
     też `runnable`: notatka do przeczytania albo robota dla człowieka
     (manual QA, „pamiętaj, żeby…") dostaje `runnable: false` i żadnego
     `suggestedSkill`/`suggestedPrompt`,
   - zapis serwerowy pod lockiem (nasz store ma już atomic write; dodajemy
     `withLock` — 15-liniowy port z janitorowego `storage.ts`),
   - watch pliku (fs.watch + debounce) → SSE → licznik na zakładce,
   - „▶ Odpal": `POST /api/runs` z `suggestedSkill/Prompt` → zwykły task;
     wpis dostaje `startedTaskId` i znika z listy.
3. **Sprzątanie**: delete taska kasuje jego handoff.md; wpisy inboxa żyją
   niezależnie od tasków (mogą wskazywać skasowany task — pokazujemy szaro).

## Poza zakresem

- Wspólna pamięć długoterminowa (`memory.md` janitora) — w SPEC janitora jest,
  w kodzie nie podpięta; u nas świadomie później (osobna decyzja produktowa).
- Edycja handoffa z GUI.

## Projekt techniczny

- `src/workflows/run.ts`: seed + env + fragment system promptu (stały tekst,
  ~10 linii); heartbeat w `finishStep`/`turn-end`.
- Nowy `src/todos.ts` (~80 LOC): read/add/remove pod lockiem + walidacja zod
  (wpisy agenta to dane zewnętrzne — walidujemy, złe wpisy pomijamy z notką).
- `src/server/server.ts`: endpointy handoff/todos + SSE event `todos`.
- `web/app.js`: karta Notatki (mamy render `<pre>`; markdown przez prosty
  regex-render albo zostaje `<pre>` — decyzja: **`<pre>` w v1**, zero nowych
  zależności), zakładka Inbox.

## Kroki implementacji

1. Handoff: seed + env + instrukcja + heartbeat + endpoint + karta.
2. `todos.ts` + endpointy + watch + SSE.
3. GUI Inbox + licznik + „▶ Odpal".
4. Mock: `mock-claude.mjs` dopisuje przykładowy todo-wpis i linijkę do
   handoffa — test pętli bez tokenów.

## Kryteria akceptacji

- Po tasku `handoff.md` zawiera Goal + wpisy agenta + heartbeaty; widoczny
  w GUI; przeżywa delete worktree.
- Wpis agenta w `todos.json` pojawia się w Inboxie bez odświeżania strony;
  „▶ Odpal" tworzy poprawny task; odhaczenie usuwa wpis.
- Ręcznie zepsuty JSON w todos.json nie wywala serwera (plik leczony:
  nieparsowalne wpisy pomijane, log ostrzeżenia).
