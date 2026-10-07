// ============================================================
// HISTO — point d'entrée des applications appelantes (FUSION, MARTEAU)
// Arbitrages du 06/10/2026 (session vocale) et du 07/10/2026 (voie serveur) :
//   - l'appel renvoie QUE L'ARBRE GÉNÉALOGIQUE, maillons bruts, AUCUNE phrase rédigée ;
//   - arbre COMPLET, remonté jusqu'au plus ancien mouvement connu du DFI ;
//   - chaque maillon porte sa NATURE en clair, qualifiée par HISTO seul
//     à partir du code de nature du document du DFI ;
//   - HISTO ne porte JAMAIS les références de publicité foncière (le DFI ne
//     les contient pas) : l'appelant les ajoute en recoupant l'état hypothécaire ;
//   - le « depuis la dernière mutation » est un calcul de l'appelant.
//
// Le moteur tourne ICI, côté serveur : le navigateur de l'appelant n'envoie
// qu'une demande et ne reçoit qu'un résultat (premier pas de la sécurisation).
//
//   POST /api/filiation
//     En-tête  Authorization: Bearer <jeton Google du collaborateur>
//              (celui de la connexion du matin, FidalAcces.jeton())
//     Corps    { "appelant": "fusion" | "marteau",
//                "references": [ { "dep": "59", "com": "163", "prefixe": "000",
//                                  "section": "AH", "numero": "646",
//                                  "groupe": "12", "identifiant": "…" } ] }
//              — « insee » (5 caractères) accepté à la place de dep + com ;
//              — « groupe » et « identifiant » sont renvoyés tels quels
//                (HISTO respecte la numérotation de l'appelant).
//   GET  /api/filiation          → version du contrat (+ situation DFI si jeton)
//
// Variables d'environnement (facultatives) :
//   HISTO_ORIGINES   origines autorisées, séparées par des virgules
//                    (par défaut : HISTO et FUSION ; ajouter celle de MARTEAU)
// ============================================================

const VERSION_CONTRAT = "1.0";
const PREFIXE_FICHIER = "HISTO_";
const SEUIL_30_ANS = 30;
const PROFONDEUR_MAX = 60;            // garde-fou contre les boucles
const MAX_REFERENCES = 300;           // par appel
const CADASTRE_PT = "https://apicarto.ign.fr/api/cadastre/parcelle";
const DRIVE = "https://www.googleapis.com/drive/v3/files";

const ORIGINES_PAR_DEFAUT = [
  "https://histo-sand.vercel.app",
  "https://fusion-three-kappa.vercel.app",
];

const LIBELLES_DOCUMENT = {
  1: "document d'arpentage", 2: "croquis de conservation", 4: "remaniement",
  5: "document d'arpentage numérique", 6: "lotissement numérique", 7: "lotissement", 8: "rénovation",
};

// ---------- mémoire de l'instance (tant que la fonction reste chaude) ----------
const cacheCommunes = new Map();      // nom de fichier → { situation, index } (promesse)
const cacheIdsDrive = new Map();      // nom de fichier → identifiant Drive
let cacheSituation = null;            // { valeur, date }

// ============================================================
//   RÉFÉRENCES
// ============================================================
function normRef(ref) {
  let dep = ref.dep, com = ref.com;
  if ((!dep || !com) && ref.insee) {
    const i = String(ref.insee).trim().toUpperCase();
    if (/^97/.test(i)) { dep = i.slice(0, 3); com = i.slice(3); }
    else { dep = i.slice(0, 2); com = i.slice(2); }
  }
  return {
    dep: String(dep ?? "").trim().toUpperCase().padStart(2, "0"),
    com: String(com ?? "").trim().padStart(3, "0"),
    prefixe: String(ref.prefixe ?? "").trim().padStart(3, "0") || "000",
    section: String(ref.section ?? "").trim().toUpperCase().replace(/^0+/, "") || "0",
    numero: String(ref.numero ?? "").trim().padStart(4, "0"),
  };
}
const cleRef = p => `${p.dep}-${p.com}-${p.prefixe}-${p.section}-${String(p.numero).padStart(4, "0")}`;
const libRef = p => `${p.prefixe && p.prefixe !== "000" ? p.prefixe + " " : ""}${p.section} ${String(p.numero).replace(/^0+/, "")}`;
const inseeDe = p => p.dep.length === 3 ? p.dep + p.com.slice(1) : p.dep + p.com;
function cellule(c, dep, com, prefixe) {          // "AC0026" ou " A0007" → référence
  return { dep, com, prefixe, section: c.slice(0, 2).trim().replace(/^0+/, "") || "0", numero: c.slice(2, 6).trim().padStart(4, "0") };
}
// Forme publique d'une parcelle dans la réponse
const parcelle = (p, extra = {}) => ({
  insee: inseeDe(p), dep: p.dep, com: p.com, prefixe: p.prefixe, section: p.section,
  numero: String(p.numero).replace(/^0+/, "") || "0", libelle: libRef(p), ...extra,
});
const dateIso = d => d && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null;

