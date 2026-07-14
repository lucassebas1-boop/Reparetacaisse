/**
 * CRM Prospection Reparetacaisse — Google Apps Script
 * ---------------------------------------------------
 * Sourcing (API Recherche d'entreprises) -> Scoring -> Enrichissement email
 * -> Sequence J+0 / J+2 / J+5 -> Detection reponses & opt-out.
 *
 * Installation : voir prospection/README.md (section 8).
 * 1) Coller ce fichier dans Extensions > Apps Script d'un Google Sheets vierge.
 * 2) Remplir CONFIG ci-dessous.
 * 3) Executer setup() une fois.
 */

var CONFIG = {
  // --- A PERSONNALISER ---
  TELEPHONE: '06 XX XX XX XX',
  SITE: 'https://reparetacaisse.fr',
  SIGNATURE_NOM: 'Lucas — Reparetacaisse',
  VILLE_BASE: 'Gagny (93)',

  // true = tous les emails sont envoyes A TOI (pour valider les templates).
  MODE_TEST: true,

  // Optionnel : Google Custom Search (100 requetes/jour gratuites) pour
  // trouver les sites web automatiquement. Laisser vide = enrichissement
  // semi-manuel via le lien "Recherche" dans la feuille.
  CSE_API_KEY: '',
  CSE_CX: '',

  // --- REGLAGES ---
  SEUIL_SCORE_ENVOI: 6,
  ENVOIS_MAX_PAR_JOUR: 20,
  RESULTATS_PAR_SOURCING: 10,
  JOURS_RELANCE_1: 2,
  JOURS_RELANCE_2: 5,
  JOURS_AVANT_PERDU: 15,

  DEPARTEMENTS: ['93', '94', '77', '75', '91', '95', '78', '92'],

  // NAF cibles : libelle segment + poids dans le score (0-3).
  NAF: {
    '77.11A': { segment: 'loueur',    label: 'Location courte duree vehicules legers', poids: 3 },
    '77.11B': { segment: 'loueur',    label: 'Location longue duree vehicules legers', poids: 3 },
    '49.32Z': { segment: 'taxi',      label: 'Taxis / VTC',                            poids: 3 },
    '53.20Z': { segment: 'livraison', label: 'Livraison / courses',                    poids: 2.5 },
    '85.53Z': { segment: 'autoecole', label: 'Auto-ecole',                             poids: 2 },
    '45.20A': { segment: 'garage',    label: 'Garage entretien/reparation VL',         poids: 2 }
  }
};

var SHEET_PROSPECTS = 'Prospects';
var COLS = ['SIREN', 'Raison sociale', 'NAF', 'Activite', 'Ville', 'CP', 'Dept',
            'Effectif', 'Date creation', 'Recherche', 'Site web', 'Email',
            'Score', 'Statut', 'Date ajout', 'Date J0', 'Notes'];
// Index de colonnes (0-based).
var C = { SIREN: 0, NOM: 1, NAF: 2, ACTIVITE: 3, VILLE: 4, CP: 5, DEPT: 6,
          EFFECTIF: 7, CREATION: 8, RECHERCHE: 9, SITE: 10, EMAIL: 11,
          SCORE: 12, STATUT: 13, DATE_AJOUT: 14, DATE_J0: 15, NOTES: 16 };

