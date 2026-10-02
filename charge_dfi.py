# -*- coding: utf-8 -*-
"""
HISTO — Chargement initial des DFI (DGFiP) dans Neon.
À lancer sur le poste de travail, pas sur Vercel (volume France entière).

Usage :   python charge_dfi.py  <fichier_csv_ou_csv.gz>  <identifiant_du_lot>
Exemple : python charge_dfi.py dfi_national.csv.gz 2026-T3

La chaîne de connexion Neon est demandée au clavier (saisie masquée),
ou lue dans la variable d'environnement HISTO_DATABASE_URL si elle existe.

Prérequis (une seule fois) :  pip install "psycopg[binary]"
"""

import csv
import gzip
import io
import os
import sys
import getpass
from datetime import datetime

import psycopg

# ------------------------------------------------------------------
# TABLE DE CORRESPONDANCE DES COLONNES — À AJUSTER AU VU DU FICHIER
# Clé = nom logique utilisé par le script ; valeur = nom de colonne
# dans l'agrégation nationale data.gouv.fr. On vérifie une fois,
# on corrige ici, et rien d'autre ne bouge.
# ------------------------------------------------------------------
COLONNES = {
    "dep":          "code_departement",
    "com":          "code_commune",
    "id_dfi":       "identifiant_dfi",
    "nature":       "nature_document",
    "date_effet":   "date_application",     # formats acceptés : AAAA-MM-JJ, JJ/MM/AAAA, AAAAMMJJ
    "type":         "type_parcelle",        # 1 = mère, 2 = fille
    "prefixe":      "prefixe_section",
    "section":      "section",
    "numero":       "numero_plan",
    "contenance":   "contenance",           # optionnelle : mettre None si absente
}

SEPARATEUR = ";"
ENCODAGE = "utf-8"          # passer à "latin-1" si le fichier le demande
TAILLE_LOT = 50_000         # lignes par envoi COPY

# ------------------------------------------------------------------


def connexion():
    url = os.environ.get("HISTO_DATABASE_URL")
    if not url:
        url = getpass.getpass("Chaîne de connexion Neon (saisie masquée) : ").strip()
    return psycopg.connect(url, autocommit=False)


def ouvrir(chemin):
    if chemin.lower().endswith(".gz"):
        return io.TextIOWrapper(gzip.open(chemin, "rb"), encoding=ENCODAGE, newline="")
    return open(chemin, "r", encoding=ENCODAGE, newline="")


def norm_dep(v):
    v = (v or "").strip().upper()
    return v.zfill(2) if v.isdigit() and len(v) < 2 else v


def norm_com(v):
    return (v or "").strip().zfill(3)


def norm_prefixe(v):
    v = (v or "").strip()
    return v.zfill(3) if v else "000"


def norm_section(v):
    return (v or "").strip().upper().lstrip("0") or "0"


def norm_numero(v):
    return (v or "").strip().zfill(4)