// ============================================================
//   NATURE DU MOUVEMENT — qualifiée par HISTO seul (06/10/2026)
//   Le code de nature du document prime quand il dit l'opération
//   (remaniement, rénovation, lotissement) ; pour les documents
//   d'arpentage et croquis, la forme du lot (nombre de mères et de
//   filles) dit s'il s'agit d'une division, d'une réunion, ou des deux.
// ============================================================
function natureMouvement(codeNature, nbMeres, nbFilles) {
  if (codeNature === 4) return "remaniement";
  if (codeNature === 8) return "rénovation";
  if (codeNature === 6 || codeNature === 7) return "lotissement";
  if (nbMeres === 0) return "extraction du domaine non cadastré";
  if (nbMeres === 1 && nbFilles > 1) return "division";
  if (nbMeres > 1 && nbFilles === 1) return "réunion";
  if (nbMeres > 1 && nbFilles > 1) return "réunion et division";
  return "renumérotation";
}

// ============================================================
//   ACCÈS AUX DONNÉES
// ============================================================
class ErreurHisto extends Error { constructor(statut, code, message) { super(message); this.statut = statut; this.code = code; } }

async function chercherIdDrive(nom, jeton) {
  if (cacheIdsDrive.has(nom)) return cacheIdsDrive.get(nom);
  const q = `name = '${nom}' and trashed = false`;
  const rep = await fetch(`${DRIVE}?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1&corpora=allDrives&supportsAllDrives=true&includeItemsFromAllDrives=true`,
    { headers: { Authorization: `Bearer ${jeton}` } });
  if (rep.status === 401) throw new ErreurHisto(401, "jeton-refuse", "Jeton Google refusé ou expiré : refaire la connexion du matin.");
  if (!rep.ok) throw new ErreurHisto(502, "drive", `Drive : recherche de ${nom} en échec (${rep.status}).`);
  const id = (await rep.json()).files?.[0]?.id || null;
  if (id) cacheIdsDrive.set(nom, id);
  return id;
}
async function lireJsonDrive(nom, jeton) {          // l'objet, ou null si le fichier n'existe pas
  let id = await chercherIdDrive(nom, jeton);
  if (!id) return null;
  let rep = await fetch(`${DRIVE}/${id}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${jeton}` } });
  if (rep.status === 404) {                         // fichier remplacé par un réimport trimestriel
    cacheIdsDrive.delete(nom);
    id = await chercherIdDrive(nom, jeton); if (!id) return null;
    rep = await fetch(`${DRIVE}/${id}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${jeton}` } });
  }
  if (rep.status === 401) throw new ErreurHisto(401, "jeton-refuse", "Jeton Google refusé ou expiré : refaire la connexion du matin.");
  if (rep.status === 403) throw new ErreurHisto(403, "drive-acces", `Drive : lecture de ${nom} refusée à ce compte.`);
  if (!rep.ok) throw new ErreurHisto(502, "drive", `Drive : lecture de ${nom} en échec (${rep.status}).`);
  return rep.json();
}
async function situationDfi(jeton) {
  // relue toutes les dix minutes au plus : un réimport trimestriel invalide les communes en mémoire
  if (cacheSituation && Date.now() - cacheSituation.date < 600e3) return cacheSituation.valeur;
  const s = await lireJsonDrive(`${PREFIXE_FICHIER}situation.json`, jeton);
  const valeur = s?.situation || null;
  if (cacheSituation && cacheSituation.valeur !== valeur) { cacheCommunes.clear(); cacheIdsDrive.clear(); }
  cacheSituation = { valeur, date: Date.now() };
  return valeur;
}

