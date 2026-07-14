# Prospection B2B automatisée — Reparetacaisse

Automatisation de prospection **email** vers les **loueurs de véhicules, flottes taxi/VTC, sociétés de livraison, auto-écoles et garages** d'Île-de-France, pour vendre : diagnostic auto mobile, entretien de flotte, reprogrammation / optimisation conso, conversion E85.

**Budget : 0 €. Objectif : 5-15 leads qualifiés / semaine. Canal : email. Mise en route : < 48 h.**

---

## 0. TL;DR — la stack recommandée (100 % gratuite)

| Brique | Outil | Coût |
|---|---|---|
| Source de prospects | **API Recherche d'entreprises** (open data État, sans clé) | 0 € |
| Enrichissement email | Google Custom Search (100 req/jour gratuites) + crawl du site | 0 € |
| CRM | **Google Sheets** | 0 € |
| Moteur d'automatisation | **Google Apps Script** (fourni : [`Code.gs`](./Code.gs)) | 0 € |
| Envoi + relances J+0 / J+2 / J+5 | Gmail via Apps Script (quota 100 mails/jour, on en utilise ≤ 20) | 0 € |

Pourquoi pas Make.com en premier choix ? Parce qu'à 0 € de budget, Make Free (1 000 opérations/mois, 2 scénarios actifs) est **jouable mais serré** (voir §6), alors qu'Apps Script fait exactement la même chose sans limite gênante, directement dans ton CRM Google Sheets. La variante Make est quand même détaillée au §1-B si tu préfères du visuel no-code.

Pourquoi pas de scraping LeBonCoin ici ? Ta cible est B2B : la donnée officielle (SIRENE) est **gratuite, légale, fraîche et sans anti-bot**. Zéro risque de blocage, zéro problème de CGU.

---

## 1. Architecture du scénario

### 1-A. Variante recommandée : Google Sheets + Apps Script (0 €)

Un seul fichier de code ([`Code.gs`](./Code.gs)), 3 automatismes déclenchés par triggers horaires :

```
┌──────────────────────────────────────────────────────────────────┐
│ TRIGGER lundi 7h — sourcerProspects()                            │
│  1. GET recherche-entreprises.api.gouv.fr                        │
│     (rotation code NAF × département à chaque exécution)         │
│  2. Filtre : entreprise active, hors auto-entrepreneurs sans     │
│     effectif, hors doublons (dédup par SIREN)                    │
│  3. Scoring /10 (voir §3)                                        │
│  4. Ajout dans l'onglet "Prospects", statut NOUVEAU              │
├──────────────────────────────────────────────────────────────────┤
│ TRIGGER tous les jours 8h — enrichirEmails()                     │
│  1. Prend les lignes NOUVEAU                                     │
│  2. Trouve le site web (Google Custom Search, gratuit)           │
│  3. Crawl accueil + /contact + /mentions-legales                 │
│  4. Extrait l'email (regex), +2 pts de score si trouvé           │
│  5. Statut → PRET (ou A_ENRICHIR_MANUEL si rien trouvé :         │
│     tu complètes à la main en 30 s via le lien de recherche)     │
├──────────────────────────────────────────────────────────────────┤
│ TRIGGER lun-ven 9h30 — envoyerSequences()                        │
│  1. PRET + score ≥ 6        → email J+0, statut CONTACTE         │
│  2. CONTACTE depuis ≥ 2 j   → relance 1, statut RELANCE_1        │
│  3. RELANCE_1, J+0 ≥ 5 j    → relance 2, statut RELANCE_2        │
│  4. Détection réponses Gmail → statut REPONDU / OPT_OUT (STOP)   │
│  5. Plafond : 20 envois/jour max (délivrabilité)                 │
└──────────────────────────────────────────────────────────────────┘
```

Toi, tu n'interviens que sur : les lignes `A_ENRICHIR_MANUEL` (trouver l'email en 30 s), et les `REPONDU` (répondre, poser le RDV, passer le statut à `RDV` puis `CLIENT` ou `PERDU`).

### 1-B. Variante Make.com (Make Free, si tu préfères le no-code visuel)

**Scénario 1 — "Sourcing"** (planifié lundi + jeudi 7h) :

