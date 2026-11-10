# SpeelAtelier - Kleine Wonderwereld

Website van het sensorisch speelatelier van juf Valerie (Kalmthout), voor kinderen van 2 tot 6 jaar. Live op https://jufvalerie.be.

## Onderdelen
- `index.html`: publieke site (info, planning, boeking, galerij, FAQ, getuigenissen)
- `admin.html`: beheer (inschrijvingen, thema's, dashboard)
- `privacy.html`, `404.html`
- `sw.js`, `manifest.webmanifest`: PWA
- `supabase/`: SQL-scripts en Edge Functions (Mollie-betaling en webhook), zie `supabase/README.md`
- `shop/`: **webshop**, volledig los van de inschrijvingen
  - `shop/index.html`: winkel (producten, mandje, afrekenen via Mollie)
  - `shop/bedankt.html`: terugkeer na betaling
  - `shop/voorwaarden.html`: algemene verkoopsvoorwaarden
  - `shop/admin.html`: aparte admin (groen) voor producten, bestellingen, facturen, creditnota's, export
  - Backend: `supabase/sql/shop.sql` en de functies `shop-*` (zie `supabase/README.md`, sectie Webshop)

## Techniek
Statische HTML/CSS/JS zonder buildstap. Backend: Supabase. Betalingen: Mollie. Mails: EmailJS. Hosting: GitHub Pages (zie `CNAME`).

## Lokaal draaien
`python -m http.server 8000` en open http://localhost:8000.

## Let op
- Verhoog `CACHE_NAME` in `sw.js` na elke release, anders zien bezoekers oude bestanden.
- Houd `sitemap.xml` (lastmod) up-to-date.
