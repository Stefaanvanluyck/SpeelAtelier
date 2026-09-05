-- ============================================================================
-- CHILDREN — jufvalerie.be / SpeelAtelier
-- ============================================================================
-- Doel: per kind aparte data bijhouden die gekoppeld is aan één inschrijving
-- (appointment). Zo kan je per kind bijhouden of er foto's mogen genomen
-- worden, of het kind aanwezig is (check-in), en later uitbreiden met
-- leeftijd, allergieën, enz.
--
-- Elke rij in `children` hoort bij exact één inschrijving in `appointments`.
-- Als de inschrijving verwijderd wordt, worden de kindrijen automatisch
-- mee verwijderd (ON DELETE CASCADE).
--
-- Rechten:
--   * anon (iedereen op de website) : GEEN rechten. Foto-toestemming,
--                                       check-in en kindgegevens zijn privé.
--   * authenticated                 : enkel leden van admin_users kunnen de
--                                       kinderen lezen / aanpassen /
--                                       verwijderen (zelfde aanpak als in
--                                       rls_hardening.sql voor appointments).
--
-- ============================================================================
-- UITVOEREN:  Supabase Dashboard > SQL Editor > hele bestand plakken > Run
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Tabel aanmaken
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.children (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    appointment_id uuid        NOT NULL REFERENCES public.appointments(id)
                               ON DELETE CASCADE,
    name           text        NOT NULL,
    age            integer,                 -- optioneel, later uitbreidbaar
    photo_allowed  boolean     NOT NULL DEFAULT false,
    allergies      text,                   -- optioneel, later uitbreidbaar
    checked_in     boolean     NOT NULL DEFAULT false,
    checked_in_at  timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now()
);

-- index om snel per inschrijving de kinderen te vinden
CREATE INDEX IF NOT EXISTS idx_children_appointment
    ON public.children (appointment_id);

-- ---------------------------------------------------------------------------
-- 2. RLS inschakelen
-- ---------------------------------------------------------------------------
ALTER TABLE public.children ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 3. Rechten (grants)
-- ---------------------------------------------------------------------------

-- anon: alles intrekken, daarna enkel INSERT toekennen.
-- (De website voegt bij een inschrijving kindrijen toe vanuit de browser;
--  lezen/wijzigen/verwijderen blijft volledig verboden voor anon.)
REVOKE ALL ON public.children FROM anon;

GRANT INSERT ON public.children TO anon;

-- authenticated (aangemelde gebruiker): volledige tabelrechten,
-- maar de policy bepaalt dat alleen een admin_users-lid er iets mee mag.
GRANT ALL ON public.children TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Policies
-- ---------------------------------------------------------------------------

-- anon: alleen kindrijen TOEVOEGEN, enkel voor een bestaande inschrijving
-- (hetzelfde principe als anon_creates_appointments op appointments).
DROP POLICY IF EXISTS "anon_creates_children" ON public.children;
CREATE POLICY "anon_creates_children"
    ON public.children FOR INSERT TO anon
    WITH CHECK (EXISTS (
        SELECT 1 FROM public.appointments
        WHERE id = appointment_id
    ));

DROP POLICY IF EXISTS "admin_full_children" ON public.children;
CREATE POLICY "admin_full_children"
    ON public.children TO authenticated
    USING (EXISTS (
        SELECT 1 FROM public.admin_users
        WHERE email = LOWER(auth.jwt() ->> 'email')
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM public.admin_users
        WHERE email = LOWER(auth.jwt() ->> 'email')
    ));

-- ---------------------------------------------------------------------------
-- 5. Migratie van bestaande data
-- ---------------------------------------------------------------------------
-- Bestaande reserveringen hebben kindernamen opgeslagen in de kolommen
-- child1..child4 van appointments. Deze migratie verplaatst die namen naar
-- de nieuwe children-tabel (foto-toestemming staat standaard op 'false').
-- Je mag de kolommen child1..child4 daarna optioneel verwijderen uit de
-- appointments-tabel (zie opmerking onderaan), maar dat is niet verplicht.
-- ---------------------------------------------------------------------------
INSERT INTO public.children (appointment_id, name, photo_allowed)
SELECT a.id, c.name, false
FROM public.appointments a
CROSS JOIN LATERAL (
    VALUES
        (a.child1),
        (a.child2),
        (a.child3),
        (a.child4)
) AS c(name)
WHERE c.name IS NOT NULL
  AND btrim(c.name) <> ''
  AND NOT EXISTS (
      SELECT 1 FROM public.children ch
      WHERE ch.appointment_id = a.id
  );

-- ---------------------------------------------------------------------------
-- OPTIONEEL: de oude kinderkolommen verwijderen uit appointments nadat u de
-- migratie hebt gecontroleerd. Uncomment de volgende regels wanneer klaar.
-- ---------------------------------------------------------------------------
-- ALTER TABLE public.appointments DROP COLUMN IF EXISTS child1;
-- ALTER TABLE public.appointments DROP COLUMN IF EXISTS child2;
-- ALTER TABLE public.appointments DROP COLUMN IF EXISTS child3;
-- ALTER TABLE public.appointments DROP COLUMN IF EXISTS child4;
