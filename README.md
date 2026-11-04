# HugoSMP Live

Live-Übersicht aller Twitch- und TikTok-Streams, die **[Auction]** oder **[Hugosmp]** im Titel oder als Tag haben.
Streams mit **Emote-Only-Chat** oder laufendem **VOD/Rerun** werden ausgeblendet (unten auf der Seite aufklappbar).

## Immer online: GitHub (empfohlen)

Die Seite läuft kostenlos auf GitHub – auch wenn dein PC aus ist.

- `.github/workflows/scan.yml` startet alle 5 Minuten `node server.js --once`. Das fragt Twitch und TikTok
  einmal ab und schreibt `public/data/streams.json`. Danach wird `public/` auf GitHub Pages veröffentlicht.
- GitHub startet geplante Läufe nicht minutengenau: Die Liste ist meist 5–15 Minuten alt.
- Twitch-Zugang: Repo → Settings → Secrets and variables → Actions → `TWITCH_CLIENT_ID` und `TWITCH_CLIENT_SECRET`
  (oder im Projektordner `gh secret set -f .env`).
- Neu erkannte TikTok-Accounts schreibt der Lauf selbst in `data/state.json`. Zum Hinzufügen oder Entfernen
  diese Datei auf GitHub bearbeiten.
- Sofort neu abfragen: Repo → Actions → „Streams aktualisieren“ → Run workflow.
- Das Repo muss öffentlich sein: Nur dann sind Actions-Minuten und Pages kostenlos. Geheimnisse liegen nur in den Secrets.

## Lokal starten

1. Node.js 20 oder neuer installieren.
2. `start.bat` doppelklicken – oder im Ordner `node server.js` ausführen.
3. Seite öffnet sich auf http://localhost:3000

## Öffentlich machen über den eigenen PC

`start-public.bat` doppelklicken. Es startet den Server und einen kostenlosen Cloudflare-Tunnel
(`tools\cloudflared.exe`, wird beim ersten Mal automatisch geladen). Im Fenster erscheint eine Adresse wie
`https://irgendwas.trycloudflare.com` – die kannst du teilen.

- Die Seite ist nur erreichbar, solange dein PC und beide Fenster laufen.
- Die Adresse ändert sich bei jedem Neustart. Für eine feste Adresse brauchst du ein Cloudflare-Konto mit eigener Domain („Named Tunnel“).
- Besucher aus dem Internet können nur lesen. Die TikTok-Accountliste lässt sich nur direkt am PC unter http://localhost:3000 ändern.
- Das Twitch-Secret bleibt auf deinem PC, es wird nie an Besucher geschickt.

## Twitch einrichten (einmalig, kostenlos)

1. https://dev.twitch.tv/console/apps/create öffnen → Anwendung registrieren
   - OAuth-Redirect-URL: `http://localhost`
   - Kategorie: Website Integration · Client-Typ: Vertraulich
2. Client-ID und ein neues Secret kopieren.
3. In `.env` eintragen (Vorlage: `.env.example`):
   ```
   TWITCH_CLIENT_ID=...
   TWITCH_CLIENT_SECRET=...
   ```
4. Server neu starten.

Der Server durchsucht jede Minute alle deutschsprachigen Live-Streams (offizielle Helix-API) nach den Tags
und prüft bei Treffern die Chat-Einstellungen auf Emote-Only.

## TikTok

TikTok hat **keine öffentliche Live-Suche**. Deshalb gibt es zwei Quellen:

1. **Minecraft-Feed mit Bilderkennung** (alle 3 Minuten): Der Server holt TikToks deutsche Minecraft-Lives
   und prüft jeden darauf, ob er auf **hugosmp.net** spielt. Geprüft werden nacheinander:
   - Tags im Titel
   - „HugoSMP“ in Name oder Bio
   - das Stream-Bild per Texterkennung (OCR): das Scoreboard zeigt `HUGOSMP.NET`, `4515/9500` und Zeilen wie
     Geld, Gems, Stars, Kills, Tode, Clan, Keyall, Spielzeit.

   Erkannte Streamer werden gemerkt und landen in der Accountliste.
2. **Accountliste** (alle 2 Minuten): manuell hinzugefügte Accounts, Twitch-Treffer mit gleichem Namen und
   früher erkannte Streamer. Auch hier wird live per Bild geprüft, wenn kein Tag im Titel steht.

Grenzen: Der Feed zeigt pro Abruf nur ~30 Lives, die TikTok empfiehlt; über die Zeit kommen andere dazu.
Ist das Spielbild im Hochformat stark verkleinert, ist das Scoreboard zu klein zum Lesen.
Emote-Only gibt es auf TikTok nicht, VOD-Erkennung läuft über den Titel.

Erkennung an eigenen Bildern testen: `node server.js --detect bild1.jpg bild2.jpg`

Die Bilderkennung braucht Pakete (`npm install`, ~100 MB: tesseract.js, jimp, ffmpeg-static).
`server.bat` installiert sie beim ersten Start automatisch. Abschalten: `"detectInImage": false` in `config.json`.

## Einstellungen – `config.json`

| Feld | Bedeutung |
| --- | --- |
| `tags` | Gesuchte Tags. Treffer: `[Tag]` im Titel (auch `[HugoSMP \| Tag 5]`), Twitch-Tag oder `#tag` |
| `matchPlainText` | `true` = auch ohne Klammern im Titel finden (z. B. „HugoSMP Tag 5“) |
| `vod.anywhere` | Wörter, die überall im Titel auf VOD/Rerun hinweisen |
| `vod.marked` | Wörter, die nur in Klammern oder am Titelanfang zählen (`[VOD]`, `VOD: …`) |
| `twitch.languages` | Stream-Sprachen, z. B. `["de"]`; leer = alle Sprachen |
| `twitch.gameIds` | Nur bestimmte Kategorien (Minecraft = `27471`); leer = alle |
| `twitch.refreshSeconds` / `tiktok.refreshSeconds` | Abfrage-Intervalle |
| `tiktok.autoAddTwitchStreamers` | Twitch-Treffer automatisch auf TikTok prüfen |
| `tiktok.minecraftFeed` / `feedRefreshSeconds` | TikToks Minecraft-Feed durchsuchen und wie oft |
| `tiktok.detectInImage` | HugoSMP-Scoreboard per OCR im Stream-Bild erkennen |
| `tiktok.recheckMinutes` | Wie oft ein Live ohne Treffer erneut per Bild geprüft wird |

Die TikTok-Accountliste liegt in `data/state.json`.
