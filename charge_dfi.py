# -*- coding: utf-8 -*-
"""
HISTO — Découpage des DFI (DGFiP, source officielle data.gouv.fr) en UN FICHIER PAR COMMUNE,
à écrire dans le dossier « HISTO » du Google Drive du cabinet (dossier synchronisé sur le poste).

Format source (descriptifs DGFiP 2023 et janvier 2025) : fichiers .txt, séparateur « ; », champs fixes :
  dep(3) ; com(3) ; prefixe(3) ; id_dfi(7) ; nature(1) ; date AAAAMMJJ(8) ; géomètre(30) ;
  [numéro du géomètre(5) — depuis janvier 2025] ; lot(5) ; type(1 = mères, 2 = filles) ;
  puis jusqu'à 175 cellules de 6 caractères : section(2) + numéro de plan(4), ex. AC0026.
Chaque situation trimestrielle = DEUX archives ZIP (coupure variable entre les deux).
Le script reconnaît la disposition LIGNE PAR LIGNE (lot à 5 chiffres suivi du type 1/2).

Usage :   python charge_dfi.py  <situation>  <dossier_de_sortie>  <zip_ou_txt_1>  [<zip_ou_txt_2> ...]  [--dep=59,62]
Exemple : python charge_dfi.py 2026-07 "G:\\Mon Drive\\HISTO" "archive1.zip" "archive2.zip"

Sortie : <dossier>/<dep>/HISTO_<dep><com>.json  (ex. HISTO/59/HISTO_59350.json)
         <dossier>/HISTO_situation.json          (situation, date, compteurs)
Les fichiers d'une commune sont RÉÉCRITS à chaque passage (mise à jour trimestrielle = relancer).
"""

import io
import os
import sys
import json
import zipfile
from datetime import datetime, date

# ------------------------------------------------------------------
COL_DEP, COL_COM, COL_PREFIXE, COL_ID, COL_NATURE, COL_DATE, COL_GEOMETRE = range(7)
ENCODAGE = "latin-1"          # fichiers DGFiP ; passer à "utf-8" si besoin
PREFIXE_FICHIER = "HISTO_"    # nom des fichiers de communes : HISTO_<dep><com>.json
# ------------------------------------------------------------------


def norm_dep(v):
    """DGFiP code sur 3 caractères (023, 2A0, 971) → code INSEE (23, 2A, 971)."""
    v = (v or "").strip().upper()
    if len(v) == 3 and v[0] == "0":
        return v[1:]
    if len(v) == 3 and v[:2] in ("2A", "2B"):
        return v[:2]
    return v


def norm_date(v):
    v = (v or "").strip()
    try:
        return datetime.strptime(v, "%Y%m%d").date().isoformat()
    except ValueError:
        return None


def position_lot(champs):
    """Repère la colonne du lot d'analyse (5 chiffres) immédiatement suivie du type (1 ou 2)."""
    for i in (7, 8):
        if len(champs) > i + 1 and champs[i].strip().isdigit() and len(champs[i].strip()) == 5 \
           and champs[i + 1].strip() in ("1", "2"):
            return i
    return None


def cellules(champs, premiere):
    """Identifiants de parcelles (6 caractères : section sur 2, numéro sur 4), tels quels."""
    out = []
    for c in champs[premiere:]:
        c = c.rstrip()                      # on garde l'espace de tête d'une section à une lettre (« A0007 »)
        if len(c) >= 6:
            out.append(c[:6])
    return out


def fichiers_texte(chemins):
    for chemin in chemins:
        if chemin.lower().endswith(".zip"):
            with zipfile.ZipFile(chemin) as z:
                for nom in z.namelist():
                    if nom.lower().endswith(".txt"):
                        with z.open(nom) as f:
                            yield nom, io.TextIOWrapper(f, encoding=ENCODAGE, newline="")
        else:
            with open(chemin, "r", encoding=ENCODAGE, newline="") as f:
                yield os.path.basename(chemin), f


