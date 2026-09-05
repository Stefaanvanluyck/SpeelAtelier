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

## Stap 4 — RLS-hardening (optie 4)

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

## Stap 5 — Galerij-uploads (optioneel)

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