function indexCommune(dep, com, jeton) {
  const nom = `${PREFIXE_FICHIER}${dep}${com}.json`;
  if (!cacheCommunes.has(nom)) {
    const pr = construireIndex(nom, dep, com, jeton);
    cacheCommunes.set(nom, pr);
    pr.catch(() => cacheCommunes.delete(nom));
  }
  return cacheCommunes.get(nom);
}
async function construireIndex(nom, dep, com, jeton) {
  const fichier = await lireJsonDrive(nom, jeton);
  if (!fichier) return null;
  const parFille = new Map(), parMere = new Map(), sansPrefixe = new Map();
  const noter = (r, role) => { const k = `${r.section}-${r.numero}`;
    if (!sansPrefixe.has(k)) sansPrefixe.set(k, new Map());
    const m = sansPrefixe.get(k); m.set(r.prefixe, (m.get(r.prefixe) || new Set()).add(role)); };
  for (const doc of fichier.docs || []) for (const lot of doc.lots || []) {
    for (const c of lot.f || []) { const r = cellule(c, dep, com, lot.pre), k = cleRef(r);
      if (!parFille.has(k)) parFille.set(k, []); parFille.get(k).push({ doc, lot }); noter(r, "fille"); }
    for (const c of lot.m || []) { const r = cellule(c, dep, com, lot.pre), k = cleRef(r);
      if (!parMere.has(k)) parMere.set(k, []); parMere.get(k).push({ doc, lot }); noter(r, "mère"); }
  }
  return { parFille, parMere, sansPrefixe, situation: fichier.situation || null };
}

// Parcelle au plan cadastral actuel (IGN) : l'objet, null si inconnue, undefined si service injoignable
async function featureParcelle(p) {
  const u = `${CADASTRE_PT}?code_insee=${inseeDe(p)}&section=${encodeURIComponent(p.section.padStart(2, "0"))}&numero=${p.numero}&com_abs=${p.prefixe}`;
  const lire = async () => { const r = await fetch(u); if (!r.ok) throw new Error(String(r.status)); return r.json(); };
  try { return (await lire()).features?.[0] || null; }
  catch {
    await new Promise(ok => setTimeout(ok, 1500));        // réponse 500 constatée le 05/10/2026
    try { return (await lire()).features?.[0] || null; } catch { return undefined; }
  }
}

// ============================================================
//   CONTRÔLES (repris de la page HISTO v19)
// ============================================================
function existence(r, feature, idx) {
  const k = cleRef(r);
  const commeFille = idx?.parFille.get(k) || [], commeMere = idx?.parMere.get(k) || [];
  let code;
  if (feature) code = "plan";
  else if (feature === null && idx && commeMere.length) code = "disparue";
  else if (feature === null && idx && commeFille.length) code = "dfi";
  else if (feature === null && idx) code = "introuvable";
  else code = "inconnu";
  let autres = [];
  if (code === "introuvable" && idx?.sansPrefixe) {
    const m = idx.sansPrefixe.get(`${r.section}-${r.numero}`);
    if (m) autres = [...m.entries()].filter(([pre]) => pre !== r.prefixe).map(([prefixe, roles]) => ({ prefixe, roles: [...roles] }));
    if (autres.length) code = "autre-prefixe";
  }
  const disparitions = commeMere.map(({ doc, lot }) => ({
    annee: doc.date ? +doc.date.slice(0, 4) : null, id_dfi: doc.id,
    parcelles_issues: lot.f.map(c => parcelle(cellule(c, r.dep, r.com, lot.pre))),
  })).sort((a, b) => (a.annee ?? 0) - (b.annee ?? 0));
  return { code, au_plan_actuel: feature ? true : feature === null ? false : null, autres_prefixes: autres, disparitions };
}

