# 008 — Chain-z-prompta: AI składa łańcuch skilli

Status: ZAIMPLEMENTOWANE 2026-07-10 · Fala: 3 · Zależy od: 005 · Wzorzec: własny (janitor tego nie ma — nasz wyróżnik)

## Cel

User wpisuje **jeden prompt**, a Cez sam proponuje łańcuch kroków ze
skilli, które ma pod ręką (np. *spec → code → review → PR*). User zatwierdza
lub poprawia jednym gestem i patrzy, jak chain jedzie przez ogniwa.

## UX (jak cep)

- W formularzu nowego taska, obok „▶ Run", drugi przycisk: **„✨ Zaplanuj"**.
- Klik → po 2–5 s pod formularzem pojawia się **plan jako pionowa lista
  ogniw**: `1. spec-writing → 2. implement → 3. review-pr`, każde ogniwo
  z jedną linijką "co zrobi" i nazwą skilla.
- Operacje na planie: **usuń ogniwo (krzyżyk)** i **przeciągnij kolejność**.
  Koniec. Żadnej edycji promptów kroków w v1 (kto chce więcej — YAML).
- Przycisk **„▶ Start"** pod planem odpala chain. Przycisk **„Zapisz jako
  chain"** zapisuje YAML do `.ai/cezar/workflows/` (od tej pory jest w
  dropdownie jak każdy inny).
- Stan biegnącego chaina widać tak jak dziś: steps-rail z badge'ami
  (pending → running → done), nic nowego do nauczenia.

## Zakres

1. **Planner = jeden strzał do claude** (ten sam zalogowany CLI, model tani —
   default `haiku`/`sonnet` z config):
   - wejście: prompt usera + katalog skilli (nazwa + description — bez body,
     żeby prompt był mały) + opis wbudowanych kroków (`check`),
   - wyjście: JSON `{steps: [{skill?, prompt, name}], rationale}` — walidacja
     zod; nieparsowalne → 1 retry → fallback: plan jednokrokowy `quick-task`
     (nigdy nie blokujemy usera),
   - wywołanie: istniejący `ClaudeCliRunner` z `allowedTools: []`
     (czysta generacja, bez narzędzi), timeout 60 s.
2. **Plan → WorkflowDef**: kroki plannera mapują się 1:1 na nasz istniejący
   format (`agent` step: skill+prompt; planner może też zaproponować krok
   `check` z komendą testów, jeśli wykryje ją w repo — patrz 3).
3. **Wykrycie komendy weryfikacji**: planner dostaje w kontekście zawartość
   `package.json` scripts / `Makefile` targets (pierwsze 50 linii) i może
   dodać ogniwo `check` (np. `npm test`). Zero konfiguracji od usera.
4. **API**: `POST /api/plan` `{task}` → `{steps, rationale}`;
   `POST /api/runs` przyjmuje dodatkowo `steps` (inline chain, bez zapisu
   do pliku); `POST /api/workflows` `{name, steps}` zapisuje YAML.
5. **GUI**: sekcja planu pod formularzem (lista ogniw, drag = HTML5
   draggable — bez bibliotek), 3 przyciski.

## Poza zakresem

- Warunki/rozgałęzienia w planach (planner emituje tylko sekwencję + pętla
  `onFail` na checku).
- Automatyczny start bez zatwierdzenia — **human zatwierdza plan zawsze**.
- Uczenie się z historii planów (później, z 007-todos jako sygnałem).

## Projekt techniczny

- Nowy `src/planner.ts` (~120 LOC): budowa promptu plannera (stały szablon
  z instrukcją "wybieraj TYLKO z podanych skilli, JSON only"), wywołanie
  runnera, walidacja zod, fallback.
- `src/server/server.ts`: `/api/plan`, rozszerzenie `POST /api/runs` o
  `steps` (walidacja `workflowStepSchema` — już istnieje), `/api/workflows`
  (serializacja YAML przez `yaml.stringify`).
- `src/runs/store.ts`: `run.workflow` może być `"(planned)"` — kosmetyka.
- `web/app.js`: komponent planu (~100 linii).

## Kroki implementacji

1. `planner.ts` + testy promptu na mocku (mock zwraca stały JSON planu).
2. `POST /api/runs` z inline `steps` + `POST /api/workflows`.
3. GUI planu (lista, drag, usuń, 3 przyciski).
4. Kalibracja promptu plannera na żywych skillach open-mercato/skills
   (5–10 przykładowych zadań, ręczna ocena planów).

## Kryteria akceptacji

- „Zaplanuj" dla "napraw issue #12 i zrób PR" przy dostępnych skillach
  proponuje sensowny chain (skill fix + check + skill PR/review) w < 10 s.
- Usunięcie ogniwa i zmiana kolejności działają; „Start" odpala dokładnie
  zatwierdzony plan; steps-rail pokazuje ogniwa.
- „Zapisz jako chain" tworzy YAML, który waliduje się i pojawia w dropdownie.
- Zepsuta odpowiedź plannera nie wybucha: fallback do jednokrokowego planu
  z widoczną notką.
