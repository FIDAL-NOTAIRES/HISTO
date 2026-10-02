// ============================================================
// HISTO — fonction serverless unique à actions (plan Vercel Hobby :
// douze fonctions maximum, on regroupe).
//
//   POST /api/histo  { action: "filiation", references: [ {dep, com, prefixe, section, numero} ] }
//   POST /api/histo  { action: "etat" }
//
// Dépendance : @neondatabase/serverless  (variable d'env DATABASE_URL)
// ============================================================

import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);

// ---------- paramètres métier (décisions des 01/10/2026) ----------
const SEUIL_30_ANS = 30;              // repère visuel, pas une coupure
const TOLERANCE_SURFACE_PCT = 2;      // écart signalé au-delà de 2 %
const PLANCHER_SURFACE_M2 = 4;        // … et au-delà de 4 m² d'écart
const PROFONDEUR_MAX = 60;            // garde-fou contre les boucles

const LIBELLES_NATURE = {
  1: "document d'arpentage",
  2: "croquis de conservation",
  4: "remaniement",
  5: "document d'arpentage numérique",
  6: "lotissement numérique",
  7: "lotissement",
  8: "rénovation",
};

// ---------- normalisation d'une référence ----------
function normaliser(ref) {
  const dep = String(ref.dep ?? "").trim().toUpperCase().padStart(2, "0");
  const com = String(ref.com ?? "").trim().padStart(3, "0");
  const prefixe = String(ref.prefixe ?? "").trim().padStart(3, "0") || "000";
  const section = String(ref.section ?? "").trim().toUpperCase().replace(/^0+/, "") || "0";
  const numero = String(ref.numero ?? "").trim().padStart(4, "0");
  return { dep, com, prefixe, section, numero };
}

function cle(p) {
  return `${p.dep}-${p.com}-${p.prefixe}-${p.section}-${p.numero}`;
}

function libelle(p) {
  const pre = p.prefixe && p.prefixe !== "000" ? `${p.prefixe} ` : "";
  return `${pre}${p.section} ${String(p.numero).replace(/^0+/, "")}`;
}

// ---------- accès base ----------
// Tous les documents où la parcelle apparaît comme FILLE (type 2) :
// ce sont les opérations qui l'ont fait naître.
async function documentsOuNait(p) {
  return sql`
    SELECT DISTINCT document_id, id_dfi, nature, date_effet, annee
    FROM histo_filiation
    WHERE dep = ${p.dep} AND com = ${p.com} AND prefixe = ${p.prefixe}
      AND section = ${p.section} AND numero = ${p.numero}
      AND type_parcelle = 2
    ORDER BY date_effet DESC NULLS LAST
  `;
}

// Toutes les parcelles d'un document, mères et filles, avec contenance.
async function parcellesDuDocument(documentId) {
  return sql`
    SELECT dep, com, prefixe, section, numero, type_parcelle, contenance_m2
    FROM histo_filiation
    WHERE document_id = ${documentId}
    ORDER BY type_parcelle, section, numero
  `;
}

// ---------- contrôle de cohérence des surfaces ----------
function ecartSurfaces(meres, filles) {
  const somme = (liste) =>
    liste.every((x) => x.contenance_m2 != null)
      ? liste.reduce((t, x) => t + x.contenance_m2, 0)
      : null;
  const sMeres = somme(meres);
  const sFilles = somme(filles);
  if (sMeres == null || sFilles == null || sMeres === 0) {
    return { verifiable: false };
  }
  const ecart = Math.abs(sMeres - sFilles);
  const pct = (ecart / sMeres) * 100;
  const signale = pct > TOLERANCE_SURFACE_PCT && ecart > PLANCHER_SURFACE_M2;
  return {
    verifiable: true,
    somme_meres_m2: sMeres,
    somme_filles_m2: sFilles,
    ecart_m2: ecart,
    ecart_pct: Math.round(pct * 100) / 100,
    signale,            // alerte JAUNE si vrai
  };
}

