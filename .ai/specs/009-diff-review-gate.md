# 009 — Diff-first review gate: obejrzyj kod → uwagi → PR

Status: ZAIMPLEMENTOWANE 2026-07-10 · Fala: 3 · Zależy od: 002, 006 · Wzorzec: własny (janitor pokazuje transkrypt; my pokazujemy KOD)

## Cel

Zanim cokolwiek wyjedzie do GitHuba, user widzi **diff** tego, co agent
zrobił, i ma dwa wyjścia: dosłać uwagi (wracają do tej samej sesji) albo
wysłać draft PR jednym kliknięciem. To zamyka pętlę "wygodny code review
u siebie" z wizji Piotra.

## UX (jak cep)

- Gdy task kończy pracę i są zmiany w worktree, task wchodzi w stan
  **`review`** (fioletowy badge) i w szczegółach na wierzchu ląduje **diff**
  (składany per plik).
- Pod diffem dokładnie **dwa przyciski i pole tekstowe**:
  - **„🚀 Draft PR"** → `gh pr create --draft` (tytuł = tytuł taska, body =
    skrót z handoff.md) → task `done` z linkiem `PR #n`,
  - pole uwag + **„↩ Odeślij"** → uwagi lecą do tej samej sesji agenta
    (mechanizm 002), task wraca do `running`, po poprawkach znowu `review`.
- Brak zmian w worktree → gate się nie pojawia (task normalnie `done`/`waiting`).
- Brak `gh` → przycisk PR zastąpiony instrukcją `git merge cez/<id8>` do
  skopiowania.

## Zakres

1. **Krok `review` w silniku**: nowy rodzaj kroku (`kind: review`) dodawany:
   - automatycznie jako ostatnie ogniwo chainów z plannera (008),
   - opcjonalnie w YAML: `- id: review, review: true`,
   - `quick-task`: gate pojawia się implicite gdy worktree ma diff (bez
     definiowania w YAML — zero konfiguracji).
2. **Stan `review`** w RunStatus (kolor fioletowy; sortowanie razem z
   `waiting` — "czeka na Ciebie").
3. **Diff w GUI**: `GET /api/runs/:id/diff` (jest w 006) + render unified
   diff z kolorami (własny, ~40 linii JS: linie +/− kolorowane, nagłówki
   plików składane; ZERO bibliotek diff-viewerów).
4. **„Draft PR"**: `POST /api/runs/:id/pr` →
   - autosave-commit finalny, `git push -u origin cez/<id8>`,
   - `gh pr create --draft --title <run.title> --body <handoff-skrót +
     stopka "made with cez">`,
   - URL z outputu → `run.pullRequestUrl` (spec 004), task → `done`.
   - błędy (brak remote'a, brak uprawnień) → czytelny toast + komenda ręczna.
5. **„Odeślij"**: `POST /api/runs/:id/messages` (z 002) z prefiksem
   "Review feedback:\n" + auto-wznowienie sesji (Kontynuuj z 003, gdy proces
   już nie żyje); po `turn-end` z nowym diffem → znowu `review`.

## Poza zakresem

- Komentarze per linia diffu (v2 — na razie jedno pole uwag).
- Update istniejącego PR-a po kolejnej rundzie uwag (v1: PR robi się raz,
  na końcu; potem review żyje na GitHubie).
- Niedraftowe PR-y, auto-merge — nie.

## Projekt techniczny

- `src/workflows/run.ts`: stan `review` po ostatnim kroku agentowym gdy
  `worktreeDiff` niepusty; wątek wznowień jak w 002/003.
- Nowy `src/server/pr.ts` (~80 LOC): push + `gh pr create` przez execFile,
  parsowanie URL, mapowanie błędów na komunikaty.
- `web/app.js`: widok diffu (renderer unified), panel review z 2 przyciskami.
- `src/runs/store.ts`: status `review`.

## Kroki implementacji

1. Stan `review` + warunek diffu (test z mockiem, który robi realny commit
   w worktree — rozszerzenie mock-claude o `touch`+commit).
2. Renderer diffu w GUI.
3. `pr.ts` + endpoint + toasty błędów (test z `GH_DRY_RUN`-owym stubem gh).
4. „Odeślij" spięte z 002/003.
5. Test na żywo: task → review → uwagi → poprawka → Draft PR w prawdziwym repo.

## Kryteria akceptacji

- Task ze zmianami zatrzymuje się na `review` z poprawnym diffem per plik.
- „Odeślij" z uwagą zmienia kod (widać nowy diff po turze) bez utraty sesji.
- „Draft PR" tworzy draft z sensownym tytułem/body; kafelek dostaje `PR #n`.
- Repo bez remote'a: przycisk PR pokazuje ścieżkę ręczną, nic nie wybucha.
