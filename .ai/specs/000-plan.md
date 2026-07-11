# 000 — Plan implementacji Cez

Status: aktywny · Aktualizowany przy każdej zmianie zakresu

## Zasady nadrzędne (obowiązują każdą specyfikację)

**UX jak konstrukcja cepa.** Prostota jest ważniejsza niż każda funkcja z osobna.

1. **Zero konfiguracji na start.** `npx …` w katalogu repo i działa. Brak wizardów,
   brak pytań, brak wymaganych env varów. Konfiguracja istnieje tylko jako
   *opcjonalny* plik dla zaawansowanych.
2. **Zero nowych pojęć.** Użytkownik zna trzy słowa: **task**, **skill**, **chain**.
   Nie wprowadzamy pojęć typu "binding", "workspace", "dispatch", "runner".
3. **Jedna funkcja = jeden klik.** Jeżeli funkcja wymaga formularza z więcej niż
   2 polami albo drugiego ekranu — projekt jest zły, wracamy do deski.
4. **Pliki zamiast bazy.** Cały stan w `.ai/cezar/` w repo użytkownika: JSON +
   NDJSON + Markdown. Wszystko da się przeczytać `cat`-em i naprawić edytorem.
5. **CLI hosta jest źródłem mocy.** `claude` (auth przez subskrypcję), `gh`
   (auth przez `gh auth login`), `git`. Nie trzymamy żadnych sekretów.
6. **DEV UX = repo UX.** Kod Ceza sam ma być prosty: zero build stepu w GUI
   (vanilla JS), jeden pakiet, `npm run dev` i działa. Każdy moduł czytelny
   w jedno posiedzenie.
7. **Degradacja zamiast błędu.** Brak `gh`? Działa bez PR-ów. Brak sieci? Działają
   lokalne skille. Brak `.ai/skills`? Działa goły prompt. Nigdy nie blokujemy startu.

## Stan wyjściowy (już działa)

Silnik: `ClaudeCliRunner` (stream-json), workflowy YAML (kroki agent/check +
pętla `onFail`), store plikowy (index + NDJSON eventów), serwer Hono + SSE,
GUI (Runs/Repo/Skills), CLI (`serve`/`run`/`init`), mock `CEZ_DRY_RUN=1`.

## Fale

### Fala 1 — "poniedziałek": Piotr może się przesiąść z janitora
| Spec | Co | Zależy od |
|---|---|---|
| [001](001-packaging-npx.md) | Nazwa paczki, `npx`, dane w `.ai/cezar/`, auto-port, publish | — |
| [002](002-live-session.md) | Żywa sesja: follow-upy + obrazki przez stdin, status `needs_input` | — |
| [003](003-handoff-cli.md) | Handoff: „Kontynuuj" + „Otwórz w terminalu" (`claude --resume`) | 002 |
| [004](004-cockpit-tasklist.md) | Lista tasków: link do PR, archiwizacja, koszt $ | — |

**Definition of done fali 1:** świeży użytkownik w swoim repo robi `npx …`,
zleca task z GUI, dopisuje wiadomość w trakcie, wkleja screenshot, przejmuje
sesję w terminalu jednym kliknięciem, widzi PR-link i koszt, archiwizuje.

### Fala 2 — parytet z janitorem tam, gdzie jest lepszy
| Spec | Co | Zależy od |
|---|---|---|
| [005](005-remote-skills.md) | Skille z repo `open-mercato/skills` (bare clone, bez checkoutu) | — |
| [006](006-worktree-queue.md) | Worktree per task, kolejka, `maxParallel`, autosave-commit | — |
| [007](007-handoff-file-todos.md) | `handoff.md` per task + globalny inbox `todos.json` | 002 |

**DoD fali 2:** dwa taski działają równolegle nie deptając sobie po working
tree; skill z open-mercato/skills wybieralny bez żadnej konfiguracji; po tasku
w Inboxie czeka follow-up z sugestią kolejnego skilla (1 klik = nowy task).