class Ecrivain:
    """Accumule une commune à la fois (les fichiers DGFiP sont triés), écrit à chaque changement."""

    def __init__(self, dossier, situation):
        self.dossier, self.situation = dossier, situation
        self.cle = None            # (dep, com) en cours
        self.docs = {}             # id_dfi → document
        self.nb_communes = self.nb_docs = self.nb_parcelles = 0

    def ajouter(self, dep, com, prefixe, id_dfi, nature, date_effet, lot, type_p, parcelles):
        if (dep, com) != self.cle:
            self.vider()
            self.cle = (dep, com)
        d = self.docs.get(id_dfi)
        if d is None:
            d = self.docs[id_dfi] = {"id": id_dfi, "nat": nature, "date": date_effet, "lots": {}}
            self.nb_docs += 1
        if nature is not None and d["nat"] is None:
            d["nat"] = nature
        if date_effet and (d["date"] is None or date_effet > d["date"]):
            d["date"] = date_effet
        l = d["lots"].get(lot)
        if l is None:
            l = d["lots"][lot] = {"lot": lot, "pre": prefixe, "m": [], "f": []}
        l["m" if type_p == 1 else "f"].extend(parcelles)
        self.nb_parcelles += len(parcelles)

    def vider(self):
        if self.cle is None or not self.docs:
            self.docs = {}
            return
        dep, com = self.cle
        sous = os.path.join(self.dossier, dep)
        os.makedirs(sous, exist_ok=True)
        contenu = {
            "dep": dep, "com": com, "situation": self.situation,
            "docs": [{**d, "lots": list(d["lots"].values())} for d in self.docs.values()],
        }
        with open(os.path.join(sous, f"{PREFIXE_FICHIER}{dep}{com}.json"), "w", encoding="utf-8") as f:
            json.dump(contenu, f, ensure_ascii=False, separators=(",", ":"))
        self.nb_communes += 1
        self.docs = {}


def main():
    args = sys.argv[1:]
    deps_voulus = None
    for a in list(args):
        if a.startswith("--dep="):
            deps_voulus = {norm_dep(x.strip().zfill(3) if x.strip().isdigit() and len(x.strip()) <= 2 else x.strip())
                           for x in a[6:].split(",") if x.strip()}
            args.remove(a)
    if len(args) < 3:
        print(__doc__)
        sys.exit(1)

    situation, dossier, chemins = args[0], args[1], args[2:]
    for c in chemins:
        if not os.path.exists(c):
            print(f"Fichier introuvable : {c}")
            sys.exit(1)
    os.makedirs(dossier, exist_ok=True)
    if deps_voulus:
        print("Départements retenus :", ", ".join(sorted(deps_voulus)))

    ecrivain = Ecrivain(dossier, situation)
    nb_lignes = 0
    for nom, flux in fichiers_texte(chemins):
        print(f"Lecture de {nom} …")
        for brute in flux:
            champs = brute.rstrip("\r\n").split(";")
            pos = position_lot(champs)
            if pos is None:
                continue
            dep = norm_dep(champs[COL_DEP])
            if deps_voulus and dep not in deps_voulus:
                continue
            ecrivain.ajouter(
                dep,
                champs[COL_COM].strip().zfill(3),
                champs[COL_PREFIXE].strip().zfill(3) or "000",
                champs[COL_ID].strip(),
                int(champs[COL_NATURE]) if champs[COL_NATURE].strip().isdigit() else None,
                norm_date(champs[COL_DATE]),
                champs[pos].strip().zfill(5),
                int(champs[pos + 1]),
                cellules(champs, pos + 2),
            )
            nb_lignes += 1
            if nb_lignes % 200_000 == 0:
                print(f"  {nb_lignes:,} lignes, {ecrivain.nb_communes:,} communes écrites".replace(",", " ").replace("lignes ", "lignes, "), end="\r")
        ecrivain.vider()
        ecrivain.cle = None
        print()

    with open(os.path.join(dossier, f"{PREFIXE_FICHIER}situation.json"), "w", encoding="utf-8") as f:
        json.dump({
            "situation": situation, "genere_le": date.today().isoformat(),
            "communes": ecrivain.nb_communes, "documents": ecrivain.nb_docs, "parcelles": ecrivain.nb_parcelles,
            "departements": sorted(deps_voulus) if deps_voulus else "France entière",
        }, f, ensure_ascii=False, indent=1)

    fmt = lambda n: f"{n:,}".replace(",", " ")
    print(f"Terminé : {fmt(ecrivain.nb_communes)} communes, {fmt(ecrivain.nb_docs)} documents, "
          f"{fmt(ecrivain.nb_parcelles)} parcelles (situation {situation}).")


if __name__ == "__main__":
    main()
