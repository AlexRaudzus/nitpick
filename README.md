# Agent Feedback

Browser-Extension (Chrome/Chromium, MV3) zum Sammeln von UI-Feedback für Coding-Agents:
durch die App klicken, Elemente oder Bereiche kommentieren, am Ende einen Export erzeugen, den ein Agent abarbeiten kann.
Website-agnostisch – nichts landet im Bundle der App.

## Installation

```bash
pnpm install
pnpm build
```

Dann in Chrome `chrome://extensions` → Entwicklermodus → **Entpackte Erweiterung laden** → `.output/chrome-mv3`.

Für die Entwicklung an der Extension selbst: `pnpm dev` startet einen Browser mit Hot-Reload.

## Nutzung

1. Extension-Icon → **Session starten**.
2. Ganz normal durch die App klicken. Zum Kommentieren **`Strg+Alt` gedrückt halten** (macOS: `⌘+⌥`) und ein Element anklicken. Beim Loslassen ist wieder normales Navigieren aktiv. Während des Haltens wählt `↑` das Elternelement.
3. Toolbar unten rechts:
   - **+ Kommentar** – ein einzelnes Element kommentieren (ohne Tasten halten; auch `Alt+Shift+C`)
   - **Bereich** – Rechteck aufziehen und kommentieren
   - **Notiz** / **Liste** – öffnen sich beim Hovern über der Toolbar (Klick hält sie offen)
4. **Fertig** → **Exportieren** schreibt nach `~/Downloads/agent-feedback/<datum>_<uhrzeit>_<host>/` und legt den Ordnerpfad in die Zwischenablage.

Kommentare, Timeline und Console-Errors bleiben über Navigationen, Reloads und Origin-Wechsel hinweg erhalten.

### Export

```
agent-feedback/2026-10-23_14-02_localhost_3000/
  feedback.md          ← primär für den Agent
  feedback.json        ← gleiche Daten strukturiert (format: agent-feedback/v1)
  screenshots/
    01-crop.png        ← Close-up des Elements/Bereichs
    01-viewport.png    ← sichtbarer Bereich mit nummeriertem Marker
```

Pro Kommentar enthält `feedback.md`:
- Seite
- Element-Identifikatoren: Test-ID, Komponentenkette (React/Vue/Svelte in Dev-Builds), CSS-Selektor, Accessible Name, Position
- Screenshots
- die Schritte seit dem letzten Kommentar
- Console-Errors kurz davor
- App-Kontext

Danach folgen die komplette Action-Timeline und alle Console-Errors/-Warnings, dedupliziert.

An den Agent übergeben, z. B. in Claude Code:

> Arbeite das Feedback in ~/Downloads/agent-feedback/2026-10-23_14-02_localhost_3000/feedback.md ab. Schau dir zu jedem Punkt die Screenshots an.

### Datenschutz

- Passwort-, Token-, Karten- und ähnliche Felder werden in der Timeline als `••••` aufgezeichnet.
- JWTs, Bearer-Tokens und `password=…`-Muster in Logs werden geschwärzt.
- Network-Traffic wird bewusst nicht aufgezeichnet. Bei Bedarf ein HAR aus den DevTools exportieren.

## Metadaten von der Website (optional)

Die App kann zusätzlichen Kontext liefern (User-Rolle, Version, Tenant, Feature-Flags …). Dafür gibt es drei Varianten, die sich kombinieren lassen (spätere überschreiben frühere):

```html
<!-- 1. statisch -->
<meta name="agent-feedback:version" content="2.4.1">
```

```js
// 2. global (Objekt oder Funktion, darf async sein) – wird bei jedem Kommentar neu gelesen
window.__AGENT_FEEDBACK__ = () => ({ userRole: currentUser.role, tenant: tenant.slug });

// 3. Event – praktisch aus Komponenten/Stores heraus
window.addEventListener('agent-feedback:request-context', (e) => {
  e.detail.respond({ featureFlags: flags.enabled() });
});
```

Ohne installierte Extension passiert nichts. Der Code kann also auch in Production bleiben oder nur im Dev-Build aktiv sein.

## Entwicklung

```bash
pnpm typecheck
pnpm test            # Unit-Tests (Rendering, Element-Erkennung, Schwärzung)
pnpm build && pnpm e2e   # lädt die Extension in Playwright-Chromium und spielt eine Session durch
pnpm serve           # Test-Seite auf http://localhost:5179/settings für manuelles Testen
```

Aufbau:

| Datei | Aufgabe |
|---|---|
| `entrypoints/background.ts` | Session-State (`storage.local`), Screenshots, Export |
| `entrypoints/content/` | Toolbar-UI (React im Shadow DOM), Picker, Recorder |
| `entrypoints/page-bridge.content.ts` | läuft im Seitenkontext: Console, History, Framework-Komponenten, Metadaten |
| `lib/render.ts` | Markdown-/JSON-Export |
| `lib/describe-element.ts` | Selektor, Rolle, Name, XPath |

## Bekannte Grenzen

- Screenshots zeigen nur den sichtbaren Viewport. Das Element sollte beim Kommentieren also sichtbar sein.
- Modale mit hartem Focus-Trap (z. B. Radix Dialog) können dem Kommentarfeld den Fokus wegnehmen.
- Elemente in Cross-Origin-iframes lassen sich nicht auswählen.
- React 19 liefert keine Source-Location mehr, daher nur Komponentennamen. Vue und Svelte liefern in Dev-Builds die Datei.

## Roadmap

- v2: Video (`tabCapture`), Bridge-Snippet für das Management-Feedback-Modal (→ Linear, ein Ticket pro Session)
- v3: MCP-Companion (`get_latest_feedback`), Linear direkt, Dev-Loader-Script ohne Extension