### Fala 3 — przewaga nad janitorem i "agentami kodującymi"
| Spec | Co | Zależy od |
|---|---|---|
| [008](008-chain-from-prompt.md) | Chain-z-prompta: AI składa łańcuch skilli, user zatwierdza | 005 |
| [009](009-diff-review-gate.md) | Diff-first review gate: zobacz kod → uwagi wracają do sesji → PR | 002, 006 |
| [010](010-parallel-variants.md) | Warianty: N agentów na jeden task, porównanie diffów, wybór | 006 |
| [011](011-bookmarklets.md) | Bookmarklety: odpal skill z GitHuba 1 kliknięciem (+ auto-discovery portu/repo, launch-key) | 005, 008 |

**DoD fali 3:** "wpisujesz prompt → AI proponuje chain → klikasz start →
na końcu oglądasz diff → wysyłasz PR draft" bez dotykania YAML-a — plus
"jesteś na PR w GitHubie → klik w zakładkę → review już leci".

### Fala 4 — cockpit v2 (redesign z claude.ai/design)
| Spec | Co | Zależy od |
|---|---|---|
| — (2026-07-10/11) | Cockpit v2: redesign GUI, zakładka GitHub przez `gh`, obrazki task→agent i agent→transcript, pill-dropdowny z wyszukiwarką | — |
| [012](012-workflow-builder.md) | Workflow builder: zakładka Workflows, drag & drop skilli, przenośny YAML (`skills:`), import/export/save | 005, 008 |
| — (2026-07-11, feedback Piotra) | Notes renderują markdown; plan jako overlay w głównym oknie (nie w sidebarze); klikalne commity w Repo (rozwijany diff + link GitHub); discovery skilli z `npx skills` (`.agents/skills` + mirrory agentów + globalne `~/.agents`, `~/.claude`, SKILL.md → nazwa z katalogu, unia bez duplikatów); picker domyślnie na Skills + ikonki w menu i pasku akcji | — |
| — (2026-07-11, feedback #2) | Default = ostatnio używany skill (`.ai/cezar/ui-state.json`, GET/PUT /api/ui-state), fallback pierwszy skill; GitHub bez capa 30 (szybki strzał + tło `?limit=1000`, liczniki `30+` do czasu pełnego fetcha, scroll zachowany przy re-renderze); markdown w gh body i tekstach transkryptu (+ blockquote, checkboxy); workflow-chip odznaczalny (null → skille jako chain / quick-task); filtr nad chipami skilli (>10); drag issue/PR → pole taska prefiluje prompt; szersza kolumna listy (`clamp(340px,27vw,560px)`); DELETE /api/workflows/:name + Delete w builderze | — |
| — (2026-07-11, feedback #3) | Statusy: resync listy runów przy każdym (re)connect SSE i powrocie karty (stale "Working" po śnie laptopa), pill `review` → "needs review"; **base branch** konfigurowalny (Repo tab → `PUT /api/config` → `config.json baseBranch`): worktree forkuje z niego (fallback `origin/<base>`, potem bieżący branch + note), draft PR dostaje `--base` | — |

## Kolejność wykonania (co po czym)

```
001 ──► publish v0.2 (npx działa u Piotra)
002 ──► 003 ──► 004 ──► publish v0.3  ◄── koniec fali 1
005 ──► 006 ──► 007 ──► publish v0.4  ◄── koniec fali 2
008 ──► 009 ──► 010 ──► 011 ──► publish v0.5  ◄── koniec fali 3
```

Zasada wydawnicza: po każdej fali publikacja na npm i test na czystej maszynie
(`npx` w cudzym repo). Nie trzymamy nic długo na branchu.

## Otwarte decyzje

1. ~~Nazwa paczki npm~~ → **ROZSTRZYGNIĘTE (2026-07-10, Patryk):**
   `@open-mercato/cezar` (org scope dostępny) + alias unscoped `cezar`
   (folder `alias-cezar/`), żeby `npx cezar` działało dosłownie. Bin: `cezar`
   (+ `cez` jako skrót).
2. **Idle-timeout otwartej sesji** — propozycja 15 min (spec 002), do walidacji.
3. **Domyślny `maxParallel`** — propozycja 2 (spec 006).
