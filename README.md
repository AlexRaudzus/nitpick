# Nitpick

UI-Feedback für Coding-Agents sammeln: durch die App klicken, Elemente oder Bereiche kommentieren, am Ende einen Export erzeugen, den ein Agent abarbeiten kann.

Zwei Varianten mit demselben Kern:
- **Browser-Extension** (Chrome/Chromium, MV3) für die Entwicklung. Website-agnostisch, nichts landet im Bundle der App.
- **Embed** für die Einbindung in die eigene App. Kunden brauchen dann keine Extension; das Ergebnis geht direkt ins Feedback-Modal bzw. ins Ticket. Siehe [In-App-Variante](#in-app-variante-embed).

## Installation

```bash
pnpm install
pnpm build
```

Dann in Chrome `chrome://extensions` → Entwicklermodus → **Entpackte Erweiterung laden** → `.output/chrome-mv3`.

Für die Entwicklung an der Extension selbst: `pnpm dev` startet einen Browser mit Hot-Reload.

## Nutzung

1. **Klick aufs Extension-Icon** (oder `Alt+Shift+F`) startet eine Session. Bei einer laufenden Session blendet derselbe Klick die Toolbar ein oder aus, eine beendete setzt er fort. Das Badge am Icon zeigt die Anzahl der Kommentare.
2. Ganz normal durch die App klicken. Zum Kommentieren **`Strg+Alt` gedrückt halten** (macOS: `⌘+⌥`) und ein Element anklicken. Beim Loslassen ist wieder normales Navigieren aktiv. Solange die Tasten gedrückt sind, zeigt eine Leiste oben alle Kürzel.
3. Toolbar unten rechts:
   - **+ Kommentar** – ein einzelnes Element kommentieren (ohne Tasten halten; auch `Alt+Shift+C`)
   - **Bereich** – Rechteck aufziehen und kommentieren
   - **Notiz** / **Liste** (Symbol mit Anzahl) – öffnen sich beim Hovern über der Toolbar (Klick hält sie offen). Die Notiz gilt pro Seite und speichert sich selbst.
   - **⠿** – Toolbar verschieben, z. B. um Elemente dahinter auszuwählen. Die Position wird pro Website gemerkt, Doppelklick setzt sie zurück.
   - **⌄** – Toolbar ausblenden (Headless-Modus)
4. **Fertig** → **Exportieren** schreibt nach `~/Downloads/nitpick/<datum>_<uhrzeit>_<host>/` und legt den Ordnerpfad in die Zwischenablage.

Rechtsklick aufs Icon: Exportieren, Toolbar ein-/ausblenden, Tastenkürzel anpassen.

### Tastenkürzel

| Kürzel | Aktion |
|---|---|
| `Strg+Alt` halten + Klick | Element kommentieren (`↑` = Elternelement) |
| `Strg+Alt+B` | Bereich markieren |
| `Strg+Alt+N` | Notiz zur Seite |
| `Strg+Alt+K` | Kommentarliste |
| `Strg+Alt+H` | Toolbar ein-/ausblenden |
| `Strg+Alt+E` | Exportieren |
| `Alt+Shift+F` | wie Klick aufs Icon (auch ohne Fokus auf der Seite) |
| `Alt+Shift+C` | ein Element kommentieren |
| `Alt+Shift+E` | Exportieren |

Die `Alt+Shift`-Kürzel sind Browser-Kürzel und unter `chrome://extensions/shortcuts` änderbar. Die `Strg+Alt`-Kürzel gelten nur auf der Seite.

### Headless-Modus

Mit `Strg+Alt+H` (oder Icon-Klick) verschwindet die Toolbar.
- Die Session läuft weiter.
- Marker und die Kürzel-Leiste erscheinen nur, solange `Strg+Alt` gedrückt ist.
- Nach jedem Kommentar kommt eine kurze Bestätigung.
- Der Modus bleibt für spätere Sessions erhalten.

**Exportieren während einer laufenden Session** (`Strg+Alt+E`):
- Der Ordner wird geschrieben und der Pfad kopiert.
- Danach startet sofort eine neue, leere Session.
- So bleibt die Extension dauerhaft scharf: kommentieren, exportieren, dem Agent geben, weiter kommentieren.

Kommentare, Timeline und Console-Errors bleiben über Navigationen, Reloads und Origin-Wechsel hinweg erhalten.

### Export

```
nitpick/2026-10-23_14-02_localhost_3000/
  feedback.md          ← primär für den Agent
  feedback.json        ← gleiche Daten strukturiert (format: nitpick/v1)
  screenshots/
    01-crop.png        ← Close-up des Elements/Bereichs
    01-viewport.png    ← sichtbarer Bereich mit nummeriertem Marker
```

Pro Kommentar enthält `feedback.md`:
- Seite
- Element-Identifikatoren: Test-ID, Komponentenkette (React/Vue/Svelte in Dev-Builds), CSS-Selektor, Accessible Name, Position. Der Selektor bevorzugt stabile Attribute (`data-slot`, `name`, `aria-label` …), Utility-Klassen wie Tailwind verwendet er nie.
- Screenshots
- die Schritte seit dem letzten Kommentar
- Console-Errors kurz davor
- App-Kontext

Danach folgen die komplette Action-Timeline und alle Console-Errors/-Warnings, dedupliziert.

An den Agent übergeben, z. B. in Claude Code:

> Arbeite das Feedback in ~/Downloads/nitpick/2026-10-23_14-02_localhost_3000/feedback.md ab. Schau dir zu jedem Punkt die Screenshots an.

### Datenschutz

- Passwort-, Token-, Karten- und ähnliche Felder werden in der Timeline als `••••` aufgezeichnet.
- JWTs, Bearer-Tokens und `password=…`-Muster in Logs werden geschwärzt.
- Network-Traffic wird bewusst nicht aufgezeichnet. Bei Bedarf ein HAR aus den DevTools exportieren.

## Metadaten von der Website (optional)

Die App kann zusätzlichen Kontext liefern (User-Rolle, Version, Tenant, Feature-Flags …). Dafür gibt es drei Varianten, die sich kombinieren lassen (spätere überschreiben frühere):

```html
<!-- 1. statisch -->
<meta name="nitpick:version" content="2.4.1">
```

```js
// 2. global (Objekt oder Funktion, darf async sein) – wird bei jedem Kommentar neu gelesen
window.__NITPICK__ = () => ({ userRole: currentUser.role, tenant: tenant.slug });

// 3. Event – praktisch aus Komponenten/Stores heraus
window.addEventListener('nitpick:request-context', (e) => {
  e.detail.respond({ featureFlags: flags.enabled() });
});
```

Ohne installierte Extension passiert nichts. Der Code kann also auch in Production bleiben oder nur im Dev-Build aktiv sein.

## In-App-Variante (Embed)

```bash
pnpm build:embed   # → dist/embed/{index,loader}.js + Typen; React ist peer dependency
```

Einbindung, z. B. als `"nitpick": "link:../nitpick"`:

```ts
// App-Shell: winzig, ohne Abhängigkeiten
import { hasPendingSession, loadRecorder } from 'nitpick/embed/loader';

async function recorder() {
  const { createFeedbackRecorder } = await loadRecorder(); // lädt Toolbar + Recorder erst bei Bedarf
  return createFeedbackRecorder({
    context: () => ({ userRole: user.role, tenant: tenant.slug, version: APP_VERSION }),
    onComplete: (result) => openFeedbackModal(result), // Toolbar ist hier schon ausgeblendet
  });
}

// "Record"-Button im Feedback-Popover (muss ein Klick sein, wegen der Tab-Freigabe)
onRecordClick = async () => (await recorder()).start();

// Nach einem Reload läuft die Session weiter
if (hasPendingSession()) (await recorder()).restore();
```

`result` enthält:
- `markdown` und `json`
- `files` (`File[]`: `feedback.md`, `feedback.json`, `screenshots/NN-*.png`)
- `session`
- `renderMarkdown({ assetUrl })`: Markdown mit eingebetteten Bildern, z. B. nach dem Upload der Screenshots zu Linear

Das Modal entscheidet dann:
- `recorder.clear()` nach dem Erstellen des Tickets
- `recorder.restore()` bei Abbruch, dann ist die Toolbar wieder da

Unterschiede zur Extension:
- **Screenshots** (`screenshots: 'auto' | 'tab' | 'dom'`):
  - `auto` fragt beim Start einmal nach der Tab-Freigabe (`getDisplayMedia`, pixelgenau).
  - Wird sie abgelehnt oder ist die Seite neu geladen, rendert es das DOM nach (modern-screenshot). Dann können Cross-Origin-Bilder, Canvas und Video fehlen.
- **Speicher:** IndexedDB, übersteht Reloads. Mehrere Tabs synchronisieren sich über `BroadcastChannel`.
- **Kein Origin-Wechsel:** Die Session lebt pro Origin. Login-Redirects auf eine andere Domain landen nicht in der Timeline.
- Die Metadaten-Quellen von unten gelten auch hier. Zusätzlich gibt es die `context`-Option.

Lokal ausprobieren: `pnpm dev:embed` → http://localhost:5180/settings (mit simuliertem Feedback-Modal).

## Entwicklung

Icon: `assets/icon.png`, erzeugt mit Codex; weitere Entwürfe liegen in `assets/icon-concepts/`. Die Größen in `public/icon/` werden aus `assets/icon.png` heruntergerechnet.

```bash
pnpm typecheck
pnpm test            # Unit-Tests (Rendering, Element-Erkennung, Schwärzung)
pnpm build && pnpm e2e   # lädt die Extension in Playwright-Chromium und spielt eine Session durch
pnpm e2e:embed       # dieselbe Session in der In-App-Variante (Tab-Capture und DOM-Screenshots)
pnpm serve           # Test-Seite auf http://localhost:5179/settings für manuelles Testen
```

Aufbau:

| Datei | Aufgabe |
|---|---|
| `core/host.ts` | `FeedbackHost`: Schnittstelle zwischen UI und Umgebung (Speicher, Screenshots, Seitenzugriff, Abschluss-Aktionen) |
| `core/session-store.ts` | Session-Logik über einem Key-Value-Backend |
| `core/ui/` | Toolbar, Picker, Composer (React), Recorder, Screenshot-Markierung |
| `core/page.ts` | Code für den Seitenkontext: Console, History, Framework-Komponenten, Metadaten |
| `core/render.ts` | Markdown-/JSON-Export |
| `core/describe-element.ts` | Selektor, Rolle, Name, XPath |
| `entrypoints/`, `extension/` | Extension-Shell: Service Worker (`storage.local`, `captureVisibleTab`, Downloads), Content Script, MAIN-World-Bridge |
| `embed/` | In-App-Shell: IndexedDB, `getDisplayMedia`/DOM-Screenshots, `createFeedbackRecorder` |

## Bekannte Grenzen

- Screenshots zeigen nur den sichtbaren Viewport. Das Element sollte beim Kommentieren also sichtbar sein.
- Modale mit hartem Focus-Trap (z. B. Radix Dialog) können dem Kommentarfeld den Fokus wegnehmen.
- iframes: In der Extension lassen sich Elemente in iframes auswählen, auch über Domaingrenzen hinweg. Der Export nennt dann das iframe, und der Selektor bezieht sich auf das Dokument im iframe. Bereichskommentare und Marker sehen nicht ins iframe hinein. Im Embed funktioniert die Auswahl in iframes noch nicht.
- React 19 liefert keine Source-Location mehr, daher nur Komponentennamen. Vue und Svelte liefern in Dev-Builds die Datei.

## Roadmap

- Beispiel-Integration: Record-Button im Feedback-Popover einer App, Upload der Screenshots, ein Linear-Ticket pro Session
- Video: in der Extension per `tabCapture`, im Embed über den ohnehin offenen `getDisplayMedia`-Stream