1. **Scheduler** (déclencheur planifié).
2. **Google Sheets → Get values** (onglet `Parametres`) : lit le prochain couple NAF × département à traiter (pointeur incrémenté à chaque run pour tourner sur toutes les combinaisons).
3. **HTTP → Make a request** : `GET https://recherche-entreprises.api.gouv.fr/search?activite_principale={{NAF}}&departement={{dept}}&etat_administratif=A&per_page=10&page={{page}}`.
4. **Iterator** sur `results[]`.
5. **Filtre** : `etat_administratif = A` ET tranche d'effectif renseignée (exclut les coquilles vides).
6. **Google Sheets → Search rows** : recherche du SIREN dans `Prospects` (déduplication).
7. **Filtre** : aucun résultat (= nouveau prospect).
8. **Tools → Set variable** : calcul du score (formule du §3 en une expression Make).
9. **Google Sheets → Add a row** : ajout avec statut `NOUVEAU`.

**Scénario 2 — "Séquences email"** (planifié lun-ven 9h30) :

1. **Scheduler**.
2. **Google Sheets → Search rows** : `Statut = PRET` et `Score ≥ 6` (limite 5 lignes/jour).
3. **Router** 3 branches :
   - Branche J+0 : **Gmail → Send an email** (template §4) puis **Update a row** (`CONTACTE`, date du jour).
   - Branche J+2 : Search rows `Statut = CONTACTE` + `DateJ0 ≤ aujourd'hui − 2 j` → Gmail relance 1 → Update (`RELANCE_1`).
   - Branche J+5 : Search rows `Statut = RELANCE_1` + `DateJ0 ≤ aujourd'hui − 5 j` → Gmail relance 2 → Update (`RELANCE_2`).

Limite de Make Free : **pas d'enrichissement email automatique** dans le budget d'opérations (le crawl de sites consommerait trop d'ops). Avec Make, l'enrichissement reste manuel (30 s/prospect via le lien de recherche généré dans la feuille) ou tu combines : Apps Script pour l'enrichissement + Make pour le reste. Comptage d'opérations détaillé au §6.

> Test de l'API depuis ta machine (la sandbox où ce doc a été rédigé bloquait le domaine, l'API est bien publique) :
> ```bash
> curl "https://recherche-entreprises.api.gouv.fr/search?activite_principale=77.11A&departement=94&per_page=3"
> ```

---

## 2. Ciblage et filtrage

### Codes NAF ciblés (par ordre de priorité)

| NAF | Activité | Pourquoi c'est ta cible |
|---|---|---|
| **77.11A** | Location courte durée de véhicules légers | Flottes à fort kilométrage, immobilisation = perte sèche → diag mobile + entretien réactif |
| **77.11B** | Location longue durée | Gros parcs, contrats d'entretien récurrents |
| **49.32Z** | Taxis (et VTC) | Diesels à fort kilométrage, sensibles au coût carburant → E85, entretien |
| **53.20Z** | Livraison / courses | Utilitaires intensifs, chaque jour d'arrêt coûte |
| **85.53Z** | Auto-écoles | Petites flottes, budget carburant élevé → E85 |
| **45.20A** | Garages (entretien/réparation VL) | Pas des clients finaux mais des **apporteurs d'affaires** : ils sous-traitent la reprog/le diag électronique qu'ils ne font pas |

### Zone géographique

Départements, du plus proche au plus lointain de Gagny / Fontenay-sous-Bois : **93, 94, 77, 75, 91, 95, 78, 92** (pondéré dans le score).

### Exclusions (appliquées automatiquement)

- Entreprise cessée (`etat_administratif ≠ A`).
- Tranche d'effectif vide ou "0 salarié" (coquilles vides, holdings).
- SIREN déjà présent dans la base (déduplication).
- Statut `OPT_OUT` : jamais recontacté, même si l'entreprise réapparaît au sourcing.

---

## 3. Scoring automatique (/10)

| Critère | Points |
|---|---|
| Segment NAF : 77.11A/B ou 49.32Z = 3 · 53.20Z = 2,5 · 85.53Z = 2 · 45.20A = 2 | 0 – 3 |
| Effectif : 3-49 salariés = 2 (assez gros pour une flotte, trop petit pour un atelier interne) · 1-2 = 1 · 50+ = 0,5 | 0 – 2 |
| Proximité : 93/94 = 2 · 77/75 = 1,5 · 91/95/78/92 = 1 | 0 – 2 |
| Ancienneté ≥ 3 ans (solvabilité, vraie activité) | 0 – 1 |
| Email trouvé automatiquement (contact joignable) | 0 – 2 |

**Seuil d'envoi automatique : score ≥ 6.** Entre 4 et 6 : la ligne reste en base, tu décides à la main. Sous 4 : ignoré.

