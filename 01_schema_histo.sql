-- ============================================================
-- HISTO — Généalogie cadastrale sur les DFI (DGFiP, open data)
-- Schéma Neon — à exécuter dans le SQL Editor du projet
-- neon-fuchsia-pillow, EN TANT QUE PROPRIÉTAIRE (pas matrice_owner)
-- ============================================================

-- 0. Piège connu : sans ce GRANT, le rôle applicatif échoue en
--    « permission denied for schema public » dès la première table.
GRANT USAGE, CREATE ON SCHEMA public TO "matrice_owner";

-- 1. Journal des chargements (un enregistrement par lot source)
CREATE TABLE IF NOT EXISTS histo_chargement (
    id              BIGSERIAL PRIMARY KEY,
    lot_source      TEXT        NOT NULL,          -- identifiant unique du lot data.gouv.fr
    horodatage_src  TIMESTAMPTZ,                   -- date de mise à jour annoncée par la source
    debut           TIMESTAMPTZ NOT NULL DEFAULT now(),
    fin             TIMESTAMPTZ,
    nb_documents    BIGINT,
    nb_mouvements   BIGINT,
    statut          TEXT        NOT NULL DEFAULT 'en cours',  -- en cours | termine | echec
    message         TEXT
);

-- 2. Les documents de filiation (un par identifiant DFI)
--    Natures DGFiP : 1 document d'arpentage, 2 croquis de conservation,
--    4 remaniement, 5 document d'arpentage numérique,
--    6 lotissement numérique, 7 lotissement, 8 rénovation
CREATE TABLE IF NOT EXISTS histo_document (
    id              BIGSERIAL PRIMARY KEY,
    dep             CHAR(3)     NOT NULL,          -- code département (2A, 2B, 971…)
    com             CHAR(3)     NOT NULL,          -- code commune (3 caractères)
    id_dfi          TEXT        NOT NULL,          -- identifiant du document de filiation
    nature          SMALLINT,                      -- code nature (1,2,4,5,6,7,8)
    date_effet      DATE,                          -- date d'application du document
    lot_source      TEXT        NOT NULL,
    CONSTRAINT histo_document_unique UNIQUE (dep, com, id_dfi)
);

-- 3. Les mouvements : une ligne par parcelle impliquée dans un document
--    type_parcelle : 1 = parcelle mère (disparaît), 2 = parcelle fille (naît)
CREATE TABLE IF NOT EXISTS histo_mouvement (
    id              BIGSERIAL PRIMARY KEY,
    document_id     BIGINT      NOT NULL REFERENCES histo_document(id) ON DELETE CASCADE,
    type_parcelle   SMALLINT    NOT NULL CHECK (type_parcelle IN (1, 2)),
    dep             CHAR(3)     NOT NULL,
    com             CHAR(3)     NOT NULL,
    prefixe         CHAR(3)     NOT NULL DEFAULT '000',
    section         VARCHAR(2)  NOT NULL,
    numero          CHAR(4)     NOT NULL,          -- numéro de plan sur 4 caractères, zéros devant
    contenance_m2   INTEGER,                       -- si portée par la source, sinon NULL
    lot_source      TEXT        NOT NULL
);

-- 4. Index : la clé d'interrogation est TOUJOURS la référence cadastrale
CREATE INDEX IF NOT EXISTS histo_mvt_ref_idx
    ON histo_mouvement (dep, com, prefixe, section, numero);

CREATE INDEX IF NOT EXISTS histo_mvt_doc_idx
    ON histo_mouvement (document_id);

CREATE INDEX IF NOT EXISTS histo_doc_date_idx
    ON histo_document (date_effet);

-- 5. Vue de commodité : chaque mouvement avec sa nature et sa date
CREATE OR REPLACE VIEW histo_filiation AS
SELECT
    m.id,
    m.dep, m.com, m.prefixe, m.section, m.numero,
    m.type_parcelle,
    m.contenance_m2,
    d.id_dfi,
    d.nature,
    CASE d.nature
        WHEN 1 THEN 'document d''arpentage'
        WHEN 2 THEN 'croquis de conservation'
        WHEN 4 THEN 'remaniement'
        WHEN 5 THEN 'document d''arpentage numérique'
        WHEN 6 THEN 'lotissement numérique'
        WHEN 7 THEN 'lotissement'
        WHEN 8 THEN 'rénovation'
        ELSE 'nature inconnue'
    END AS nature_libelle,
    d.date_effet,
    EXTRACT(YEAR FROM d.date_effet)::INT AS annee,
    d.id AS document_id
FROM histo_mouvement m
JOIN histo_document d ON d.id = m.document_id;

-- 6. Droits pour le rôle applicatif partagé de la suite
GRANT SELECT, INSERT, UPDATE, DELETE ON histo_chargement, histo_document, histo_mouvement TO "matrice_owner";
GRANT SELECT ON histo_filiation TO "matrice_owner";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "matrice_owner";
