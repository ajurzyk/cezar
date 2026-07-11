# 010 — Warianty: N agentów na jeden task, wybierasz najlepszy diff

Status: ZAIMPLEMENTOWANE 2026-07-10 · Fala: 3 · Zależy od: 006 (worktree), 009 (diff/PR) · Wzorzec: własny — realne "multi-agent przez CLI" z wymagań Piotra

## Cel

Na trudny task odpalasz 2–3 agentów **równolegle w osobnych worktree**,
porównujesz ich diffy obok siebie i jednym kliknięciem wybierasz zwycięzcę
(reszta idzie do kosza). Tanie u nas (worktree już jest), a bije to UX
pojedynczego agenta kodującego.

## UX (jak cep)

- W formularzu nowego taska mały przełącznik: **`×1 ×2 ×3`** (domyślnie ×1 —
  funkcja niewidoczna, dopóki niepotrzebna). To CAŁE UI konfiguracji.
- Na liście: warianty zgrupowane w jeden kafelek `Nazwa taska (3 warianty)`
  z paskiem statusów; klik rozwija.
- Po zakończeniu wariantów widok **porównania**: kolumny A/B/C, w każdej
  skrót (pliki zmienione, +/−, koszt, 1-zdaniowe podsumowanie z handoffa)
  i przycisk **„Wybierz"**. Pod spodem pełne diffy składane.
- „Wybierz" → wybrany wariant przechodzi w normalny stan `review` (009),
  pozostałe taski są archiwizowane a ich worktrees kasowane. Jeden klik.

## Zakres

1. **Model**: pole `groupId` na tasku (warianty = taski z tym samym
   `groupId` + `variant: 'A'|'B'|'C'`). Żadnej nowej encji — grupa jest
   widokiem na taski (prostota modelu > elegancja).
2. **Start**: `POST /api/runs` z `variants: 2|3` tworzy N tasków z tym samym
   promptem/chainem; każdy własny worktree/branch `cez/<id8>` (006) i własna
   sesja. Kolejka/`maxParallel` obowiązuje normalnie (przy `maxParallel=2`
   trzeci wariant czeka — świadomie OK).
3. **Dywersyfikacja**: wariant B/C dostaje dopisek do promptu
   ("Approach hint: prefer minimal change" / "prefer thorough refactor") —
   stałe, dwa zdania; bez konfiguracji.
4. **Porównanie**: `GET /api/groups/:groupId` → per wariant: status, koszt,
   `git diff --stat`, skrót handoffa (pierwsze linie Progress log). GUI
   renderuje kolumny; pełny diff dociągany per wariant (endpoint z 006).
5. **Wybór**: `POST /api/groups/:groupId/pick` `{runId}` → zwycięzca zostaje
   (stan `review`), przegrani: cancel (jeśli żyją) + archive + remove
   worktree. Wpis do handoffa zwycięzcy "wybrany z N wariantów".

## Poza zakresem

- Auto-ocena wariantów przez AI-sędziego (kusi, ale to v2 — najpierw człowiek).
- Merge'owanie kawałków z różnych wariantów.
- Warianty na różnych modelach (proste do dodania później: ×2 = sonnet+opus).

## Projekt techniczny

- `src/runs/store.ts`: `groupId?`, `variant?`.
- `src/workflows/run.ts`: `startVariants(workflow, input, n)` — pętla po
  istniejącym `startRun` + dopiski do promptu.
- `src/server/server.ts`: `/api/groups/:id` (agregacja z istniejących
  danych), `/pick`.
- `web/app.js`: grupowanie kafelków po `groupId` (~30 linii), widok
  porównania (~120 linii). Reużywamy renderer diffu z 009.

## Kroki implementacji

1. Pola grupy + `startVariants` + przełącznik ×N (test z mockiem: mock
   losuje różne zmiany per wariant → różne diffy).
2. Endpoint grupy + widok porównania.
3. „Wybierz" + sprzątanie przegranych.
4. Test na żywo: realny task ×2, ocena czy hinty dają realnie różne podejścia.

## Kryteria akceptacji

- ×2 tworzy dwa niezależne taski w osobnych worktree; ich diffy są rozłączne
  od working tree usera i od siebie.
- Widok porównania pokazuje status/koszt/staty/skróty obu wariantów.
- „Wybierz" zostawia dokładnie jeden worktree/branch; przegrany znika z
  Active i z dysku; zwycięzca jest w `review` z działającym „Draft PR".
- Przy `maxParallel=2` i ×3: trzeci wariant grzecznie `queued`.