// Couverture trentenaire branche par branche (règle du 05/10/2026)
function couverture(maillons) {
  const an = new Date().getFullYear(), nees = new Set(), disparue = new Map(), origines = new Map();
  for (const m of maillons) {
    nees.add(m._cle);
    for (const o of m._meres) {
      const k = cleRef(o), a = m.document.annee; origines.set(k, o);
      if (!disparue.has(k) || (a != null && (disparue.get(k) == null || a > disparue.get(k)))) disparue.set(k, a ?? disparue.get(k) ?? null);
    }
  }
  const bouts = [...origines.keys()].filter(k => !nees.has(k)).map(k => ({ parcelle: origines.get(k), annee: disparue.get(k) }));
  const arrets = bouts.filter(b => b.annee == null || an - b.annee <= SEUIL_30_ANS).sort((a, b) => (b.annee ?? 9999) - (a.annee ?? 9999));
  return { bouts, arrets };
}

// ============================================================
//   FILIATION D'UNE RÉFÉRENCE
// ============================================================
async function filiation(entree, jeton) {
  const racine = normRef(entree);
  const brut = x => String(x ?? "").trim();
  const communeDonnee = brut(entree.insee) || (brut(entree.dep) && brut(entree.com));
  if (!communeDonnee || !brut(entree.section) || !brut(entree.numero)
      || !/^(0[1-9]|[1-8]\d|9[0-5]|2A|2B|97[1-6])$/.test(racine.dep) || !/^\d{3}$/.test(racine.com)
      || !/^[A-Z0-9]{1,2}$/.test(racine.section) || !/^\d{4}$/.test(racine.numero) || racine.numero === "0000")
    return { ...echo(entree), reference: parcelle(racine), statut: "reference-invalide",
             erreur: { code: "reference-invalide", message: "Commune (insee, ou dep + com), section et numéro requis." } };
  const [feature, idx] = await Promise.all([featureParcelle(racine), indexCommune(racine.dep, racine.com, jeton)]);
  const anneeCourante = new Date().getFullYear();
  const maillons = [], vus = new Set();

  if (idx) {
    const aTraiter = [{ ...racine, profondeur: 0 }];
    while (aTraiter.length) {
      const p = aTraiter.shift(), k = cleRef(p);
      if (vus.has(k) || p.profondeur > PROFONDEUR_MAX) continue;
      vus.add(k);
      for (const { doc, lot } of (idx.parFille.get(k) || [])) {
        const meres = lot.m.map(c => cellule(c, p.dep, p.com, lot.pre));
        const filles = lot.f.map(c => cellule(c, p.dep, p.com, lot.pre));
        const annee = doc.date ? +doc.date.slice(0, 4) : null;
        maillons.push({
          _cle: k, _meres: meres,
          profondeur: p.profondeur,
          parcelle: parcelle(p),
          nature: natureMouvement(doc.nat, meres.length, filles.length),
          document: { id_dfi: doc.id, lot: lot.lot, code_nature: doc.nat, libelle_nature: LIBELLES_DOCUMENT[doc.nat] ?? null,
                      date_effet: dateIso(doc.date), annee },
          au_dela_30_ans: annee != null && (anneeCourante - annee) > SEUIL_30_ANS,
          parcelles_origine: meres.map(m => parcelle(m)),
          parcelles_soeurs: filles.filter(x => cleRef(x) !== k).map(s => parcelle(s)),
        });
        for (const m of meres) aTraiter.push({ ...m, profondeur: p.profondeur + 1 });
      }
    }
  }
  // du plus récent au plus ancien, même sens que la restitution HISTO
  maillons.sort((a, b) => { const da = a.document.date_effet ?? "", db = b.document.date_effet ?? "";
    return da !== db ? (da < db ? 1 : -1) : a.profondeur - b.profondeur; });

  // Le DFI ne porte aucune contenance : HISTO ne donne que celle de la parcelle actuelle
  // (plan cadastral IGN). Le contrôle d'écart de surface (4 %, 5 m²) revient à l'appelant,
  // qui dispose des contenances anciennes par les titres.
  const contenance = feature?.properties?.contenance != null ? Number(feature.properties.contenance) : null;

  const ex = existence(racine, feature, idx);
  const trouve = maillons.length > 0;
  const cv = couverture(maillons);
  const trentenaire = trouve && cv.arrets.length === 0;
  const etat = ex.code === "introuvable" || ex.code === "autre-prefixe" ? "carmin"
             : !trouve ? "jaune" : trentenaire ? "vert" : "jaune";
  const motif = ex.code === "introuvable" || ex.code === "autre-prefixe" ? "introuvable"
              : !trouve ? (idx === null ? "commune-non-chargee" : "aucun-mouvement")
              : trentenaire ? "trentenaire" : "arret-avant-30-ans";
  const plusAncien = maillons.reduce((min, m) => m.document.annee != null && (min == null || m.document.annee < min) ? m.document.annee : min, null);

  return {
    ...echo(entree),
    reference: parcelle(racine, { contenance_m2: contenance }),
    statut: "traite",
    existence: ex,
    trouve,
    etat_dfi: { couleur: etat, motif },
    trentenaire,
    plus_ancien_mouvement: plusAncien,
    arrets: cv.arrets.map(a => ({ parcelle: parcelle(a.parcelle), annee_disparition: a.annee })),
    nombre_maillons: maillons.length,
    arbre: maillons.map(({ _cle, _meres, ...m }, i) => ({ rang: i + 1, ...m })),
  };
}
const echo = e => ({ ...(e.groupe != null ? { groupe: e.groupe } : {}), ...(e.identifiant != null ? { identifiant: e.identifiant } : {}) });

