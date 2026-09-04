# Supabase — Veilige betaling & bedragsvalidatie

Dit pakket bevat de oplossingen voor de twee server-side beveiligingsitems
die niet vanuit de client-code geregeld kunnen worden:

| # | Bestand | Wat het doet |
|---|---------|--------------|
| 2 | `sql/amount_validation_trigger.sql` | DB-trigger die het bedrag altijd server-side herberekent, aantallen (1-4), datums (zaterdag, niet verleden) en capaciteit (10 kindjes) valideert, en nieuwe inschrijvingen op `pending` zet |
| 3 | `functions/create-mollie-payment/index.ts` | Edge Function die de online inschrijving en Mollie-betaallink server-side aanmaakt. Het bedrag wordt herberekend; de clientwaarde wordt genegeerd. |
| + | `functions/mollie-webhook/index.ts` | Webhook die Mollie-status **opnieuw verifieert bij Mollie** (tegen vervalste webhooks), de inschrijving bijwerkt en bij succes de mails verstuurt |

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

## Controle na implementatie

- [ ] `su -c`-achtige test: probeer via de browser een inschrijving met
      `amount = 0` te versturen → de DB slaat exact €18/€33/€48/€63 (+€0,40)
      op.
- [ ] Probeer `children_count = 10` te versturen → foutmelding.
- [ ] Probeer een inschrijving op een geblokkeerde datum of doordeweeks
      → foutmelding.
- [ ] Online betalen met een Mollie **testmodus**-key eerst uitproberen.

## Belangrijk

- De **service role key** geeft volledige database-toegang. Die zit enkel in
  de Edge Functions (server-side) en nooit in `index.html` of `admin.html`.
- Houd de prijzen in **drie** plaatsen identiek:
  1. `index.html` (`calculateAmount`)
  2. `sql/amount_validation_trigger.sql`
  3. `functions/create-mollie-payment/index.ts`