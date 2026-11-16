# Supabase — Veilige betaling & bedragsvalidatie

Dit pakket bevat de oplossingen voor de twee server-side beveiligingsitems
die niet vanuit de client-code geregeld kunnen worden:

| # | Bestand | Wat het doet |
|---|---------|--------------|
| 2 | `sql/amount_validation_trigger.sql` | DB-trigger die het bedrag altijd server-side herberekent, aantallen (1-4), datums (zaterdag, niet verleden) en capaciteit (10 kindjes) valideert, en nieuwe inschrijvingen op `pending` zet |
| 3 | `functions/create-mollie-payment/index.ts` | Edge Function die de online inschrijving en Mollie-betaallink server-side aanmaakt. Het bedrag wordt herberekend; de clientwaarde wordt genegeerd. |
| + | `functions/mollie-webhook/index.ts` | Webhook die Mollie-status **opnieuw verifieert bij Mollie** (tegen vervalste webhooks), de inschrijving bijwerkt en bij succes de mails verstuurt |
| 4 | `sql/rls_hardening.sql` | RLS-beveiliging: anon mag alleen minimale kolommen lezen (geen naam/e-mail/kinderen), alleen inschrijvingen aanmaken, en NOOIT iets muteren; volledige toegang vereist een admin-rij in `admin_users` |
| + | `sql/testimonials.sql` | Reviews door gezinnen met een inschrijving (controle via e-mail) + beheer in admin.html |
| + | `sql/gallery.sql` | Galerij-uploads: publieke Storage-bucket `gallery` + `gallery`-tabel met RLS (anon leest enkel gepubliceerde foto's) |

---

## Stap 1 — Database trigger (optie 2)

1. Ga naar [Supabase Dashboard](https://supabase.com/dashboard) → jouw project.
2. Klik links op **SQL Editor**.
3. Open `sql/amount_validation_trigger.sql`, kopieer de inhoud en plak die in de editor.
4. Klik **Run**.

> De trigger geldt voor de `appointments`-tabel:
> - **INSERT** (ter plaatse of online): bedrag wordt herberekend volgens
>   prijs 1e kind €18 + €15 per extra kind (+ €0,40 transactiekost online).
>   `payment_status` wordt geforceerd op `pending`.
> - De `mollie_payment_id`-kolom wordt gebruikt om de Mollie-payment te koppelen
>   aan de inschrijving.

## Stap 2 — Edge Functions (optie 3)

### 2a. Secrets instellen

Ga naar **Edge Functions → Manage → Secrets** en voeg toe:

| Secret | Waarde |
|--------|--------|
| `MOLLIE_API_KEY` | jouw Mollie **live** API-sleutel |
| `BASE_URL` | `https://jufvalerie.be` |
| `EMAILJS_PUBLIC_KEY` | `ryf0HAbDqTzY368PW` |
| `EMAILJS_PRIVATE_KEY` | jouw **Private Key** (Account → Security) — enkel nodig als "Use Private Key" en/of "Allow EmailJS API for non-browser applications" aanstaat |
| `EMAILJS_SERVICE` | `service_9u8ex4o` |
| `EMAILJS_CONFIRMATION_TEMPLATE` | `template_m20bheg` |
| `EMAILJS_ADMIN_TEMPLATE` | `template_nndh15x` |

### 2b. Deployen

Via de Supabase CLI in deze projectmap:

```bash
supabase functions deploy create-mollie-payment
supabase functions deploy mollie-webhook
```

Of upload de mapjes via **Edge Functions → Deploy** in het dashboard.

### 2c. Zo configureren dat Mollie de webhook kan bereiken

Mollie verstuurt webhooks naar een **publiek HTTPS-addres**.
De webhook-URL die in `create-mollie-payment` wordt meegeven is:

```
https://nafajvywiknelkgufpac.supabase.co/functions/v1/mollie-webhook
```

Dit werkt vanzelf zodra de functie is gedeployed (geen extra config nodig).

---

## Stap 3 — RLS-hardening (optie 4)

1. Open `sql/rls_hardening.sql`.
2. Vervang op de eerste regel van het `DO`-blok
   `'JOUW_EMAIL@voorbeeld.be'` door het e-mailadres **waarmee je zelf op
   `admin.html` inlogt** (dit wordt de eerste beheerder).
3. In [Supabase Dashboard](https://supabase.com/dashboard) → **SQL Editor**
   → de inhoud plakken → **Run**.

Wat het script doet:

| Tabel / rol | Nog toegelaten |
|---|---|
| `appointments` (anon) | alleen **INSERT** (inschrijving aanmaken) + **SELECT** van `id, appointment_date, children_count, payment_status, amount, payment_method` voor kalender/return |
| `appointments` (anon) | **GEEN** `name`, `email`, `child1-4`, ... meer leesbaar; **geen** UPDATE/DELETE |
| `themes` / `blocked_dates` (anon) | alleen SELECT (datum/themavelden) |
| alle beheertabellen (authenticated) | alleen als de e-mail een rij heeft in `admin_users`; een zelf aangemaakt account is dus geen beheerder |
| Edge functions | `service_role` bypasset RLS → webhook & betaalflow werken gewoon |

Daarna — handmatige toggles in het dashboard:

1. **Supabase → Authentication → Providers → Email**:
   zet **"Allow new users to sign up"** op **uit**. (Jouw bestaande admin-account
   blijft gewoon inloggen; er kunnen geen vreemde accounts meer aangemaakt worden.)
2. **EmailJS → Account → Security**: vink **"Allow EmailJS API for
   non-browser applications"** aan als de webhook mails via de server verstuurt.

Nadien deze bestanden opnieuw deployen (bevatten de code die met het nieuwe
RLS-schema compatibel is):

- `index.html` (plant publiceren/kopieren naar de hosting)
- `admin.html`

---

## Stap 4 — Galerij-uploads (optioneel)

1. Open `sql/gallery.sql`.
2. In [Supabase Dashboard](https://supabase.com/dashboard) → **SQL Editor**
   → de inhoud plakken → **Run**.
3. Daarna in `admin.html` (👉 galerij) foto's uploaden. Ze verschijnen
   automatisch in `index.html` zodra ze zijn gepubliceerd.

> De website toont enkel rijen met `published = true`. Tot de SQL gedraaid
> is, blijven de ingebouwde voorbeeldfoto's zichtbaar en blijft de rest van
> `admin.html` gewoon werken.

## Controle na implementatie

- [ ] `su -c`-achtige test: probeer via de browser een inschrijving met
      `amount = 0` te versturen → de DB slaat exact €18/€33/€48/€63 (+€0,40)
      op.
- [ ] Probeer `children_count = 10` te versturen → foutmelding.
- [ ] Probeer een inschrijving op een geblokkeerde datum of doordeweeks
      → foutmelding.
- [ ] Online betalen met een Mollie **testmodus**-key eerst uitproberen.
- [ ] Anoniem (niet ingelogd, netwerktab) de kalender openen → werkt
      (alleen `date/theme/children_count/status` zichtbaar).
- [ ] Anoniem via het netwerktab de API aanspreken met
      `PATCH /rest/v1/appointments?id=<pak een id>` → **HTTP 403/401**,
      geen wijziging.
- [ ] Anoniem `SELECT */name` via de API → kolommen `name/email/child1-4`
      ontbreken in het antwoord.
- [ ] Inloggen op `admin.html` met jouw admin-e-mail → dashboard laadt.
- [ ] Een tweede (wegwerp)-account aanmaken → kan `admin.html` **niet**
      openen en wordt automatisch uitgelogd.

## Belangrijk

- De **service role key** geeft volledige database-toegang. Die zit enkel in
  de Edge Functions (server-side) en nooit in `index.html` of `admin.html`.
- Houd de prijzen in **drie** plaatsen identiek:
  1. `index.html` (`calculateAmount`)
  2. `sql/amount_validation_trigger.sql`
  3. `functions/create-mollie-payment/index.ts`

## Security hardening (2026)

Draai `sql/security_hardening_2026.sql` als LAATSTE script in de SQL Editor (na alle andere scripts) en deploy daarna beide edge functions opnieuw:

```bash
supabase functions deploy create-mollie-payment
supabase functions deploy mollie-webhook --no-verify-jwt
```

Beurtenkaart via de website wordt nu `pass_requested` (te bevestigen). In admin.html bevestig je met de 🎟️-knop ("Kaart – te bevestigen"); pas dan worden beurten afgetrokken.

CDN-scripts zijn vastgezet met SRI. Nieuwe hash berekenen: `curl -s URL | openssl dgst -sha384 -binary | openssl base64 -A`.

---

## Webshop (jufvalerie.be/shop/)

Volledig gescheiden van de inschrijvingen: eigen tabellen (`shop_*`), eigen
Edge Functions (`shop-*`) en een eigen admin (`shop/admin.html`). De bestaande
`create-mollie-payment` en `mollie-webhook` blijven ongewijzigd.

### 1. Database
SQL Editor → `sql/shop.sql` plakken → **Run** (na `security_hardening_2026.sql`).
Maakt tabellen, factuurnummering zonder gaten, onveranderlijke facturen,
RLS en de Storage-buckets `shop-products` (publiek) en `shop-documents` (privé).

### 2. EmailJS — één nieuwe template
Maak in EmailJS een template aan met:

| Veld | Waarde |
|---|---|
| To Email | `{{to_email}}` |
| Subject | `{{subject}}` |
| Reply To | `{{reply_to}}` |
| Content | `{{{message_html}}}` (drie accolades!) |

### 3. Secrets (bovenop de bestaande)
| Secret | Waarde |
|---|---|
| `EMAILJS_SHOP_TEMPLATE` | id van de nieuwe template |
| `SHOP_ADMIN_EMAIL` | adres dat een melding krijgt bij elke nieuwe bestelling |

### 4. Deployen
```bash
supabase functions deploy shop-create-order
supabase functions deploy shop-admin
supabase functions deploy shop-mollie-webhook --no-verify-jwt
supabase functions deploy shop-document --no-verify-jwt
```
(`_shared/shop.ts` wordt automatisch meegenomen.)

### 5. In gebruik nemen
1. Ga naar `https://jufvalerie.be/shop/admin.html` (of via de knop in de gewone admin).
2. **Instellingen**: controleer bedrijfsgegevens, verzendkost, afhaalinfo.
3. **Producten**: voeg producten + foto's toe en zet ze op "zichtbaar".
4. Test eerst met een Mollie **test**-sleutel; zet daarna "Webshop is open" aan.
5. Zet "Webshop tonen op de website" aan om de link in het menu van de
   hoofdsite te tonen (standaard verborgen). Draaide je `shop.sql` al vóór
   deze optie bestond, voer dan eerst `sql/shop_show_on_site.sql` uit.

### Facturatie
- Na een geslaagde betaling maakt `shop-mollie-webhook` automatisch de factuur
  (`W2026-0001`, ...) + pdf aan en mailt de klant een downloadlink.
- Facturen kunnen niet gewijzigd of verwijderd worden (databasetrigger).
  Rechtzetten = creditnota (`WC2026-0001`, ...) via de bestelling in de admin,
  optioneel met automatische terugbetaling via Mollie.
- Tab **Facturen** → CSV-export per maand/kwartaal/jaar voor de boekhouder.
- Tab **Overzicht** → omzet t.o.v. de grens van de vrijstellingsregeling.

### Categorieën, kortingscodes, productpagina's en wachtlijst (update)
Draaide je `shop.sql` al eerder? Plak het **volledige** `sql/shop.sql` opnieuw
in de SQL Editor → **Run** (het script is idempotent: bestaande gegevens
blijven behouden). Deploy daarna opnieuw:

```bash
supabase functions deploy shop-create-order
supabase functions deploy shop-admin
supabase functions deploy shop-mollie-webhook --no-verify-jwt
supabase functions deploy shop-document --no-verify-jwt
```

- **Categorieën**: Producten → "Categorieën beheren". Klanten filteren en
  zoeken bovenaan de webshop; de filter staat in de link (`/shop/?cat=...&q=...`).
- **Kortingscodes**: tab Kortingscodes. Percentage of vast bedrag, optioneel
  minimumbedrag, geldigheidsperiode en maximaal aantal keer te gebruiken. De
  korting gaat van het subtotaal af (niet van de verzendkost; de grens voor
  gratis verzending geldt op het bedrag ná korting). Het bedrag wordt in de
  database berekend (`shop_check_discount`) en staat op factuur en mails.
  "Gebruikt" telt enkel betaalde bestellingen.
- **Productpagina's**: elk product heeft een eigen deelbare link
  `/shop/product.html?p=<slug>` met titel, beschrijving en schema.org-gegevens
  voor Google. Oude links `/shop/#slug` worden doorgestuurd. Let op: Facebook/
  WhatsApp-voorbeelden tonen de algemene webshopfoto, omdat die geen JavaScript
  uitvoeren (statische hosting).
- **Wachtlijst**: is de webshop gesloten, dan kunnen bezoekers hun e-mailadres
  achterlaten. Tab Wachtlijst → adressen kopiëren (BCC), markeren als
  verwittigd en daarna wissen (zoals beloofd in de privacyverklaring).
- **Presentatie**: per product een optionele *van-prijs* (doorstreept, promo),
  een *label* (Nieuw, Promo, Bestseller, …) en *uitgelicht* (bovenaan bij
  "Aanbevolen"). Er wordt altijd de gewone prijs aangerekend. Producten kan je
  dupliceren in de admin.
- **Cadeauverpakking**: Instellingen → Cadeauverpakking (standaard uit). Klanten
  vinken "Als cadeau inpakken" aan en schrijven een boodschap voor het kaartje.
  De prijs komt apart op factuur en mails; de boodschap staat op de pakbon en in
  de productieplanning.
- **Productieplanning** (admin → Productie): alle stuks die nog gemaakt moeten
  worden, opgeteld per product, met opmerkingen en cadeauboodschappen; afdrukbaar.
- **Verzendlabels en pakbonnen** (admin → Bestellingen): selecteer bestellingen
  of klik "Selecteer alle te verzenden" → labels op A4 (4 of 8 per blad, startpositie
  instelbaar) met QR-code naar de bestelling in de admin.

### Testgegevens
- `sql/shop_testdata.sql`: 4 categorieën, 9 testproducten (slug `test-…`) en
  3 kortingscodes (`TEST…`). Ze worden **verborgen/uitgeschakeld** toegevoegd,
  zodat een open webshop er geen last van heeft. Onderaan staat een
  uitgecommentarieerd blok om ze zichtbaar te maken (enkel doen als de shop
  gesloten is of in een testproject).
- `sql/shop_testdata_remove.sql`: wist alles weer. Bestellingen en facturen
  blijven bewaard.