// ============================================================
//   POINT D'ENTRÉE
// ============================================================
function origines() {
  const env = (process.env.HISTO_ORIGINES || "").split(",").map(s => s.trim()).filter(Boolean);
  return env.length ? env : ORIGINES_PAR_DEFAUT;
}
function poserEnTetes(req, res) {
  const o = req.headers.origin;
  if (o && origines().includes(o)) {
    res.setHeader("Access-Control-Allow-Origin", o);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
  res.setHeader("Cache-Control", "no-store");
}
const jetonDe = req => (String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i) || [])[1] || null;

export default async function handler(req, res) {
  poserEnTetes(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  const o = req.headers.origin;
  if (o && !origines().includes(o)) return res.status(403).json({ erreur: { code: "origine-refusee", message: `Origine non autorisée : ${o}` } });

  const jeton = jetonDe(req);
  try {
    if (req.method === "GET") {
      const situation = jeton ? await situationDfi(jeton) : null;
      return res.status(200).json({ histo: { version_contrat: VERSION_CONTRAT, situation_dfi: situation } });
    }
    if (req.method !== "POST") return res.status(405).json({ erreur: { code: "methode", message: "GET ou POST seulement." } });
    if (!jeton) return res.status(401).json({ erreur: { code: "jeton-absent", message: "En-tête Authorization: Bearer <jeton Google> manquant." } });

    let corps = req.body;
    if (typeof corps === "string") { try { corps = JSON.parse(corps); } catch { corps = null; } }
    const refs = Array.isArray(corps?.references) ? corps.references : null;
    if (!refs || !refs.length) return res.status(400).json({ erreur: { code: "references", message: "Le corps doit porter un tableau « references » non vide." } });
    if (refs.length > MAX_REFERENCES) return res.status(400).json({ erreur: { code: "trop-de-references", message: `${MAX_REFERENCES} références au plus par appel.` } });

    const situation = await situationDfi(jeton);
    const resultats = await Promise.all(refs.map(r => filiation(r || {}, jeton).catch(e => {
      if (e instanceof ErreurHisto && (e.statut === 401 || e.statut === 403)) throw e;   // inutile d'insister
      return { ...echo(r || {}), reference: parcelle(normRef(r || {})), statut: "erreur", erreur: { code: e.code || "interne", message: e.message } };
    })));

    return res.status(200).json({
      histo: { version_contrat: VERSION_CONTRAT, situation_dfi: situation, genere_le: new Date().toISOString(),
               appelant: corps.appelant ?? null, seuil_trente_ans: SEUIL_30_ANS },
      resultats,
    });
  } catch (e) {
    const statut = e instanceof ErreurHisto ? e.statut : 500;
    return res.status(statut).json({ erreur: { code: e.code || "interne", message: e.message || "Erreur interne." } });
  }
}
