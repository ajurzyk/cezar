# 012 — Workflow builder: zakładka Workflows w cockpicie

Status: ZAIMPLEMENTOWANE 2026-07-11 · Fala: 4 · Zależy od: 005, 008 · Wzorzec: design "Cezar Cockpit v2" (claude.ai/design, projekt 30e9a8b9)

## Cel

Workflow przestaje być plikiem YAML dla wtajemniczonych. Nowa zakładka
**Workflows** to builder: przeciągasz skille z palety do pionowego flow
(kolejność = kolejność wykonania), zapisujesz jednym klikiem, a plik jest
**przenośny** — eksport/import działa między repozytoriami.

## UX (jak cep)

- Zakładka **Workflows** w nawigacji (między Runs a Inbox).
- Canvas: karty kroków z uchwytem drag, numerem, opisem i ×; między kartami
  szczeliny "drop to insert" (podświetlają się w trakcie przeciągania).
- Prawy panel: **paleta skilli** (filtr, ✓ przy skillach już w flow, drag do
  canvasu) + podgląd **workflow.yaml** na żywo z przyciskiem Copy.
- Nagłówek: pigułka z nazwą (edytowalna), licznik kroków, **Import** (wklej
  YAML), **Export** (pobierz plik), **Save** (zapis do
  `.ai/cezar/workflows/<slug>.yaml`; istniejący plik → pytanie o nadpisanie).
- Rząd chipów **edit:** — jeden klik ładuje istniejący workflow do edycji;
  **+ new** czyści canvas. Pierwsze wejście w zakładkę wczytuje pierwszy
  plikowy workflow repo.
- Kroki spoza modelu "stos skilli" (check, własny prompt) też się renderują
  (badge `check`/`prompt`), da się je przestawiać i usuwać — edycja ich treści
  zostaje w YAML-u (Import/ręcznie). Skill nieznany w repo → badge `unknown`.

## Format przenośny

Nowa, kompaktowa forma pliku workflow (obok dotychczasowych `steps`):

```yaml
name: review-flow
skills:
  - commit-style
  - test-conventions
```

Każdy skill staje się jednym krokiem agenta `{id: <skill>, skill, prompt:
"{{task}}"}` (normalizacja przy wczytaniu). Zapis odwrotny: czysty stos skilli
serializuje się kompaktowo, wszystko bogatsze — pełną formą `steps:`.

## Zakres (co powstało)

1. **`src/workflows/types.ts`** — `workflowFileSchema` przyjmuje `steps` XOR
   `skills`; `skillsToSteps()`, `normalizeWorkflowDoc()`, `skillStackOf()`
   (odwrotność — wykrywa czysty stos).
2. **`src/workflows/load.ts`** — normalizacja przy wczytywaniu plików.
3. **`src/server/server.ts`** —
   - `POST /api/workflows` przyjmuje `skills` XOR `steps` + `overwrite`;
     409 z `exists: true` bez flagi; zapis kompaktowy dla czystych stosów;
   - `POST /api/workflows/parse` `{yaml}` → znormalizowana definicja
     (serwer parsuje YAML — GUI zostaje bez zależności).
4. **`web/`** — zakładka + builder (`wb*` w app.js, ~350 linii; style `wb-*`),
   drag & drop na HTML5 draggable (bez bibliotek), YAML w GUI generowany
   własnym mini-serializerem (quoting scalarów wyglądających jak bool/liczba).

## Poza zakresem

- Edycja treści kroków `check`/`prompt` w GUI (YAML-land — Import to pokrywa).
- Usuwanie plików workflow z GUI (pliki zamiast bazy — edytor/`rm`).
- Warunki/rozgałęzienia — silnik dalej zna tylko sekwencję + `onFail`.

## Kryteria akceptacji (zweryfikowane 2026-07-11, CEZ_DRY_RUN)

- Drag skilla z palety → karta ląduje we wskazanej szczelinie; reorder przez
  drag; × usuwa; licznik i YAML aktualizują się na żywo.
- Import kompaktowego YAML-a odtwarza flow (nieznany skill → badge `unknown`);
  roundtrip GUI-YAML → `/api/workflows/parse` przechodzi bez strat.
- Save tworzy plik (kompaktowy dla stosu skilli), workflow od razu widoczny
  w pigułce nowego taska, chipach GitHub i chipach edit; ponowny Save pyta
  o nadpisanie. Run takiego workflow wykonuje skille sekwencyjnie
  (ostatni krok interaktywny — `waiting`).