def norm_date(v):
    v = (v or "").strip()
    if not v:
        return None
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%Y%m%d"):
        try:
            return datetime.strptime(v, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def norm_int(v):
    v = (v or "").strip()
    return int(v) if v.isdigit() else None


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)

    chemin, lot = sys.argv[1], sys.argv[2]
    if not os.path.exists(chemin):
        print(f"Fichier introuvable : {chemin}")
        sys.exit(1)

    cx = connexion()
    cur = cx.cursor()

    # Journal : ouverture du chargement
    cur.execute(
        "INSERT INTO histo_chargement (lot_source) VALUES (%s) RETURNING id",
        (lot,),
    )
    chargement_id = cur.fetchone()[0]
    cx.commit()

    # Tables de travail (vidées à chaque passage, remplies par COPY)
    cur.execute("DROP TABLE IF EXISTS tmp_dfi_brut")
    cur.execute("""
        CREATE TEMP TABLE tmp_dfi_brut (
            dep TEXT, com TEXT, id_dfi TEXT, nature SMALLINT, date_effet DATE,
            type_parcelle SMALLINT, prefixe TEXT, section TEXT, numero TEXT,
            contenance INTEGER
        )
    """)

    print(f"Lecture de {chemin} …")
    nb = 0
    with ouvrir(chemin) as f:
        lecteur = csv.DictReader(f, delimiter=SEPARATEUR)
        manquantes = [c for c in COLONNES.values() if c and c not in lecteur.fieldnames]
        if manquantes:
            print("Colonnes absentes du fichier :", ", ".join(manquantes))
            print("Colonnes trouvées :", ", ".join(lecteur.fieldnames))
            print("→ Corriger la table COLONNES en tête de script.")
            cur.execute(
                "UPDATE histo_chargement SET statut='echec', fin=now(), message=%s WHERE id=%s",
                ("colonnes absentes : " + ", ".join(manquantes), chargement_id),
            )
            cx.commit()
            sys.exit(2)

        tampon = []

        def vider():
            nonlocal tampon
            if not tampon:
                return
            with cur.copy(
                "COPY tmp_dfi_brut (dep, com, id_dfi, nature, date_effet, type_parcelle, "
                "prefixe, section, numero, contenance) FROM STDIN"
            ) as copie:
                for ligne in tampon:
                    copie.write_row(ligne)
            tampon = []

        for r in lecteur:
            tampon.append((
                norm_dep(r[COLONNES["dep"]]),
                norm_com(r[COLONNES["com"]]),
                (r[COLONNES["id_dfi"]] or "").strip(),
                norm_int(r[COLONNES["nature"]]),
                norm_date(r[COLONNES["date_effet"]]),
                norm_int(r[COLONNES["type"]]),
                norm_prefixe(r[COLONNES["prefixe"]]),
                norm_section(r[COLONNES["section"]]),
                norm_numero(r[COLONNES["numero"]]),
                norm_int(r[COLONNES["contenance"]]) if COLONNES["contenance"] else None,
            ))
            nb += 1
            if len(tampon) >= TAILLE_LOT:
                vider()
                print(f"  {nb:,} lignes lues".replace(",", " "), end="\r")
        vider()
    print(f"\n{nb:,} lignes chargées en table de travail.".replace(",", " "))

    # Purge de l'ancien lot éventuel portant le même identifiant (rejouabilité)
    cur.execute("DELETE FROM histo_document WHERE lot_source = %s", (lot,))

    # Documents (dédoublonnés sur dep/com/id_dfi)
    print("Insertion des documents …")
    cur.execute("""
        INSERT INTO histo_document (dep, com, id_dfi, nature, date_effet, lot_source)
        SELECT dep, com, id_dfi,
               MAX(nature), MAX(date_effet), %s
        FROM tmp_dfi_brut
        WHERE id_dfi <> ''
        GROUP BY dep, com, id_dfi
        ON CONFLICT (dep, com, id_dfi) DO UPDATE
            SET nature = EXCLUDED.nature,
                date_effet = EXCLUDED.date_effet,
                lot_source = EXCLUDED.lot_source
    """, (lot,))
    nb_docs = cur.rowcount

    # Mouvements
    print("Insertion des mouvements …")
    cur.execute("""
        INSERT INTO histo_mouvement
            (document_id, type_parcelle, dep, com, prefixe, section, numero, contenance_m2, lot_source)
        SELECT d.id, b.type_parcelle, b.dep, b.com, b.prefixe, b.section, b.numero, b.contenance, %s
        FROM tmp_dfi_brut b
        JOIN histo_document d ON d.dep = b.dep AND d.com = b.com AND d.id_dfi = b.id_dfi
        WHERE b.type_parcelle IN (1, 2)
    """, (lot,))
    nb_mvts = cur.rowcount

    cur.execute("""
        UPDATE histo_chargement
        SET fin = now(), statut = 'termine', nb_documents = %s, nb_mouvements = %s
        WHERE id = %s
    """, (nb_docs, nb_mvts, chargement_id))
    cx.commit()

    print(f"Terminé : {nb_docs:,} documents, {nb_mvts:,} mouvements (lot {lot}).".replace(",", " "))
    cur.close()
    cx.close()


if __name__ == "__main__":
    main()
