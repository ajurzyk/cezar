# 011 — Bookmarklety: odpal skill z poziomu GitHuba jednym kliknięciem

Status: ZAIMPLEMENTOWANE 2026-07-10 · Fala: 3 · Zależy od: 005 (team skille), 008 (start runu z inline stepem) · Wzorzec: janitor `/bookmarklets` — plus dwa ulepszenia własne (auto-discovery portu/repo, launch-key)

## Cel

Jesteś na PR/issue na GitHubie, klikasz zakładkę w pasku przeglądarki —
cockpit cezara otwiera się **z już uruchomionym taskiem** na tym PR
(np. `om-auto-review-pr`), a Ty dalej oglądasz GitHuba. Zero przepisywania
numerów PR, zero przełączania kontekstu.

## UX (jak cep)

- Na dole zakładki **Skills** sekcja „**Run from GitHub**": rządek przycisków
  do **przeciągnięcia na pasek zakładek** (+ „Copy" dla każdego), filtr po
  nazwie skilla — jak w janitorze:
  - **Generic launcher** („cezar: this PR/issue") — otwiera cockpit z
    formularzem wypełnionym URL-em PR/issue; nic nie startuje samo.
  - **Per-skill** (jeden przycisk na skill) — otwiera cockpit i **od razu
    startuje** task z tym skillem i URL-em jako argumentem.
- Checkbox „One-click launch (auto-submit)" nad listą — wypieczony w
  przeciąganą zakładkę (re-drag po zmianie), jak w janitorze.
- Klik na stronie nie-GitHubowej → bookmarklet grzecznie mówi „open a GitHub
  PR or issue first" (alert) i nic nie robi.
- Cockpit nie działa → przeglądarka pokaże błąd połączenia; sekcja
  „How this works" mówi wprost: „cockpit musi działać (`npx cezar`)".

## Fajniej niż janitor (nasze dwa ulepszenia)

1. **Auto-discovery portu i repo.** Janitor ma stały host. Cez wybiera wolny
   port (4321+) i może działać w kilku repo naraz. Bookmarklet zamiast
   sztywnego portu **skanuje `http://localhost:4321..4330/api/health`**
   (fetch z krótkim timeoutem) i wybiera cockpit, którego `repo.remote`
   pasuje do `owner/repo` z URL-a GitHuba; fallback: pierwszy żywy cockpit.
   Efekt: dwa cockpity (dwa projekty) — klik na PR projektu A trafia do
   właściwego.
2. **Launch-key.** Auto-start z parametru GET to wektor drive-by (dowolna
   strona mogłaby nawigować na `localhost:4321/new?auto=1&task=…`, a agent
   ma Basha). Serwer trzyma losowy `launchKey` w `.ai/cezar/launch-key`
   (generowany przy pierwszym starcie, gitignorowany); strona bookmarkletów
   wypieka go w `javascript:`-URL. `auto=1` jest honorowane **tylko** z
   poprawnym kluczem; bez klucza → formularz wypełniony, start ręczny.
   Obca strona klucza nie zna. (Janitor rozwiązuje to loginem — my nie mamy
   i nie chcemy loginu.)

## Zakres

1. **Deep-link `/new`** (obsługa w `web/app.js` przy starcie):
   `/new?skill=<name>&ref=<github-url>&auto=1&key=<launchKey>`
   - bez `auto` / zły klucz: zakładka Runs, formularz wypełniony
     (`task` = ref-URL albo `<skill>: <ref>`), select ustawiony, fokus na
     przycisku ▶ Run;
   - `auto=1` + poprawny klucz: natychmiastowy `POST /api/runs` (per-skill:
     inline step `{skill, prompt: ref}` — API z 008; bez skilla: quick-task
     z promptem = ref) i przejście do widoku taska;
   - po obsłużeniu wyczyść query string (`history.replaceState`).
2. **`GET /api/launch-key`** — zwraca klucz (tylko localhost i tak jesteśmy);
   GUI używa go do budowy bookmarkletów. Klucz w `.ai/cezar/launch-key`
   (dopisany do generowanego `.gitignore`).
3. **Generator bookmarkletów** (czysty JS w `web/app.js`, ~60 linii):
   szablon funkcji, która na stronie GitHuba: waliduje
   `location.href` regexem `github\.com/<owner>/<repo>/(pull|issues)/<n>`,
   skanuje porty 4321–4330 (`Promise.any` na `/api/health`, timeout 800 ms,
   dopasowanie `repo.remote` do `owner/repo`), otwiera
   `http://localhost:<port>/new?...` w nowej karcie. Minifikacja ręczna
   (template string), `encodeURIComponent` na wszystkim.
4. **Sekcja GUI w zakładce Skills**: „Run from GitHub" — how-it-works (3
   zdania), checkbox auto-submit, generic launcher, per-skill przyciski
   (`<a href="javascript:…" draggable>`) z filtrem tekstowym i „Copy".
   Style spójne z resztą (panel + chipy).
5. **CSP/poprawność**: strona cockpitu nie może sama wykonywać `javascript:`
   linków — to tylko nośnik do przeciągnięcia; upewnij się, że klik w
   przycisk na stronie cockpitu NIE nawiguję (preventDefault + tooltip
   „drag me to your bookmarks bar").

## Poza zakresem

- Rozszerzenie przeglądarkowe, hostowana strona bookmarkletów.
- Wsparcie GitLab/Bitbucket (regex jest w jednym miejscu — łatwo dodać potem).
- Zdalny dostęp do cockpitu (to zmieniłoby model bezpieczeństwa całego ceza).

## Projekt techniczny

- `src/server/server.ts`: `GET /new` → serwuj `index.html` (SPA obsłuży
  query); `GET /api/launch-key` → `{key}`; generowanie klucza przy starcie
  (`randomUUID`, plik `.ai/cezar/launch-key`, `chmod 600` best-effort).
- `web/app.js`: parser query przy `init()`, moduł `bookmarklets` (szablon,
  render sekcji w loadSkills), filtr.
- `src/index.ts`: `ensureDataGitignore` + `launch-key` w ignorach.
- Health już zwraca `repo.remote` — nic do zmiany.

## Kroki implementacji

1. Launch-key + `/api/launch-key` + `/new` route.
2. Obsługa query w `init()` (prefill + auto-start przez API 008).
3. Generator bookmarkletów + sekcja w Skills z filtrem/copy/auto-submit.
4. Test: ręcznie na stronie PR w GitHubie (generic + per-skill + auto),
   test odrzucenia auto bez klucza (`curl`/ręczna nawigacja), test skanu
   portów przy cockpicie na 4322 (4321 zajęte przez inny proces).

## Kryteria akceptacji

- Przeciągnięty per-skill bookmarklet kliknięty na PR otwiera cockpit z
  **działającym** taskiem tego skilla na tym PR.
- Generic launcher wypełnia formularz i nic nie startuje.
- `.../new?auto=1&task=rm+-rf` bez klucza NIE startuje niczego.
- Dwa cockpity (repo A na 4321, repo B na 4322): bookmarklet z PR repo B
  trafia do cockpitu B.
- Sekcja w Skills renderuje się także offline (bez team-skilli) — z samymi
  lokalnymi skillami i generic launcherem.