// ============================================================ SETUP =========

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_PROSPECTS) || ss.insertSheet(SHEET_PROSPECTS);
  if (sh.getRange(1, 1).getValue() === '') {
    sh.getRange(1, 1, 1, COLS.length).setValues([COLS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  // Purge puis (re)creation des triggers.
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('sourcerProspects').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(7).create();
  ScriptApp.newTrigger('enrichirEmails').timeBased().everyDays(1).atHour(8).create();
  ScriptApp.newTrigger('envoyerSequences').timeBased().everyDays(1).atHour(9).create();
  Logger.log('Setup OK : onglet + 3 triggers crees.');
}

// ========================================================== SOURCING ========

/**
 * Interroge l'API open data Recherche d'entreprises sur le prochain couple
 * NAF x departement (rotation memorisee), dedoublonne, score, insere.
 */
function sourcerProspects() {
  var props = PropertiesService.getScriptProperties();
  var nafs = Object.keys(CONFIG.NAF);
  var combos = [];
  nafs.forEach(function (naf) {
    CONFIG.DEPARTEMENTS.forEach(function (d) { combos.push([naf, d]); });
  });
  var idx = parseInt(props.getProperty('comboIdx') || '0', 10) % combos.length;
  var page = parseInt(props.getProperty('comboPage') || '1', 10);
  var naf = combos[idx][0], dept = combos[idx][1];

  var url = 'https://recherche-entreprises.api.gouv.fr/search'
    + '?activite_principale=' + encodeURIComponent(naf)
    + '&departement=' + dept
    + '&etat_administratif=A'
    + '&per_page=' + CONFIG.RESULTATS_PAR_SOURCING
    + '&page=' + page;

  var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) {
    Logger.log('API en erreur (' + resp.getResponseCode() + ') sur ' + url);
    return;
  }
  var data = JSON.parse(resp.getContentText());
  var results = data.results || [];

  var sh = feuille_();
  var sirensConnus = {};
  if (sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues()
      .forEach(function (r) { sirensConnus[String(r[0])] = true; });
  }

  var ajoutes = 0;
  results.forEach(function (e) {
    var siren = String(e.siren || '');
    if (!siren || sirensConnus[siren]) return;
    var effectif = trancheEffectif_(e.tranche_effectif_salarie);
    if (effectif === null) return; // coquille vide / effectif inconnu ou 0
    var siege = e.siege || {};
    var nom = e.nom_raison_sociale || e.nom_complet || '';
    var ville = siege.libelle_commune || '';
    var score = scorer_(naf, effectif, dept, e.date_creation, false);

    sh.appendRow([
      "'" + siren, nom, naf, CONFIG.NAF[naf].label, ville,
      siege.code_postal || '', dept, effectif, e.date_creation || '',
      'https://www.google.com/search?q=' + encodeURIComponent(nom + ' ' + ville + ' contact'),
      '', '', score, 'NOUVEAU', dateISO_(new Date()), '', ''
    ]);
    sirensConnus[siren] = true;
    ajoutes++;
  });

  // Rotation : page suivante si la page etait pleine, sinon combo suivant.
  if (results.length >= CONFIG.RESULTATS_PAR_SOURCING && page < (data.total_pages || 1)) {
    props.setProperty('comboPage', String(page + 1));
  } else {
    props.setProperty('comboIdx', String((idx + 1) % combos.length));
    props.setProperty('comboPage', '1');
  }
  Logger.log('Sourcing ' + naf + ' / dept ' + dept + ' page ' + page + ' : ' + ajoutes + ' nouveaux prospects.');
}

/** Convertit le code tranche INSEE en effectif approximatif ; null = exclu. */
function trancheEffectif_(code) {
  var map = { '01': 1, '02': 2, '03': 4, '11': 7, '12': 15, '21': 35, '22': 75,
              '31': 150, '32': 350, '41': 750, '42': 1500 };
  return map[code] || null; // 'NN', '00' ou vide -> exclu
}

function scorer_(naf, effectif, dept, dateCreation, emailTrouve) {
  var s = CONFIG.NAF[naf] ? CONFIG.NAF[naf].poids : 0;                 // 0-3
  s += (effectif >= 3 && effectif <= 49) ? 2 : (effectif >= 1 ? (effectif > 49 ? 0.5 : 1) : 0); // 0-2
  s += (dept === '93' || dept === '94') ? 2 : (dept === '77' || dept === '75') ? 1.5 : 1;        // 0-2
  if (dateCreation) {
    var ans = (new Date() - new Date(dateCreation)) / (365.25 * 24 * 3600 * 1000);
    if (ans >= 3) s += 1;                                              // 0-1
  }
  if (emailTrouve) s += 2;                                             // 0-2
  return Math.min(10, Math.round(s * 10) / 10);
}

// ===================================================== ENRICHISSEMENT =======

/**
 * Pour chaque ligne NOUVEAU : trouve le site (Google CSE si configure),
 * crawle accueil + /contact + /mentions-legales, extrait un email.
 */
function enrichirEmails() {
  var sh = feuille_();
  if (sh.getLastRow() < 2) return;
  var range = sh.getRange(2, 1, sh.getLastRow() - 1, COLS.length);
  var rows = range.getValues();
  var traites = 0;

  for (var i = 0; i < rows.length && traites < 15; i++) {
    var r = rows[i];
    if (r[C.STATUT] !== 'NOUVEAU') continue;
    traites++;

    var site = String(r[C.SITE] || '');
    if (!site && CONFIG.CSE_API_KEY && CONFIG.CSE_CX) {
      site = chercherSite_(r[C.NOM] + ' ' + r[C.VILLE]);
    }
    var email = site ? extraireEmail_(site) : '';

    if (email) {
      r[C.SITE] = site;
      r[C.EMAIL] = email;
      r[C.SCORE] = scorer_(r[C.NAF], Number(r[C.EFFECTIF]), String(r[C.DEPT]), r[C.CREATION], true);
      r[C.STATUT] = 'PRET';
    } else {
      r[C.SITE] = site;
      r[C.STATUT] = 'A_ENRICHIR_MANUEL'; // complete Email a la main puis remets PRET
    }
    sh.getRange(i + 2, 1, 1, COLS.length).setValues([r]);
  }
  Logger.log('Enrichissement : ' + traites + ' lignes traitees.');
}

function chercherSite_(requete) {
  try {
    var url = 'https://www.googleapis.com/customsearch/v1?key=' + CONFIG.CSE_API_KEY
      + '&cx=' + CONFIG.CSE_CX + '&num=3&q=' + encodeURIComponent(requete);
    var data = JSON.parse(UrlFetchApp.fetch(url, { muteHttpExceptions: true }).getContentText());
    var exclus = /pagesjaunes|societe\.com|linkedin|facebook|infogreffe|verif\.com|pappers/i;
    var items = data.items || [];
    for (var i = 0; i < items.length; i++) {
      if (!exclus.test(items[i].link)) return items[i].link.split('/').slice(0, 3).join('/');
    }
  } catch (e) { Logger.log('CSE erreur : ' + e); }
  return '';
}

function extraireEmail_(site) {
  var pages = ['', '/contact', '/mentions-legales', '/contact.html'];
  var regex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  var junk = /sentry|wixpress|example|\.png|\.jpg|godaddy|domain/i;
  for (var i = 0; i < pages.length; i++) {
    try {
      var html = UrlFetchApp.fetch(site + pages[i], {
        muteHttpExceptions: true, followRedirects: true,
        headers: { 'User-Agent': 'Mozilla/5.0' }
      }).getContentText();
      var found = (html.match(regex) || []).filter(function (m) { return !junk.test(m); });
      if (found.length) {
        // Prefere une adresse generique (contact@, info@...).
        var generique = found.filter(function (m) { return /^(contact|info|accueil|hello|bonjour)@/i.test(m); });
        return (generique[0] || found[0]).toLowerCase();
      }
    } catch (e) { /* page inaccessible : on tente la suivante */ }
  }
  return '';
}

// ========================================================= SEQUENCES ========

var TEMPLATES = {
  loueur: {
    j0: {
      objet: 'Entretien de votre flotte — intervention sur place a {ville}',
      corps: 'Bonjour,\n\nJe suis Lucas, mecanicien diagnostiqueur base a ' + CONFIG.VILLE_BASE + '. J\'interviens directement sur votre parking : diagnostic electronique, entretien courant, remise en etat avant relocation — sans immobiliser vos vehicules chez un garage.\n\nPour un loueur, chaque journee de vehicule arrete est une journee de location perdue : mon creneau d\'intervention se cale sur vos rotations.\n\nSeriez-vous disponible 15 minutes cette semaine pour que je vous presente mes tarifs flotte ?'
    },
    r1: {
      objet: 'Re: Entretien de votre flotte — {ville}',
      corps: 'Bonjour,\n\nJe me permets de remonter mon message. Un chiffre concret : sur une flotte essence, la conversion E85 fait economiser 30 a 40 % de budget carburant. Je peux vous faire un devis sur un vehicule test, sans engagement.\n\nQuel est le bon interlocuteur pour le parc ?'
    },
    r2: {
      objet: 'Dernier message — diagnostic offert sur un vehicule de votre parc',
      corps: 'Bonjour,\n\nDernier message de ma part. Je vous propose un diagnostic electronique offert sur un vehicule de votre choix, sur place, pour vous montrer comment je travaille.\n\nSi le sujet n\'est pas d\'actualite, aucune relance de ma part — sinon, un simple "OK" me suffit pour vous appeler.'
    }
  },
  taxi: {
    j0: {
      objet: 'Reduire votre budget carburant et vos immobilisations — {ville}',
      corps: 'Bonjour,\n\nJe suis Lucas, mecanicien diagnostiqueur base a ' + CONFIG.VILLE_BASE + '. Je travaille avec des chauffeurs taxi/VTC sur deux sujets : la conversion E85 (30 a 40 % d\'economie de carburant sur essence) et le diagnostic/entretien sur place, sur vos creneaux creux, pour que le vehicule ne perde pas une journee de courses.\n\nPuis-je vous appeler 10 minutes pour voir si c\'est pertinent pour votre vehicule ?'
    },
    r1: {
      objet: 'Re: budget carburant — {ville}',
      corps: 'Bonjour,\n\nPetit rappel de mon message. Exemple concret : un vehicule essence a 25 000 km/an economise environ 1 200 a 1 800 EUR/an de carburant en E85. Devis gratuit sur simple reponse.'
    },
    r2: {
      objet: 'Dernier message — diagnostic offert',
      corps: 'Bonjour,\n\nDernier message : je vous offre un diagnostic electronique complet sur votre vehicule, sur place. Un "OK" en reponse et je vous appelle pour caler le creneau.'
    }
  },
  livraison: {
    j0: {
      objet: 'Vos utilitaires entretenus sur site, sans immobilisation — {ville}',
      corps: 'Bonjour,\n\nJe suis Lucas, mecanicien diagnostiqueur base a ' + CONFIG.VILLE_BASE + '. J\'interviens sur site pour le diagnostic et l\'entretien de vos utilitaires, en dehors de vos heures de tournee : vos vehicules restent disponibles.\n\nSeriez-vous disponible 15 minutes cette semaine pour en parler ?'
    },
    r1: {
      objet: 'Re: entretien utilitaires — {ville}',
      corps: 'Bonjour,\n\nJe me permets de relancer : un utilitaire immobilise, c\'est une tournee non assuree. Mon modele : intervention sur votre parking, soir ou week-end si besoin. Quel est le bon interlocuteur pour le parc ?'
    },
    r2: {
      objet: 'Dernier message — diagnostic offert sur un utilitaire',
      corps: 'Bonjour,\n\nDernier message de ma part : diagnostic electronique offert sur un utilitaire de votre choix, sur place. Un simple "OK" me suffit pour vous appeler.'
    }
  },
  autoecole: {
    j0: {
      objet: 'Budget carburant auto-ecole : 30-40 % d\'economie possible — {ville}',
      corps: 'Bonjour,\n\nJe suis Lucas, mecanicien diagnostiqueur base a ' + CONFIG.VILLE_BASE + '. Vos vehicules roulent toute la journee : le carburant est un de vos premiers postes de cout. La conversion E85 sur vehicule essence permet 30 a 40 % d\'economie, et j\'assure aussi diagnostic et entretien sur place, en dehors des heures de lecon.\n\nPuis-je vous faire un devis sur un de vos vehicules ?'
    },
    r1: {
      objet: 'Re: budget carburant — {ville}',
      corps: 'Bonjour,\n\nJe reviens vers vous : sur un vehicule d\'auto-ecole (20-30 000 km/an), l\'economie E85 se chiffre en centaines d\'euros par vehicule et par an. Devis gratuit, sans engagement.'
    },
    r2: {
      objet: 'Dernier message — diagnostic offert',
      corps: 'Bonjour,\n\nDernier message : diagnostic electronique offert sur un vehicule de votre parc, sur place, pour vous montrer comment je travaille. Un "OK" et je vous appelle.'
    }
  },
  garage: {
    j0: {
      objet: 'Partenariat : diagnostic electronique et reprogrammation pour vos clients',
      corps: 'Bonjour,\n\nJe suis Lucas, diagnostiqueur et specialiste reprogrammation (outil professionnel FlexMagicMotorsport), base a ' + CONFIG.VILLE_BASE + '. Je propose aux garages du secteur un partenariat simple : vous m\'envoyez les prestations que vous ne faites pas en interne (diag electronique pousse, reprogrammation Stage 1, conversion E85), je me deplace chez vous, vous margez sur la prestation.\n\nSeriez-vous disponible 15 minutes pour en parler ?'
    },
    r1: {
      objet: 'Re: partenariat diagnostic / reprogrammation',
      corps: 'Bonjour,\n\nJe me permets de relancer. Concretement : vous facturez votre client, je vous facture en sous-traitance — vous gagnez la marge sans investir dans l\'outillage. Je peux passer vous montrer le materiel quand vous voulez.'
    },
    r2: {
      objet: 'Dernier message — une prestation test chez vous',
      corps: 'Bonjour,\n\nDernier message : je vous propose une prestation test sur un vehicule de votre atelier, pour juger sur piece. Un "OK" en reponse et je vous appelle.'
    }
  }
};

var MENTION_OPTOUT = '\n\n' + '{signature}' + '\n\n--\nVous recevez cet email sur votre adresse professionnelle publique (donnees publiques SIRENE / site web de votre entreprise). Repondez STOP pour ne plus etre contacte.';

/**
 * Tourne du lundi au vendredi : detecte les reponses, puis envoie J+0,
 * relance 1 (J+2), relance 2 (J+5), et passe PERDU apres 15 jours.
 */
function envoyerSequences() {
  var jour = new Date().getDay();
  if (jour === 0 || jour === 6) return; // pas d'envoi le week-end

  detecterReponses_();

  var sh = feuille_();
  if (sh.getLastRow() < 2) return;
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, COLS.length).getValues();
  var quota = Math.min(CONFIG.ENVOIS_MAX_PAR_JOUR, MailApp.getRemainingDailyQuota() - 5);
  var envoyes = 0;
  var now = new Date();

  // Meilleurs scores d'abord pour les J+0.
  var ordre = rows.map(function (r, i) { return { r: r, i: i }; })
                  .sort(function (a, b) { return Number(b.r[C.SCORE]) - Number(a.r[C.SCORE]); });

  ordre.forEach(function (o) {
    if (envoyes >= quota) return;
    var r = o.r, ligne = o.i + 2;
    var statut = r[C.STATUT];
    var email = String(r[C.EMAIL] || '').trim();
    var joursDepuisJ0 = r[C.DATE_J0] ? (now - new Date(r[C.DATE_J0])) / 86400000 : 0;

    if (statut === 'PRET' && email && Number(r[C.SCORE]) >= CONFIG.SEUIL_SCORE_ENVOI) {
      if (envoyer_(r, 'j0')) {
        sh.getRange(ligne, C.STATUT + 1).setValue('CONTACTE');
        sh.getRange(ligne, C.DATE_J0 + 1).setValue(dateISO_(now));
        envoyes++;
      }
    } else if (statut === 'CONTACTE' && joursDepuisJ0 >= CONFIG.JOURS_RELANCE_1) {
      if (envoyer_(r, 'r1')) { sh.getRange(ligne, C.STATUT + 1).setValue('RELANCE_1'); envoyes++; }
    } else if (statut === 'RELANCE_1' && joursDepuisJ0 >= CONFIG.JOURS_RELANCE_2) {
      if (envoyer_(r, 'r2')) { sh.getRange(ligne, C.STATUT + 1).setValue('RELANCE_2'); envoyes++; }
    } else if (statut === 'RELANCE_2' && joursDepuisJ0 >= CONFIG.JOURS_AVANT_PERDU) {
      sh.getRange(ligne, C.STATUT + 1).setValue('PERDU');
    }
  });
  Logger.log('Sequences : ' + envoyes + ' emails envoyes' + (CONFIG.MODE_TEST ? ' (MODE TEST -> vers toi)' : '') + '.');
}