Ordre de traitement : les envois du jour prennent toujours les scores les plus hauts d'abord, donc même avec le plafond de 20 mails/jour, les meilleurs prospects partent en premier.

---

## 4. Emails — premier contact et relances

Principes appliqués : objet court sans mot spam, 6-8 lignes max, un seul appel à l'action, mention d'opt-out obligatoire (voir §7). Les templates sont dans [`Code.gs`](./Code.gs) et s'adaptent au segment. Exemple pour un **loueur** :

**J+0 — objet : `Entretien de votre flotte — intervention sur place à {ville}`**

> Bonjour,
>
> Je suis Lucas, mécanicien diagnostiqueur basé à Gagny (93). J'interviens **directement sur votre parking** : diagnostic électronique, entretien courant, remise en état avant relocation — sans immobiliser vos véhicules chez un garage.
>
> Pour un loueur, chaque journée de véhicule arrêté est une journée de location perdue : mon créneau d'intervention se cale sur vos rotations.
>
> Seriez-vous disponible 15 minutes cette semaine pour que je vous présente mes tarifs flotte ?
>
> Lucas — Reparetacaisse · reparetacaisse.fr · [téléphone]
>
> *Vous recevez cet email sur votre adresse professionnelle publique. Répondez STOP pour ne plus être contacté.*

**J+2 — relance 1 — objet : `Re: Entretien de votre flotte — {ville}`**

> Bonjour, je me permets de remonter mon message. Un chiffre concret : sur une flotte essence, la **conversion E85 fait économiser 30 à 40 % de budget carburant**. Je peux vous faire un devis sur un véhicule test, sans engagement. Quel est le bon interlocuteur pour le parc ?

**J+5 — relance 2 (dernière) — objet : `Dernier message — diagnostic offert sur un véhicule de votre parc`**

> Bonjour, dernier message de ma part. Je vous propose un **diagnostic électronique offert sur un véhicule** de votre choix, sur place, pour vous montrer comment je travaille. Si le sujet n'est pas d'actualité, aucune relance de ma part — sinon, un simple "OK" me suffit pour vous appeler.

Variantes par segment (déjà dans le code) : taxis/VTC → axe coût carburant E85 + disponibilité du véhicule ; auto-écoles → axe budget carburant + entretien planifié hors heures de leçons ; garages → axe **partenariat** ("je fais la reprog et le diag électronique que vous ne faites pas, vous margez dessus").

Après la relance 2 sans réponse : statut `RELANCE_2` puis tu passes `PERDU` (ou le script le fait après 15 jours). Pas de 4e message : c'est contre-productif et ça dégrade ta délivrabilité.

---

## 5. CRM Google Sheets

Onglet `Prospects`, créé automatiquement par la fonction `setup()` du script :

| Colonne | Contenu |
|---|---|
| SIREN | Clé de déduplication |
| Raison sociale, NAF, Activité, Ville, CP, Dépt | Depuis l'API |
| Effectif, Date création | Depuis l'API (servent au score) |
| Site web, Email | Enrichissement auto (ou manuel via la colonne "Recherche" qui contient un lien Google prérempli) |
| Score | /10, calculé |
| **Statut** | `NOUVEAU → PRET → CONTACTE → RELANCE_1 → RELANCE_2 → REPONDU → RDV → CLIENT / PERDU / OPT_OUT` (+ `A_ENRICHIR_MANUEL`) |
| Date ajout, Date J0 | Pilotent les relances |
| Notes | Libre |

Mise en forme conditionnelle recommandée (2 min à poser dans Sheets) : `REPONDU` en vert vif — c'est ta file d'attente d'action, à traiter dans la journée.

---

## 6. Coûts

### Stack recommandée : 0 €/mois

Quotas gratuits utilisés (compte Gmail standard) : 100 emails/jour Apps Script (on en envoie ≤ 20), 20 000 fetchs d'URL/jour (on en fait ~30), triggers illimités pour cet usage, Google Custom Search 100 requêtes/jour (on en fait ~10). **Aucun quota n'est approché.**

### Variante Make Free (1 000 ops/mois) — le calcul

- Sourcing 2×/semaine, 10 résultats/run : ~9 runs/mois × (4 modules fixes + 10 × 3 modules) ≈ **300 ops**.
- Séquences lun-ven : ~22 runs × (2 fixes + ~5 emails × 3 modules) ≈ **380 ops**.
- **Total ≈ 680 ops/mois** → ça tient dans les 1 000 gratuites, sans marge pour l'enrichissement auto. Si tu montes en volume : Make Core ≈ 10,59 $/mois (10 000 ops) et le problème disparaît.

