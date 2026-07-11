# 005 — Skille ze zdalnego repo (`open-mercato/skills`)

Status: ZAIMPLEMENTOWANE 2026-07-10 · Fala: 2 · Zależy od: — · Wzorzec: janitor `skills.ts` (bare clone + `git ls-tree`/`git show`, bez checkoutu)

## Cel

Skille zespołu żyją w jednym repo GitHub (`open-mercato/skills`) i są
dostępne w każdym cockpicie **bez żadnej konfiguracji** — obok skilli
lokalnych z `.ai/skills/`.

## UX (jak cep)

- User nic nie robi. Zakładka **Skills** po prostu pokazuje też skille z
  `open-mercato/skills`, z małą etykietą źródła (`team` / `repo` / `cez`).
- Jeden przycisk **„Refresh"** w zakładce Skills (robi `git fetch`).
- Brak sieci / brak dostępu do repo → skille zdalne po cichu znikają z listy,
  lokalne działają. Zero błędów blokujących.
- W kroku chaina skill wybiera się tak samo, niezależnie skąd pochodzi.

## Zakres

1. **Konfiguracja z defaultem** (opcjonalny `config.json`):
   ```json
   { "skillsRepos": [{ "repo": "open-mercato/skills", "ref": "main" }] }
   ```
   Brak pliku = dokładnie ta wartość. Klucz można nadpisać/wyczyścić.
2. **Bare clone bez checkoutu** (mechanizm janitora):
   - cache w `~/.cache/cez/skills/<owner>__<name>/` (globalnie, nie per repo —
     jeden fetch służy wszystkim projektom),
   - `git clone --bare` przy pierwszym użyciu; jedna próba na proces
     (`cloneAttempted` — git wisi bez sieci); „Refresh" = `git fetch`,
   - listowanie: `git ls-tree -r <ref> --name-only`; odczyt: `git show
     <ref>:<path>`. Zero plików roboczych.
3. **Dwie konwencje wykrywania** (jak janitor):
   - `**/SKILL.md` → skill nazwany katalogiem-rodzicem (z `references/`),
   - `**/commands/<name>.md` → skill `<name>`.
   Nasz istniejący format `.ai/skills/*.md` (frontmatter `name`/`description`)
   też pozostaje wspierany w repo zdalnym.
4. **Priorytet źródeł przy kolizji nazw** (od najsilniejszego):
   `.ai/cezar/skills` → `.ai/skills` → skills-repo. Lokalny override zawsze
   wygrywa — zasada "repo użytkownika jest źródłem prawdy".
5. **Seed do kontekstu agenta**: body skilla nadal idzie w
   `--append-system-prompt` (jak dziś). Dla skilli katalogowych (`SKILL.md` +
   references) — materializacja katalogu do `<cwd>/.claude/skills/<name>/`
   z wpisem do `.git/info/exclude` (wzorzec janitora), żeby claude widział
   references na dysku.
6. **API/GUI**: `GET /api/skills` zwraca też `source: 'team'`;
   `POST /api/skills/refresh` robi fetch; etykiety i przycisk w zakładce.

## Poza zakresem

- Instalacja skilli z URL/skills.sh (custom-skills janitora) — może później.
- Autoryzacja do prywatnych repo inna niż ta, którą git/gh już mają.
- Edycja skilli w GUI — skille edytuje się w edytorze, jak kod.

## Projekt techniczny

- Nowy moduł `src/skills-remote.ts` (~150 LOC): `ensureBareClone`, `fetchAll`,
  `listRemoteSkills`, `readRemoteSkill`, `materializeSkillDir`. Wszystko przez
  `execFile('git', …)` z timeoutami (10 s list/show, 60 s clone/fetch).
- `src/skills.ts`: `discoverSkills` merguje trzecie źródło; cache listy
  zdalnej w pamięci procesu (odświeżany przez endpoint).
- `src/workflows/run.ts`: materializacja katalogu skilla przed spawnem, gdy
  skill jest katalogowy.

## Kroki implementacji

1. `skills-remote.ts` + testy na lokalnym bare repo (fixture w testach —
   bez sieci).
2. Merge źródeł + priorytety w `discoverSkills`.
3. Materializacja katalogowa + `info/exclude`.
4. GUI: etykiety źródła + „Refresh".
5. Test ręczny na prawdziwym `open-mercato/skills`.

## Kryteria akceptacji

- Świeży cockpit w repo bez żadnego configu pokazuje skille z
  `open-mercato/skills` w ≤ kilka sekund od startu (clone w tle, lista
  dociąga się po sygnale SSE/refetchu).
- Skill zdalny użyty w chainie działa (body trafia do agenta; references
  widoczne w cwd).
- Odcięta sieć: cockpit startuje normalnie, zdalnych skilli brak, żadnego
  błędu w twarz.
- Kolizja nazw: lokalny skill wygrywa i ma etykietę lokalnego źródła.
