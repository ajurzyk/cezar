# 003 — Handoff: „Kontynuuj" i „Otwórz w terminalu"

Status: ZAIMPLEMENTOWANE 2026-07-10 · Fala: 1 · Zależy od: 002 · Wzorzec: janitor `getTaskResumeCommand` + `openInTerminal.ts` + `continueTask`

## Cel

Sesję agenta można przejąć i oddać bez utraty kontekstu, bo **session-id
nadajemy sami** (= id kroku/taska). Trzy drzwi do tej samej rozmowy: GUI,
backend („Kontynuuj"), terminal (`claude --resume`).

## UX (jak cep)

Na zakończonym/przerwanym tasku są dokładnie **dwa przyciski**:

- **„Kontynuuj"** — task wraca do `running` w tej samej sesji; pole tekstowe
  znowu aktywne. (Pod spodem: re-spawn `claude --resume <sessionId>`.)
- **„Otwórz w terminalu"** — otwiera się okno terminala już w katalogu repo
  z podniesioną sesją. Obok mała ikonka „kopiuj komendę" dla nieufnych.

Zero konfiguracji, zero wyboru terminala — wykrywamy sami.

## Zakres

1. **„Kontynuuj"** (in-process resume): `POST /api/runs/:id/continue`
   `{text?}` → `RunManager.continue(runId)`:
   - bierze `sessionId` ostatniego kroku agentowego,
   - spawn `claude --resume <sessionId>` (stream-json, ta sama konfiguracja
     narzędzi co krok), status → `running`, dalej działa spec 002
     (`waiting` po turze itd.),
   - domyślna wiadomość `"Continue."` gdy user nic nie wpisał,
   - fallback: gdy `--resume` wysypie się (brak sesji na dysku) → czytelny
     event `note` + start świeżej sesji pod tym samym id (wzorzec ze starego
     cezara).
2. **„Otwórz w terminalu"**: `POST /api/runs/:id/open-in-cli` →
   `openInTerminal(cwd, 'claude --resume <sessionId>')`. Port modułu janitora
   `openInTerminal.ts` niemal 1:1:
   - macOS: `osascript` → Terminal.app `do script`,
   - Windows: git-bash → `wt.exe` → `cmd /K`,
   - Linux: wezterm/kitty/alacritty/x-terminal-emulator/gnome-terminal/
     konsole/xterm przez tymczasowy skrypt `.sh` (omija cytowanie),
   - `runDetached` + sukces po 250 ms bez błędu; gdy nic nie znaleziono →
     `409` i GUI pokazuje komendę do skopiowania.
3. **Komenda zawsze widoczna**: w headerze taska (jak dziś) —
   `cd <cwd> && claude --resume <sessionId>`; po spec 006 `cwd` = worktree.
4. **Powrót z terminala**: świadomie brak synchronizacji — to ta sama sesja
   claude, więc „Kontynuuj" w GUI po sesji terminalowej podnosi rozmowę ze
   stanem z terminala. Dokumentujemy to jako feature, nie bug.

## Poza zakresem

- Pty/WebSocket w przeglądarce (roadmap janitora — u nas też kiedyś, nie teraz).
- Handoff między maszynami.

## Projekt techniczny

- Nowy moduł `src/server/open-in-terminal.ts` (port z janitora, ~150 LOC).
- `src/workflows/run.ts`: `continueRun(runId, text?)` — dodaje syntetyczny
  krok `continue-N` do `run.steps` (osobne liczniki tokenów/czasu, ta sama
  sesja) albo wznawia ostatni krok — **decyzja: syntetyczny krok**, bo
  zachowuje prostotę modelu "krok = jeden spawn".
- `src/runs/store.ts`: pozwól dodawać kroki do istniejącego runu.
- `web/app.js`: dwa przyciski na terminalnym tasku; ukryj „Kontynuuj" gdy brak
  `sessionId`.

## Kroki implementacji

1. `continueRun` + syntetyczny krok + endpoint (test z mockiem: mock obsługuje
   `--resume`).
2. Port `open-in-terminal.ts` + endpoint + fallback „kopiuj komendę".
3. GUI: przyciski + stany.
4. Test ręczny macOS (Terminal.app) — jedyna platforma, którą mamy pod ręką;
   Windows/Linux: code review portu + zostawiamy fallback copy.

## Kryteria akceptacji

- Task `done` → „Kontynuuj" → agent pamięta poprzednią rozmowę (pytanie
  kontrolne „co robiłeś przed chwilą?").
- „Otwórz w terminalu" na macOS otwiera Terminal.app w katalogu repo z żywą
  sesją; ta sama rozmowa co w GUI.
- Po pracy w terminalu „Kontynuuj" w GUI zna kontekst z terminala.
- Na maszynie bez znanego terminala przycisk degraduje się do „skopiuj
  komendę" (nie ma błędu w konsoli, jest toast).