// ---------- remontée de la généalogie (du présent vers le passé) ----------
async function filiation(refBrute) {
  const racine = normaliser(refBrute);
  const anneeCourante = new Date().getFullYear();
  const maillons = [];
  const vus = new Set();
  let alerteJaune = false;

  // file d'attente : parcelles dont on cherche l'origine
  const aTraiter = [{ ...racine, profondeur: 0 }];

  while (aTraiter.length) {
    const p = aTraiter.shift();
    const k = cle(p);
    if (vus.has(k) || p.profondeur > PROFONDEUR_MAX) continue;
    vus.add(k);

    const docs = await documentsOuNait(p);
    for (const d of docs) {
      const parcelles = await parcellesDuDocument(d.document_id);
      const meres = parcelles.filter((x) => x.type_parcelle === 1);
      const filles = parcelles.filter((x) => x.type_parcelle === 2);
      const soeurs = filles.filter((x) => cle(x) !== k); // décision : on affiche les sœurs
      const surfaces = ecartSurfaces(meres, filles);
      if (surfaces.signale) alerteJaune = true;

      const age = d.annee != null ? anneeCourante - d.annee : null;

      maillons.push({
        parcelle: { ...p, libelle: libelle(p),
                    contenance_m2: filles.find((x) => cle(x) === k)?.contenance_m2 ?? null },
        document: {
          id_dfi: d.id_dfi,
          nature: d.nature,
          nature_libelle: LIBELLES_NATURE[d.nature] ?? "nature inconnue",
          date_effet: d.date_effet,
          annee: d.annee,
          au_dela_30_ans: age != null && age > SEUIL_30_ANS,
        },
        operation:
          meres.length > 1 && filles.length === 1 ? "réunion"
          : meres.length === 1 && filles.length > 1 ? "division"
          : meres.length > 1 && filles.length > 1 ? "remaniement parcellaire"
          : "renumérotation",
        parcelles_origine: meres.map((m) => ({ ...m, libelle: libelle(m) })),   // en colonne
        parcelles_soeurs: soeurs.map((s) => ({ ...s, libelle: libelle(s) })),
        surfaces,
        profondeur: p.profondeur,
      });

      for (const m of meres) {
        aTraiter.push({ dep: m.dep, com: m.com, prefixe: m.prefixe,
                        section: m.section, numero: m.numero, profondeur: p.profondeur + 1 });
      }
    }
  }

  // Tri : du présent vers le passé (date décroissante), puis par profondeur
  maillons.sort((a, b) => {
    const da = a.document.date_effet ?? "", db = b.document.date_effet ?? "";
    if (da !== db) return da < db ? 1 : -1;
    return a.profondeur - b.profondeur;
  });

  const trouve = maillons.length > 0;
  const plusAncien = trouve
    ? maillons.reduce((min, m) => (m.document.annee != null && (min == null || m.document.annee < min)) ? m.document.annee : min, null)
    : null;

  return {
    reference: { ...racine, libelle: libelle(racine) },
    trouve,
    // décision : aucune filiation trouvée → message + renvoi à l'état hypothécaire
    message: trouve
      ? null
      : "Aucune filiation trouvée dans le DFI pour cette référence (remembrement, mouvement antérieur à l'informatisation, ou parcelle d'origine). Recherches à poursuivre via l'état hypothécaire.",
    plus_ancien_mouvement: plusAncien,
    franchit_30_ans: plusAncien != null && (anneeCourante - plusAncien) > SEUIL_30_ANS,
    alerte: trouve ? (alerteJaune ? "jaune" : "vert") : "jaune",
    maillons,
  };
}

// ---------- état de la base ----------
async function etat() {
  const [dernier] = await sql`
    SELECT lot_source, horodatage_src, debut, fin, statut, nb_documents, nb_mouvements
    FROM histo_chargement ORDER BY debut DESC LIMIT 1
  `;
  const [compte] = await sql`SELECT COUNT(*)::bigint AS n FROM histo_mouvement`;
  return { dernier_chargement: dernier ?? null, mouvements_en_base: Number(compte?.n ?? 0) };
}

// ---------- point d'entrée ----------
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ erreur: "POST attendu" });

  try {
    const corps = typeof req.body === "string" ? JSON.parse(req.body) : (req.body ?? {});
    const { action } = corps;

    if (action === "etat") {
      return res.status(200).json(await etat());
    }

    if (action === "filiation") {
      const refs = Array.isArray(corps.references) ? corps.references : [];
      if (!refs.length) return res.status(400).json({ erreur: "references[] attendu" });
      if (refs.length > 500) return res.status(400).json({ erreur: "500 références maximum par appel" });
      const resultats = [];
      for (const r of refs) resultats.push(await filiation(r));
      return res.status(200).json({
        genere_le: new Date().toISOString(),
        nb_references: resultats.length,
        resultats,
      });
    }

    return res.status(400).json({ erreur: `action inconnue : ${action}` });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erreur: "erreur interne", detail: String(e?.message ?? e) });
  }
}