function envoyer_(r, etape) {
  var seg = (CONFIG.NAF[r[C.NAF]] || {}).segment || 'loueur';
  var t = (TEMPLATES[seg] || TEMPLATES.loueur)[etape];
  var signature = CONFIG.SIGNATURE_NOM + ' · ' + CONFIG.SITE + ' · ' + CONFIG.TELEPHONE;
  var objet = t.objet.replace('{ville}', r[C.VILLE]);
  var corps = t.corps.replace(/\{ville\}/g, r[C.VILLE])
    + MENTION_OPTOUT.replace('{signature}', signature);
  var dest = CONFIG.MODE_TEST ? Session.getActiveUser().getEmail() : String(r[C.EMAIL]).trim();
  try {
    MailApp.sendEmail({ to: dest, subject: (CONFIG.MODE_TEST ? '[TEST] ' : '') + objet, body: corps, name: CONFIG.SIGNATURE_NOM });
    return true;
  } catch (e) {
    Logger.log('Envoi KO vers ' + dest + ' : ' + e);
    return false;
  }
}

/** Marque REPONDU (reponse recue) ou OPT_OUT (reponse contenant STOP). */
function detecterReponses_() {
  var sh = feuille_();
  if (sh.getLastRow() < 2) return;
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, COLS.length).getValues();
  rows.forEach(function (r, i) {
    var statut = r[C.STATUT];
    if (['CONTACTE', 'RELANCE_1', 'RELANCE_2'].indexOf(statut) === -1) return;
    var email = String(r[C.EMAIL] || '').trim();
    if (!email) return;
    try {
      var threads = GmailApp.search('from:' + email + ' newer_than:7d', 0, 3);
      if (!threads.length) return;
      var dernier = threads[0].getMessages().pop();
      var texte = dernier.getPlainBody().substring(0, 500).toUpperCase();
      var nouveau = /\bSTOP\b|DESINSCRI|DESABONN/.test(texte) ? 'OPT_OUT' : 'REPONDU';
      sh.getRange(i + 2, C.STATUT + 1).setValue(nouveau);
    } catch (e) { /* recherche Gmail en echec : on reessaie demain */ }
  });
}

// ============================================================ UTILS =========

function feuille_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PROSPECTS);
}

function dateISO_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}