### Si un jour tu veux industrialiser

n8n auto-hébergé (gratuit, illimité, mais il faut un serveur ~5 €/mois) ou Make Core. À ton volume cible (5-15 leads/semaine), **ça ne se justifie pas encore**.

---

## 7. Points de vigilance légaux

1. **Prospection B2B par email = légale en France sans consentement préalable** (régime opt-out, CNIL), à trois conditions que le système respecte déjà : le message est en rapport avec la fonction professionnelle du destinataire, tu t'identifies clairement, chaque email contient un moyen d'opposition simple (la mention STOP, traitée automatiquement → statut `OPT_OUT`, jamais recontacté).
2. **RGPD** : base légale = intérêt légitime (prospection B2B). Concrètement : mentionne la source des données si on te le demande ("données publiques SIRENE / site web de votre entreprise"), supprime la ligne sur demande, ne garde pas les `PERDU` plus de 3 ans. Ton Sheets fait office de registre — ajoute un onglet "Registre" avec une phrase décrivant le traitement, c'est suffisant à ton échelle.
3. **Source de données** : l'API Recherche d'entreprises est de l'**open data officiel** (licence ouverte) — aucun problème de CGU, contrairement au scraping. Les emails collectés sur les sites web sont des adresses professionnelles publiées à des fins de contact : usage B2B conforme tant que l'opt-out est respecté. Préfère les adresses génériques (`contact@`) aux adresses nominatives.
4. ⚠️ **Ne mets jamais par écrit "suppression FAP/AdBlue" dans un email de prospection.** La suppression FAP/AdBlue est **interdite pour un véhicule roulant sur route ouverte** (amende, contre-visite au CT, et responsabilité engagée vis-à-vis d'un pro qui loue ses véhicules). Vendre ça par email à des flottes = preuve écrite contre toi. Les templates fournis ne mentionnent que les prestations défendables : diag, entretien, Stage 1, E85. Même prudence sur l'E85 : la conversion par reprogrammation seule n'est pas homologuée (pas de modification de carte grise possible, incidence assurance) — reste sur la formulation "économie carburant, devis sur véhicule test" et traite le sujet de l'homologation de vive voix.
5. **LeBonCoin/Auto1** (pour mémoire, ton activité achat-revente) : leurs CGU interdisent le scraping et LeBonCoin est protégé par Datadome. Cette architecture n'y touche pas ; si tu veux automatiser ce volet un jour, la voie propre est leurs alertes email natives parsées par ton automatisation, pas le scraping direct.
6. **Délivrabilité** (pas légal mais vital) : ≤ 20 envois/jour depuis un Gmail standard, montée progressive la première semaine (le script gère), pas de pièce jointe au premier contact. Si tu crées un jour une adresse `lucas@reparetacaisse.fr`, configure SPF/DKIM avant d'envoyer.

---

## 8. Mise en route (≈ 45 minutes)

1. Crée un Google Sheets vierge nommé `CRM Prospection Reparetacaisse`.
2. Menu **Extensions → Apps Script**, colle tout le contenu de [`Code.gs`](./Code.gs), enregistre.
3. En haut du fichier, remplis `CONFIG` : ton téléphone, et (optionnel) une clé Google Custom Search pour l'enrichissement auto des sites web — sinon le script se rabat sur l'enrichissement semi-manuel, ça marche aussi.
4. Exécute une fois la fonction **`setup()`** (bouton ▶) : elle crée les onglets, les en-têtes et les 3 triggers horaires. Autorise les permissions demandées (Sheets, Gmail, fetch externe).
5. Exécute une fois **`sourcerProspects()`** à la main pour vérifier : des lignes doivent apparaître dans `Prospects`.
6. Exécute **`enrichirEmails()`**, puis vérifie 2-3 emails trouvés.
7. **Mets `MODE_TEST: true`** (déjà le cas par défaut) : les emails du premier run sont envoyés **à toi-même**. Relis-les, ajuste les templates, puis passe `MODE_TEST: false`.
8. C'est parti. Ton seul rituel quotidien : ouvrir le Sheets, traiter les lignes vertes (`REPONDU`) et compléter les `A_ENRICHIR_MANUEL` (30 s chacune).
