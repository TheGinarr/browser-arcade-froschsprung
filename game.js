/* ============================================================
   FROSCHSPRUNG · game.js
   ------------------------------------------------------------
   SO FUNKTIONIERT DIESES SPIEL
   1. Raster: 13 x 13 Zellen. Von oben nach unten: Zielbuchten,
      5 Wasserbahnen, Mittelstreifen, 5 Straßenbahnen, Start.
      Welche Regeln in einer Zeile gelten, steht in zeilenArt().
   2. Reine Logik oben, Browser unten: Alles, was rechnet (Bahnen
      bewegen, Wrap-Around, Mitführen, Hitboxen, Plattform-Überlappung,
      Punkte), sind reine Funktionen ohne DOM. Sie sind exportiert,
      damit man sie in Node testen kann. Alles mit Canvas, Tastatur
      und HUD steckt in starteSpiel().
   3. Bahnen: Jede Bahn hat eine Richtung, ein Tempo und mehrere
      Objekte (Fahrzeuge, Stämme, Seerosenblätter). Sie laufen in einem
      Kreis ("Umlauf"): Wer rechts hinausfährt, kommt links wieder
      herein (Wrap-Around, siehe umlaufX()).
   4. SPIELGEFÜHL (das Herzstück dieser Version): Fünf Regeln sorgen
      dafür, dass sich Kollisionen fair anfühlen.
        a) Der Frosch hüpft weich: Seine Position wird über ~110 ms
           interpoliert, statt von Zelle zu Zelle zu springen.
           Eingaben während des Hüpfens landen in einem 1er-Puffer.
        b) In der Luft ist der Frosch sicher. Ob Auto oder Wasser, es
           wird erst NACH der Landung geprüft (froschUrteil).
        c) Fahrzeug-Hitboxen: Frosch und Fahrzeug werden als sichtbare
           Rechtecke betrachtet und beide um ~28 % verkleinert. Nur was
           optisch wirklich überlappt, tötet (autoKollision).
        d) Wasser: Der Frosch ist "auf der Plattform", wenn mindestens
           35 % seiner Breite auf Stamm oder Seerose liegen, nicht nur
           sein Mittelpunkt (findeTraeger). Bei der Landung rastet er
           auf der Plattform ein (einrasten), damit er nicht halb
           überhängt, und fährt dann exakt mit ihr mit.
        e) Nach dem Sterben läuft eine kurze Animation, nach dem Respawn
           ist der Frosch ~1 s gegen Fahrzeuge unverwundbar (blinkt).
   5. Zeitschritt: Die Spielschleife sammelt Zeit in einem
      Akkumulator und rechnet in festen Schritten von 1/60 Sekunde.
      So läuft das Spiel auf jedem Gerät gleich schnell. Gezeichnet
      wird mit einem kleinen Vorgriff auf den nächsten Schritt, damit
      Bewegungen auch auf 120/144-Hz-Bildschirmen glatt aussehen.
   6. Ende: Sind alle Leben weg, übernimmt gameOverDialog() aus ui.js
      (Initialen, Topliste, "Nochmal").
   ============================================================ */

import { topliste, spielZuruecksetzen } from "./assets/storage.js";
import { bewegungReduziert, gameOverDialog, toplisteAnzeigen, zahlHochzaehlen } from "./assets/ui.js";
import { spielSeite, text, TASTE, ansage } from "./assets/mobil.js";
import { levelWahl } from "./assets/levelwahl.js";

/* ---------- Konstanten (Stellschrauben des Spiels) ---------- */
const SPIEL = "froschsprung";          // Schlüssel für den Speicher (storage.js)
export const SPALTEN = 13;             // Raster: 13 Spalten ...
export const ZEILEN = 13;              // ... und 13 Zeilen
const ZELLE = 32;                      // Pixel pro Zelle -> Spielfeld 416 x 416
const FELDGROESSE = SPALTEN * ZELLE;
const PIXEL_SKALA = 2;                 // Canvas intern doppelt so fein: Naturgrafik bleibt scharf

export const START_SPALTE = 6;         // hier erscheint der Frosch (Mitte)
export const START_ZEILE = 12;         // unterste Zeile
export const BUCHT_SPALTEN = [2, 4, 6, 8, 10];   // Spalten der 5 Zielbuchten (Zeile 0)
// Wie weit darf die Frosch-Zelle neben der Buchtmitte liegen und trotzdem
// einrasten? Die Buchten sind 2 Zellen voneinander entfernt, 0,55 lässt also
// keine Zweideutigkeit zu, verzeiht aber knappe Sprünge.
export const BUCHT_TOLERANZ = 0.55;

const LEBEN_START = 3;
const PUNKTE_PRO_REIHE = 10;
const PUNKTE_PRO_BUCHT = 50;
const PUNKTE_RUNDENBONUS = 100;
const PUNKTE_FLIEGE = 200;             // Bonus für eine Bucht mit Fliege
const PUNKTE_PRO_SEKUNDE = 2;          // Restzeit-Bonus je Sekunde beim Erreichen einer Bucht

const HOP_DAUER = 0.11;                // Sekunden, die ein Sprung dauert (weiches Hüpfen)
const TOD_DAUER = 0.5;                 // Sekunden Sterbe-Animation
const SCHUTZ_DAUER = 1.0;              // Sekunden Unverwundbarkeit nach dem Respawn
const ZIEL_PAUSE = 0.45;               // kurze Pause nach einer besetzten Bucht
const RUNDEN_PAUSE = 1.4;              // etwas länger, wenn alle Buchten voll sind
const SCHRITT = 1 / 60;                // fester Zeitschritt der Logik in Sekunden
const MAX_FRAME_ABSTAND_MS = 250;      // siehe einzelbild()
const WISCH_SCHWELLE = 24;             // ab so vielen Pixeln zählt es als Wischen
const ZAEHLER_DAUER_MS = 300;          // Dauer des HUD-Hochzählens

/* ---------- Hitboxen und Fairness ----------
   Alles ist in ZELLEN angegeben (1 Zelle = 32 Pixel). Die "sichtbaren"
   Rechtecke entsprechen dem, was man auf dem Bildschirm sieht. Für die
   Kollision werden sie noch einmal verkleinert (SCHRUMPF). */
export const FROSCH_BREITE = 0.8;      // sichtbare Breite/Höhe des Frosches in Zellen
const FROSCH_RAND = (1 - FROSCH_BREITE) / 2;   // links/oben Luft in der Zelle: 0,1
export const SCHRUMPF = 0.28;          // Frosch UND Fahrzeug: je 28 % kleiner für die Kollision
const FAHRZEUG_RAND = 0.06;            // Fahrzeug ist 0,06 Zellen kürzer als sein Platz
const PLATTFORM_RAND = 0.04;           // Stämme/Seerosen ebenso (die Enden sind gerundet)
export const WASSER_MINDEST = 0.35;    // so viel Froschbreite muss auf der Plattform liegen
const RAND_TOLERANZ = 0.1;             // Frosch muss um so viel KOMPLETT aus dem Feld sein
const EPSILON = 1e-9;                  // Rundungsfehler bei Fließkomma-Vergleichen

// Endlos-Modus nach dem letzten festen Level: je Level etwas schneller.
const TEMPO_SCHRITT = 0.05;
const TEMPO_MAX = 1.8;                 // Deckel, sonst wird es unspielbar

// Schlange auf dem Mittelstreifen (in Zellen)
export const SCHLANGE_LAENGE = 1.6;
const SCHLANGE_TEMPO = 1.1;            // Zellen/s, wird mit dem Level-Tempo multipliziert
const SCHLANGE_HOEHE = 0.42;           // sichtbare Dicke quer zur Bahn

// Bonusfliege in den Buchten
const FLIEGE_DAUER = 5;                // Sekunden sichtbar
const FLIEGE_PAUSE = [5, 9];           // Sekunden bis zur nächsten (zufällig dazwischen)

// Krokodil: Kopfbereich am vorderen Ende (in Fahrtrichtung), in Zellen
export const KROKODIL_KOPF = 0.95;
export const KROKODIL_MAX_LAENGE = 4;

// Tauchzyklus der Seerosenblätter in Sekunden (siehe tauchSicht)
const TAUCH_ZYKLUS = 8;
const TAUCH_WARNUNG_AB = 4.5;          // ab hier wackelt und blubbert die Gruppe (trägt noch)
const TAUCH_UNTEN_AB = 5.7;            // ab hier ist sie unter Wasser (trägt nicht)
const TAUCH_OBEN_AB = 7.0;             // ab hier ist sie wieder oben (trägt wieder)
const TAUCH_SINK_DAUER = 0.25;         // optisches Absinken, nur für die Zeichnung
const TAUCH_AUF_DAUER = 0.25;          // optisches Auftauchen, nur für die Zeichnung

/* ============================================================
   TEIL 1: REINE LOGIK (ohne DOM, in Node testbar)
   ============================================================ */

/**
 * Welche Art Zeile ist y? Davon hängen fast alle Regeln ab:
 *   0        "ziel"           Hecke mit 5 Buchten
 *   1 bis 5  "wasser"         Stämme und Seerosenblätter
 *   6        "mittelstreifen" sicherer Rastplatz (Wiese)
 *   7 bis 11 "strasse"        Fahrzeuge
 *   12       "start"          sicherer Startstreifen (Wiese)
 */
export function zeilenArt(y) {
  if (y === 0) return "ziel";
  if (y >= 1 && y <= 5) return "wasser";
  if (y === 6) return "mittelstreifen";
  if (y >= 7 && y <= 11) return "strasse";
  return "start";
}

/**
 * WRAP-AROUND: Faltet die linke Kante `x` eines Objekts in den Bereich
 *      [ -laenge , umlauf - laenge )
 * Das ist ein Modulo mit Verschiebung. Der Bereich beginnt bei -laenge:
 * Dort ist das Objekt gerade ganz links aus dem Bild gelaufen. Am anderen
 * Ende (umlauf - laenge) steht es rechts vor dem Bild, solange
 * umlauf >= SPALTEN + laenge gilt. Läuft es über eine Grenze, springt es
 * auf die andere Seite, und zwar unsichtbar, weil es dort außerhalb des
 * Bildes ist.
 *
 * Das doppelte "% umlauf" ist Absicht: In JavaScript kann % negative
 * Ergebnisse liefern (-1 % 5 ergibt -1). Mit "+ umlauf" und einem
 * zweiten Modulo landet das Ergebnis immer in 0 .. umlauf.
 */
export function umlaufX(x, laenge, umlauf) {
  return (((x + laenge) % umlauf) + umlauf) % umlauf - laenge;
}

/**
 * Die Fahrzeugtypen. `laenge` ist der Platz in Zellen, `hoehe` die sichtbare
 * Breite quer zur Fahrtrichtung in Zellen. Weil beide in die Kollision
 * einfließen, gehören sie zur Logik und nicht zur Zeichnung.
 */
export const FAHRZEUG_TYPEN = {
  kleinwagen:  { laenge: 1.3, hoehe: 0.60 },
  limousine:   { laenge: 1.6, hoehe: 0.62 },
  sportwagen:  { laenge: 1.5, hoehe: 0.58 },
  lieferwagen: { laenge: 1.9, hoehe: 0.68 },
  lkw:         { laenge: 3.0, hoehe: 0.72 },   // Fahrerkabine + Planenanhänger
  tanker:      { laenge: 2.6, hoehe: 0.72 },   // Fahrerkabine + Tankauflieger
};

/**
 * Die Bahnen des Spiels (Schlüssel = Zeile).
 *   art:       "fahrzeug" | "stamm" | "seerose"
 *   richtung:  +1 = nach rechts, -1 = nach links
 *   tempo:     Zellen pro Sekunde (in Runde 1)
 *   laenge:    Breite eines Objekts in Zellen (bei Fahrzeugen: aus dem Typ)
 *   anzahl:    Objekte pro Bahn,  abstand: Abstand ihrer linken Kanten
 *   versatz:   Startverschiebung, damit nicht alle Bahnen "im Gleichschritt" starten
 *   taucht:    welche Objekte (Index) einer Seerosenbahn tauchen
 *   typen/farben/farben2: reihum an die Fahrzeuge verteilt (Index modulo Länge)
 *              farben = Karosserie bzw. Fahrerkabine, farben2 = Plane/Tank
 *
 * Merke: umlauf = anzahl * abstand muss >= SPALTEN + laenge sein
 * (siehe umlaufX). Der Test prüft das für jedes Objekt jeder Bahn.
 * Lkw und Tanker haben eigene Bahnen (7 und 10), Pkw und Lieferwagen mischen sich.
 */
const BAHN_DEFINITIONEN = {
  // --- Wasser (von oben nach unten: Zeile 1 liegt direkt unter den Buchten) ---
  1: { art: "stamm",   richtung: -1, tempo: 1.4, laenge: 3, anzahl: 3, abstand: 6,   versatz: 1.5 },
  2: { art: "seerose", richtung: +1, tempo: 1.9, laenge: 2, anzahl: 4, abstand: 4.5, versatz: 0.5, taucht: [0, 2] },
  3: { art: "stamm",   richtung: -1, tempo: 2.4, laenge: 6, anzahl: 2, abstand: 10,  versatz: 4 },
  4: { art: "stamm",   richtung: +1, tempo: 1.8, laenge: 4, anzahl: 2, abstand: 9,   versatz: 2 },
  5: { art: "seerose", richtung: -1, tempo: 1.5, laenge: 3, anzahl: 3, abstand: 5.5, versatz: 3, taucht: [0, 1, 2] },
  // --- Straße (Zeile 7 liegt direkt unter dem Mittelstreifen) ---
  7:  { art: "fahrzeug", richtung: +1, tempo: 2.6, anzahl: 2, abstand: 8,   versatz: 5,
        typen: ["lkw", "tanker"], farben: ["#c0392b", "#2e6fb7"], farben2: ["#d8d3c0", "#d9dde0"] },
  8:  { art: "fahrzeug", richtung: -1, tempo: 2.4, anzahl: 4, abstand: 4,   versatz: 1,
        typen: ["limousine", "kleinwagen"], farben: ["#2e6fb7", "#f2f2ee", "#c0392b", "#2b2e33"] },
  9:  { art: "fahrzeug", richtung: +1, tempo: 3.2, anzahl: 3, abstand: 5.5, versatz: 0.5,
        typen: ["sportwagen", "kleinwagen", "sportwagen"], farben: ["#e8b923", "#7a3b8f", "#c0392b"] },
  10: { art: "fahrzeug", richtung: -1, tempo: 1.8, anzahl: 2, abstand: 8.5, versatz: 3,
        typen: ["tanker", "lkw"], farben: ["#f2f2ee", "#2f8a57"], farben2: ["#e9e9e4", "#6f8fb8"] },
  11: { art: "fahrzeug", richtung: +1, tempo: 2.0, anzahl: 3, abstand: 5,   versatz: 2,
        typen: ["lieferwagen", "limousine", "kleinwagen"], farben: ["#f2f2ee", "#c9ced3", "#e07a1f"] },
};

/**
 * DIE 10 FESTEN LEVEL. Jedes Level übernimmt die Bahnen von oben und
 * ändert nur, was in `bahnen` steht (gleiche Schlüssel = Zeilen).
 *   tempo:    Faktor für alle Bahnen
 *   zeit:     Sekunden pro Frosch (Zeitbalken)
 *   fliege:   Bonusfliege in den Buchten
 *   schlange: Schlange auf dem Mittelstreifen
 *   nacht:    dunkleres Spielfeld
 *   bahnen:   { zeile: { …Änderungen } }, z. B. kürzere Stämme
 *             krokodile: [Index, …] macht diese Objekte zu Krokodilen
 * Nach Level 10 geht es endlos mit den Bahnen von Level 10 weiter,
 * jedes Level 5 % schneller (höchstens TEMPO_MAX).
 */
export const LEVEL = [
  { name: "Morgenrunde", tempo: 1.0, zeit: 45 },
  { name: "Feierabend", tempo: 1.08, zeit: 42,
    bahnen: { 8: { tempo: 2.8 }, 11: { tempo: 2.4 } } },
  { name: "Fliegenzeit", tempo: 1.12, zeit: 40, fliege: true },
  { name: "Schlange", tempo: 1.16, zeit: 40, fliege: true, schlange: true },
  { name: "Krokodile", tempo: 1.2, zeit: 38, fliege: true,
    bahnen: { 3: { krokodile: [1] }, 1: { krokodile: [2] } } },
  { name: "Kurze Stämme", tempo: 1.24, zeit: 36, fliege: true, schlange: true,
    bahnen: { 1: { laenge: 2 }, 4: { laenge: 3 } } },
  { name: "Tauchgang", tempo: 1.28, zeit: 36, fliege: true,
    bahnen: { 2: { taucht: [0, 1, 2, 3] }, 5: { taucht: [0, 1, 2] }, 3: { krokodile: [1] } } },
  { name: "Rush Hour", tempo: 1.34, zeit: 34, fliege: true, schlange: true,
    bahnen: { 7: { tempo: 3.0 }, 8: { tempo: 3.0 }, 9: { tempo: 3.8 }, 10: { tempo: 2.4 } } },
  { name: "Nachtfahrt", tempo: 1.4, zeit: 32, fliege: true, schlange: true, nacht: true,
    bahnen: { 3: { krokodile: [0, 1] }, 4: { krokodile: [1] } } },
  { name: "Meisterprüfung", tempo: 1.48, zeit: 30, fliege: true, schlange: true,
    bahnen: { 1: { laenge: 2 }, 2: { taucht: [0, 1, 2, 3] }, 3: { krokodile: [1] }, 4: { laenge: 3, krokodile: [0] } } },
];

/** Daten des Levels n (ab 11: Level 10, nur schneller und mit weniger Zeit). */
export function levelDaten(n) {
  if (n <= LEVEL.length) return LEVEL[n - 1];
  const letztes = LEVEL[LEVEL.length - 1];
  const extra = n - LEVEL.length;
  return {
    ...letztes,
    name: `${letztes.name} +${extra}`,
    tempo: Math.min(TEMPO_MAX, letztes.tempo + extra * TEMPO_SCHRITT),
    zeit: Math.max(22, letztes.zeit - extra),
  };
}

/** Baut aus den Definitionen die laufenden Bahnen des Levels (frische Kopien, nichts geteilt). */
export function neueBahnen(level = 1) {
  const bahnen = {};
  const aenderungen = levelDaten(level).bahnen ?? {};
  for (const [zeile, grund] of Object.entries(BAHN_DEFINITIONEN)) {
    const def = { ...grund, ...(aenderungen[zeile] ?? {}) };
    const objekte = [];
    for (let i = 0; i < def.anzahl; i++) {
      const typ = def.typen ? def.typen[i % def.typen.length] : null;
      const krokodil = Boolean(def.krokodile?.includes(i));
      objekte.push({
        x0: i * def.abstand,                          // Startposition der linken Kante
        // Jedes Objekt kennt seine eigene Länge: So können Fahrzeuge einer Bahn
        // verschieden lang sein (Limousine neben Kleinwagen).
        laenge: typ ? FAHRZEUG_TYPEN[typ].laenge : krokodil ? Math.min(def.laenge, KROKODIL_MAX_LAENGE) : def.laenge,
        krokodil,
        typ,
        farbe: def.farben ? def.farben[i % def.farben.length] : null,
        farbe2: def.farben2 ? def.farben2[i % def.farben2.length] : null,
        taucht: Boolean(def.taucht?.includes(i)),     // taucht dieses Objekt periodisch?
        tauchVersatz: i * 2.7,                        // eigene Phase, damit nie alle zugleich tauchen
      });
    }
    bahnen[zeile] = {
      ...def,
      zeile: Number(zeile),
      laenge: Math.max(...objekte.map((o) => o.laenge)),   // längstes Objekt der Bahn
      umlauf: def.anzahl * def.abstand,
      objekte,
      schub: def.versatz,
    };
  }
  return bahnen;
}

/** Geschwindigkeit einer Bahn in Zellen/Sekunde (mit Vorzeichen = Richtung). */
export function bahnGeschwindigkeit(bahn, faktor = 1) {
  return bahn.richtung * bahn.tempo * faktor;
}

/**
 * Schiebt eine Bahn um `dt` Sekunden weiter. Statt jedes Objekt einzeln zu
 * verschieben, wächst nur EIN Wert (`schub`) für die ganze Bahn. Die Position
 * jedes Objekts ergibt sich daraus (objektLinks). Das spart Rechenarbeit
 * und hält die Abstände auf ewig exakt gleich: Zahlenfehler können sich
 * nicht pro Objekt unterschiedlich aufsummieren.
 */
export function bahnBewegen(bahn, dt, faktor = 1) {
  bahn.schub = (bahn.schub + bahnGeschwindigkeit(bahn, faktor) * dt) % bahn.umlauf;
}

/** Länge des Objekts Nr. i in Zellen. */
export function objektLaenge(bahn, i) {
  return bahn.objekte[i].laenge;
}

/** Linke Kante des Objekts Nr. i in Zellen (mit Wrap-Around). */
export function objektLinks(bahn, i) {
  return umlaufX(bahn.objekte[i].x0 + bahn.schub, objektLaenge(bahn, i), bahn.umlauf);
}

/** Position im Tauchzyklus (0 bis TAUCH_ZYKLUS) für ein Objekt, mit eigener Phase. */
function zyklusZeit(zeit, objekt) {
  return (((zeit + objekt.tauchVersatz) % TAUCH_ZYKLUS) + TAUCH_ZYKLUS) % TAUCH_ZYKLUS;
}

/**
 * Zustand eines Seerosenblatts zum Zeitpunkt `zeit`. DAS ist die Wahrheit für
 * die Spiellogik:
 *   "oben"    trägt, normal gezeichnet
 *   "warnung" trägt noch, wackelt und blubbert (Vorwarnung)
 *   "unten"   komplett unter Wasser, trägt NICHT
 * Der Zyklus wiederholt sich alle TAUCH_ZYKLUS Sekunden. Jedes Objekt hat
 * einen eigenen Versatz, so tauchen die Gruppen nacheinander ab.
 */
export function tauchZustand(zeit, objekt) {
  if (!objekt.taucht) return "oben";
  const t = zyklusZeit(zeit, objekt);
  if (t >= TAUCH_UNTEN_AB && t < TAUCH_OBEN_AB) return "unten";
  if (t >= TAUCH_WARNUNG_AB && t < TAUCH_UNTEN_AB) return "warnung";
  return "oben";
}

/**
 * Für die ZEICHNUNG: Wie tief ist das Blatt gerade? `tiefe` läuft weich von
 * 0 (ganz oben) bis ~0,9 (unter Wasser) und wieder zurück. Der Zustand ist
 * derselbe wie bei tauchZustand, die Tiefe ist nur die Optik dazu. Die
 * Tiefe entscheidet nie über Leben und Tod (das tut allein der Zustand).
 */
export function tauchSicht(zeit, objekt) {
  if (!objekt.taucht) return { zustand: "oben", tiefe: 0, wackeln: false };
  const t = zyklusZeit(zeit, objekt);
  const zustand = tauchZustand(zeit, objekt);
  if (zustand === "warnung") {
    const p = (t - TAUCH_WARNUNG_AB) / (TAUCH_UNTEN_AB - TAUCH_WARNUNG_AB);
    return { zustand, tiefe: 0.35 * p, wackeln: true };
  }
  if (zustand === "unten") {
    const q = Math.min(1, (t - TAUCH_UNTEN_AB) / TAUCH_SINK_DAUER);
    return { zustand, tiefe: 0.35 + 0.55 * q, wackeln: false };
  }
  // "oben": direkt nach dem Auftauchen noch ein kurzes optisches Ausklingen
  const seitAuftauchen = t - TAUCH_OBEN_AB;
  if (seitAuftauchen >= 0 && seitAuftauchen < TAUCH_AUF_DAUER) {
    return { zustand, tiefe: 0.9 * (1 - seitAuftauchen / TAUCH_AUF_DAUER), wackeln: false };
  }
  return { zustand, tiefe: 0, wackeln: false };
}

/* ---------- Rechtecke und Überlappung ---------- */

/**
 * Das SICHTBARE Rechteck des Frosches in Zellkoordinaten. (x, y) ist die
 * linke obere Ecke der Frosch-ZELLE; der Frosch ist mit 0,8 Zellen etwas
 * schmaler als die Zelle und sitzt mittig darin.
 */
export function froschRechteck(x, y) {
  return {
    x1: x + FROSCH_RAND, x2: x + FROSCH_RAND + FROSCH_BREITE,
    y1: y + FROSCH_RAND, y2: y + FROSCH_RAND + FROSCH_BREITE,
  };
}

/**
 * Das SICHTBARE Rechteck von Fahrzeug Nr. i. Es ist an den Enden um
 * FAHRZEUG_RAND kürzer als der Platz und quer zur Fahrtrichtung genau
 * so hoch, wie der Typ es vorgibt (mittig in der Zeile).
 */
export function fahrzeugRechteck(bahn, i) {
  const links = objektLinks(bahn, i);
  const laenge = objektLaenge(bahn, i);
  const hoehe = FAHRZEUG_TYPEN[bahn.objekte[i].typ].hoehe;
  return {
    x1: links + FAHRZEUG_RAND, x2: links + laenge - FAHRZEUG_RAND,
    y1: bahn.zeile + (1 - hoehe) / 2, y2: bahn.zeile + (1 + hoehe) / 2,
  };
}

/**
 * Verkleinert ein Rechteck um `anteil` (0,28 = 28 %) seiner Breite und Höhe,
 * gleichmäßig von allen Seiten, die Mitte bleibt. Genau das macht den Unterschied
 * zwischen "Rechteck-Kollision" und "fühlt sich fair an": Wer nur mit dem
 * Zipfel der Grafik am Auto vorbeistreift, wird nicht getroffen.
 */
export function verkleinern(r, anteil) {
  const dx = (r.x2 - r.x1) * anteil / 2;
  const dy = (r.y2 - r.y1) * anteil / 2;
  return { x1: r.x1 + dx, x2: r.x2 - dx, y1: r.y1 + dy, y2: r.y2 - dy };
}

/**
 * Überschneiden sich zwei Rechtecke? Auf jeder Achse müssen sich die beiden
 * Strecken überlappen: a1 < b2 UND b1 < a2. Bei bloßer Berührung (gleiche
 * Kante) zählt es NICHT als Treffer, darum "<" statt "<=".
 */
export function rechteckeUeberlappen(a, b) {
  return a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
}

/**
 * Überschneidet die verkleinerte Frosch-Hitbox ein verkleinertes Fahrzeug
 * dieser Bahn? `froschY` ist die Zeile des Frosches (ganzzahlig, wenn er steht).
 */
export function autoKollision(bahn, froschX, froschY = bahn.zeile) {
  const frosch = verkleinern(froschRechteck(froschX, froschY), SCHRUMPF);
  for (let i = 0; i < bahn.objekte.length; i++) {
    const auto = verkleinern(fahrzeugRechteck(bahn, i), SCHRUMPF);
    if (rechteckeUeberlappen(frosch, auto)) return true;
  }
  return false;
}

/**
 * Wie viel der Frosch-BREITE (0 bis 1) liegt auf einer Plattform, die bei
 * `links` beginnt und `laenge` Zellen breit ist? Das ist die Überlappung zweier
 * Strecken: rechtes Minimum minus linkes Maximum, nie unter 0.
 */
export function plattformUeberlappung(froschX, links, laenge) {
  const f1 = froschX + FROSCH_RAND;
  const f2 = f1 + FROSCH_BREITE;
  const p1 = links + PLATTFORM_RAND;
  const p2 = links + laenge - PLATTFORM_RAND;
  const ueber = Math.min(f2, p2) - Math.max(f1, p1);
  return Math.max(0, ueber) / FROSCH_BREITE;
}

/**
 * Was trägt den Frosch? Gibt den Index des Objekts zurück, auf dem am meisten
 * vom Frosch liegt (mindestens WASSER_MINDEST seiner Breite), oder -1.
 * Früher zählte nur der Mittelpunkt: Wer mit 45 % seines Körpers auf dem Stamm
 * stand, ertrank trotzdem. Jetzt zählt die Fläche, das fühlt sich fair an.
 * Ein komplett untergetauchtes Seerosenblatt zählt nie als Untergrund. Eines,
 * das nur wackelt (Warnung), trägt noch.
 */
export function findeTraeger(bahn, froschX, zeit) {
  let bester = -1;
  let besteUeberlappung = 0;
  for (let i = 0; i < bahn.objekte.length; i++) {
    if (bahn.art === "seerose" && tauchZustand(zeit, bahn.objekte[i]) === "unten") continue;
    const anteil = plattformUeberlappung(froschX, objektLinks(bahn, i), objektLaenge(bahn, i));
    if (anteil >= WASSER_MINDEST - EPSILON && anteil > besteUeberlappung) {
      bester = i;
      besteUeberlappung = anteil;
    }
  }
  return bester;
}

/**
 * EINRASTEN: Verschiebt den Frosch so, dass er komplett auf der Plattform
 * liegt (sein sichtbares Rechteck innerhalb von [links, links + laenge]).
 * Ist er schon ganz drauf, ändert sich nichts. Ohne das hinge ein Frosch, der
 * mit 40 % gelandet ist, den Rest der Fahrt halb über dem Wasser.
 */
export function einrasten(links, laenge, froschX) {
  const kleinst = links + PLATTFORM_RAND - FROSCH_RAND;
  const groesst = links + laenge - PLATTFORM_RAND - FROSCH_RAND - FROSCH_BREITE;
  if (groesst < kleinst) return (kleinst + groesst) / 2;   // Plattform schmaler als der Frosch
  return Math.min(groesst, Math.max(kleinst, froschX));
}

/**
 * Landung im Wasser: Findet die Plattform und die Position, auf der der Frosch
 * nach dem Einrasten steht. Gibt {traeger, x} zurück oder null (kein Untergrund).
 */
export function landeAufPlattform(bahn, froschX, zeit) {
  const traeger = findeTraeger(bahn, froschX, zeit);
  if (traeger < 0) return null;
  return { traeger, x: einrasten(objektLinks(bahn, traeger), objektLaenge(bahn, traeger), froschX) };
}

/**
 * MITFÜHR-LOGIK: Wo ist der Frosch nach `dt` Sekunden?
 * Der Frosch hat keine eigene Geschwindigkeit. Trägt ihn ein Objekt, bekommt
 * er dessen Geschwindigkeit: neues x = altes x + Tempo * dt. Das ist exakt
 * dieselbe Zahl, um die sich die Plattform bewegt, der Frosch klebt also auf
 * den Subpixel genau am selben Fleck. Ohne Träger bleibt x unverändert (der
 * Frosch ertrinkt dann ohnehin, das prüft froschUrteil).
 * Wichtig: Aufruf VOR dem Bewegen der Bahn, sonst wäre die Prüfung
 * "was liegt unter mir" um einen Schritt verschoben.
 */
export function froschMitfuehren(bahn, froschX, faktor, dt, zeit) {
  if (findeTraeger(bahn, froschX, zeit) < 0) return froschX;
  return froschX + bahnGeschwindigkeit(bahn, faktor) * dt;
}

/**
 * Wurde der Frosch aus dem Feld geschoben? Erst wenn er KOMPLETT draußen ist
 * (sein ganzes sichtbares Rechteck, plus kleine Toleranz). Wer nur halb am
 * Rand hängt, lebt noch und kann wegspringen.
 */
export function ausserhalbFeld(froschX) {
  const r = froschRechteck(froschX, 0);
  return r.x2 < -RAND_TOLERANZ || r.x1 > SPALTEN + RAND_TOLERANZ;
}

/** Welche Bucht liegt unter x? Gibt den Index 0 bis 4 zurück oder -1 (Hecke). */
export function buchtFuerX(froschX) {
  for (let i = 0; i < BUCHT_SPALTEN.length; i++) {
    if (Math.abs(froschX - BUCHT_SPALTEN[i]) <= BUCHT_TOLERANZ) return i;
  }
  return -1;
}

/**
 * Das Urteil über eine Frosch-Position: lebt er weiter oder warum stirbt er?
 *   { art: "sicher", traeger }   alles gut (traeger = Index auf Wasserbahnen, sonst -1)
 *   { art: "auto" }              Fahrzeug getroffen
 *   { art: "wasser" }            kein Untergrund
 *   { art: "rand" }              aus dem Bild geschoben
 */
export function bewertePosition(bahnen, x, y, zeit, schlange = null) {
  const art = zeilenArt(y);
  if (art === "strasse") {
    return autoKollision(bahnen[y], x, y) ? { art: "auto" } : { art: "sicher", traeger: -1 };
  }
  if (art === "wasser") {
    if (ausserhalbFeld(x)) return { art: "rand" };
    const traeger = findeTraeger(bahnen[y], x, zeit);
    if (traeger < 0) return { art: "wasser" };
    if (bahnen[y].objekte[traeger].krokodil && aufKrokodilKopf(bahnen[y], traeger, x)) return { art: "krokodil" };
    return { art: "sicher", traeger };
  }
  if (art === "mittelstreifen" && schlange) {
    const frosch = verkleinern(froschRechteck(x, y), SCHRUMPF);
    if (rechteckeUeberlappen(frosch, verkleinern(schlangeRechteck(schlange), 0.15))) return { art: "schlange" };
  }
  return { art: "sicher", traeger: -1 };
}

/**
 * Das Urteil für den LAUFENDEN Frosch, mit allen Fairness-Regeln:
 *   - null: Es wird (noch) nicht geurteilt. Das gilt für einen toten Frosch
 *     und für einen Frosch IN DER LUFT (hopT < 1). Klassisches Frogger:
 *     Während des Sprungs kann nichts passieren, geprüft wird erst nach
 *     der Landung. Dadurch fühlt sich ein Sprung zwischen zwei Autos nie
 *     "geklaut" an.
 *   - Schutz (frosch.schutz > 0) gilt nur gegen Fahrzeuge. Im Wasser gibt
 *     es keinen Schutz, sonst könnte man über den Fluss laufen.
 * Sonst das normale Urteil von bewertePosition.
 */
export function froschUrteil(frosch, bahnen, zeit, schlange = null) {
  if (frosch.zustand !== "lebt") return null;
  if (frosch.hopT < 1) return null;
  const urteil = bewertePosition(bahnen, frosch.x, frosch.y, zeit, schlange);
  if ((urteil.art === "auto" || urteil.art === "schlange") && frosch.schutz > 0) return { art: "sicher", traeger: -1, geschuetzt: true };
  return urteil;
}

/**
 * Wohin springt der Frosch bei (dx, dy)? Gibt {x, y} zurück oder null,
 * wenn der Sprung nicht möglich ist (Feldrand).
 *
 * Auf festem Boden (Straße, Mittelstreifen, Start) wird x auf eine ganze
 * Zelle gerundet: Der Frosch "rastet ein". Im Wasser und beim Sprung in
 * die Buchten bleibt x unverändert, denn dort kann er auf einem Stamm
 * zwischen den Zellen stehen. Steht er im Wasser am Rand, hüpft er seitlich
 * nur noch bis zum Rand (statt gar nicht), sofern das mindestens eine
 * Viertelzelle ist.
 */
export function hopZiel(x, y, dx, dy) {
  const neuesY = y + dy;
  if (neuesY < 0 || neuesY >= ZEILEN) return null;
  let neuesX = x + dx;
  if (dx !== 0) {
    neuesX = Math.min(SPALTEN - 1, Math.max(0, neuesX));
    const echt = neuesX - x;                     // wie weit er wirklich käme
    if (echt * dx <= 0 || Math.abs(echt) < 0.25) return null;
  }
  const art = zeilenArt(neuesY);
  if (art !== "wasser" && art !== "ziel") {
    neuesX = Math.min(SPALTEN - 1, Math.max(0, Math.round(neuesX)));
  }
  return { x: neuesX, y: neuesY };
}

/**
 * Weiche Hüpf-Kurve: t läuft linear von 0 bis 1, das Ergebnis ebenfalls,
 * aber am Anfang und Ende langsamer ("smoothstep"). Der Frosch setzt also
 * sanft ab und landet sanft, statt linear zu rutschen.
 */
export function hopKurve(t) {
  const k = Math.min(1, Math.max(0, t));
  return k * k * (3 - 2 * k);
}

/**
 * PUNKTE FÜR NEUE REIHEN: `hoechsteReihe` ist die am weitesten oben erreichte
 * Zeile dieses Versuchs (Start: 12). Punkte gibt es nur, wenn y noch WEITER
 * oben liegt. Zurückhüpfen und wieder vorwärts bringt nichts, weil die
 * Reihen schon "abgehakt" sind. Sonst könnte man an einer sicheren Stelle
 * endlos auf und ab hüpfen und Punkte sammeln.
 */
export function reihenPunkte(y, hoechsteReihe) {
  if (y < hoechsteReihe) {
    return { punkte: (hoechsteReihe - y) * PUNKTE_PRO_REIHE, hoechsteReihe: y };
  }
  return { punkte: 0, hoechsteReihe };
}

/** Tempofaktor des Levels (steht in der LEVEL-Tabelle). */
export function tempoFaktor(level) {
  return levelDaten(level).tempo;
}

/* ---------- Krokodil und Schlange ---------- */

/**
 * Liegt die Froschmitte auf dem Kopf eines Krokodils? Der Kopf ist das
 * vordere Ende in Fahrtrichtung (KROKODIL_KOPF Zellen). Der Rücken trägt
 * wie ein Stamm, der Kopf nicht.
 */
export function aufKrokodilKopf(bahn, i, froschX) {
  const links = objektLinks(bahn, i);
  const laenge = objektLaenge(bahn, i);
  const mitte = froschX + 0.5;
  return bahn.richtung > 0
    ? mitte > links + laenge - KROKODIL_KOPF
    : mitte < links + KROKODIL_KOPF;
}

export function neueSchlange() {
  return { x: 1, richtung: 1 };
}

/** Schlange pendelt auf dem Mittelstreifen hin und her (prallt am Rand ab). */
export function schlangeSchritt(schlange, dt, faktor = 1) {
  schlange.x += schlange.richtung * SCHLANGE_TEMPO * faktor * dt;
  const max = SPALTEN - SCHLANGE_LAENGE;
  if (schlange.x < 0) { schlange.x = -schlange.x; schlange.richtung = 1; }
  if (schlange.x > max) { schlange.x = 2 * max - schlange.x; schlange.richtung = -1; }
}

export function schlangeRechteck(schlange) {
  return {
    x1: schlange.x, x2: schlange.x + SCHLANGE_LAENGE,
    y1: 6 + (1 - SCHLANGE_HOEHE) / 2, y2: 6 + (1 + SCHLANGE_HOEHE) / 2,
  };
}

/** Pseudozufall mit festem Startwert (Mulberry32): gleiche Eingabe, gleiche Folge. */
export function zufallsfolge(samen) {
  let zustand = samen >>> 0;
  return () => {
    zustand = (zustand + 0x6D2B79F5) >>> 0;
    let t = zustand;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ============================================================
   NATURFARBEN
   ------------------------------------------------------------
   Das Spielfeld soll natürlich aussehen (Gras, Asphalt, Wasser, Holz).
   Das Design-System der Seite (style.css) kennt nur Neonfarben und hat
   keine Naturtöne. Deshalb stehen die Farben hier fest im Code. Das ist
   eine bewusste Ausnahme: Alles, was zur Seite gehört (HUD, Dialoge,
   Banner-Text, Schriften), kommt weiter aus den CSS-Variablen.
   ============================================================ */
const NATUR = {
  gras: "#3f8c37", grasDunkel: "#2d6e2a", grasHell: "#68b350",
  sand: "#c4ae76", kiesel: "#8d8266",
  asphalt: "#3a3d42", asphaltHell: "#51555b", asphaltDunkel: "#2c2e32",
  randstein: "#8a8c87", markWeiss: "#f2f2ea", markGelb: "#f0c030",
  wasser: "#2c72ab", wasserTief: "#1f5a8f", wasserHell: "#5aa0d2",
  holz: "#8b5a2b", holzDunkel: "#573418", holzHell: "#b98350", holzEnde: "#d2a671",
  pad: "#3f9d3b", padDunkel: "#25702a", padHell: "#74c653",
  hecke: "#1d5524", heckeMittel: "#2a6e2e", heckeHell: "#3a8a3a", erde: "#4b3b25",
  schilf: "#8d9a3e", kolben: "#6b4423",
  frosch: "#4ba83c", froschDunkel: "#24692a", froschHell: "#93d35c",
};

/* ============================================================
   TEIL 2: DAS SPIEL IM BROWSER
   Alles ab hier braucht DOM und läuft in starteSpiel().
   ============================================================ */

function starteSpiel() {
  /* ---------- Elemente der Seite ---------- */
  const leinwand = document.getElementById("leinwand");
  // z ist absichtlich "let": Die Spielszene wird auf ein kleines Pixel-Canvas
  // gezeichnet (8-Bit-Raster), Texte danach in voller Auflösung auf das große.
  const hauptZ = leinwand.getContext("2d");
  let z = hauptZ;
  const PIXEL_RASTER = 0.5;             // 0,5 = 16 x 16 Pixel pro Zelle, wie bei 8-Bit-Konsolen
  const pixelLeinwand = document.createElement("canvas");
  pixelLeinwand.width = FELDGROESSE * PIXEL_RASTER;
  pixelLeinwand.height = FELDGROESSE * PIXEL_RASTER;
  const pixelZ = pixelLeinwand.getContext("2d");
  const hudPunkte = document.getElementById("hud-punkte");
  const hudLeben = document.getElementById("hud-leben");
  const hudLevel = document.getElementById("hud-level");
  const hudRekord = document.getElementById("hud-rekord");
  const toplisteBox = document.getElementById("topliste");
  const resetKnopf = document.getElementById("reset");

  // Das Canvas hat intern PIXEL_SKALA-mal so viele Pixel wie das logische Feld
  // (832 statt 416), CSS skaliert es auf die Anzeigegröße. Gezeichnet wird
  // weiter in 416er-Koordinaten, setTransform() in zeichneAlles() rechnet um.
  leinwand.width = FELDGROESSE * PIXEL_SKALA;
  leinwand.height = FELDGROESSE * PIXEL_SKALA;
  // Sonst würde der Browser beim Wischen die Seite scrollen.
  leinwand.style.touchAction = "none";

  /* ---------- Farben der Seite (UI) aus dem Design lesen ----------
     Nur für Texte auf dem Feld (Banner, Overlay, Rundenzahl). Die
     Naturfarben des Spielfelds stehen oben in NATUR. */
  const bodyStil = getComputedStyle(document.body);
  const lesFarbe = (name, notfall) => bodyStil.getPropertyValue(name).trim() || notfall;
  const farben = {
    hintergrund: lesFarbe("--bg", "#07070f"),
    text: lesFarbe("--txt", "#eef0ff"),
    gedaempft: lesFarbe("--mut", "#9aa0c6"),
    pink: lesFarbe("--pink", "#ff2d78"),
    lime: lesFarbe("--lime", "#9dff00"),
    schriftPixel: lesFarbe("--pixel", "monospace"),
    schriftText: lesFarbe("--sans", "sans-serif"),
  };

  /* ---------- Spielzustand ---------- */
  let bahnen;              // laufende Bahnen (neueBahnen)
  let frosch;              // Position, Animation, Zustand (siehe froschSetzen)
  let buchten;             // [true/false x 5]: welche Bucht ist besetzt?
  let punkte;
  let leben;
  let runde;
  let spielzeit;           // Sekunden seit Spielstart (für das Tauchen der Seerosen)
  let hoechsteReihe;       // am weitesten oben erreichte Zeile dieses Versuchs
  let phase;               // "bereit" | "laeuft" | "pause" | "vorbei"
  let bannerText = "";     // kurze Einblendung (z. B. "RUNDE 2")
  let bannerRest = 0;      // Sekunden, die sie noch zu sehen ist
  let buchtBlitz = [0, 0, 0, 0, 0];   // Aufleuchten frisch besetzter Buchten
  let rekordGespeichert = 0;
  let akkumulator = 0;     // angesammelte, noch nicht verrechnete Zeit in ms
  let letzteZeit = 0;
  let dialogGezeigt = false;
  let ruhigerModus = bewegungReduziert();   // wird jeden Frame aktualisiert
  let ringe = [];          // Deko: Wasserringe / Staubwolke beim Sterben
  let hintergrundBild = null;   // einmal vorgezeichnetes, unbewegtes Spielfeld
  let schlange = null;     // { x, richtung } oder null (nur in manchen Leveln)
  let fliege = null;       // { bucht, rest } oder null
  let fliegeTimer = 0;     // Sekunden bis zur nächsten Fliege
  let startLevel = 1;      // gewähltes Start-Level (Level-Auswahl)

  /* ============================================================
     HUD: weich hochzählende Anzeigen
     ============================================================ */

  /**
   * Wie bei Snake: zahlHochzaehlen() allein flackert, wenn zwei Änderungen
   * kurz hintereinander kommen (hier: +10 für die Reihe und +50 für die Bucht
   * im selben Moment). Die Closure merkt sich den neuesten Zielwert und
   * startet ihn erst, wenn die laufende Animation fertig ist.
   */
  function erzeugeZaehler(element) {
    let startZeit = -Infinity;
    let wartet = null;
    let ziel = 0;

    function setze(neuerWert) {
      ziel = neuerWert;
      const vergangen = performance.now() - startZeit;
      if (vergangen >= ZAEHLER_DAUER_MS) {
        startZeit = performance.now();
        zahlHochzaehlen(element, ziel, ZAEHLER_DAUER_MS);
      } else if (wartet === null) {
        wartet = setTimeout(() => {
          wartet = null;
          setze(ziel);
        }, ZAEHLER_DAUER_MS - vergangen + 20);
      }
    }

    function sofort(wert) {
      clearTimeout(wartet);
      wartet = null;
      startZeit = -Infinity;
      ziel = wert;
      element.textContent = wert;
    }

    return { setze, sofort };
  }

  const punkteZaehler = erzeugeZaehler(hudPunkte);
  const rekordZaehler = erzeugeZaehler(hudRekord);

  function toplisteAktualisieren() {
    const liste = topliste(SPIEL);
    rekordGespeichert = liste.length > 0 ? liste[0].punkte : 0;
    toplisteAnzeigen(toplisteBox, SPIEL, (p) => `${p} Punkte`);
  }

  /** Rekord "live": sobald die aktuellen Punkte ihn übertreffen, zieht er mit. */
  function rekordLive() {
    return Math.max(rekordGespeichert, punkte);
  }

  function rekordPulsen() {
    hudRekord.classList.remove("rekord-puls");
    void hudRekord.offsetWidth;   // erzwingt Neuberechnung, damit die Animation neu startet
    hudRekord.classList.add("rekord-puls");
    hudRekord.addEventListener("animationend", () => hudRekord.classList.remove("rekord-puls"), { once: true });
  }

  /** Punkte gutschreiben, HUD und Rekord nachziehen. */
  function punkteDazu(menge) {
    if (menge <= 0) return;
    const vorher = punkte;
    punkte += menge;
    punkteZaehler.setze(punkte);
    rekordZaehler.setze(rekordLive());
    // Puls nur im Moment des Überholens (bei Rekord 0 gibt es nichts zu überbieten)
    if (rekordGespeichert > 0 && punkte > rekordGespeichert && vorher <= rekordGespeichert && !ruhigerModus) {
      rekordPulsen();
    }
  }

  function lebenAnzeigen() {
    hudLeben.textContent = leben;
    if (hudLevel) hudLevel.textContent = runde;
  }

  /* ============================================================
     Spielablauf
     ============================================================ */

  /**
   * Neuer Frosch am Start. Wird nach jedem Leben und nach jeder Bucht gebraucht.
   *
   * Positionen: x, y sind die AKTUELLE Position in Zellen (Fließkomma), auch
   * mitten im Sprung. Der Sprung läuft von (vonX, vonY) nach (zielX, zielY)
   * und hopT ist sein Fortschritt von 0 bis 1 (1 = gelandet, Frosch steht).
   */
  function froschSetzen(mitSchutz) {
    frosch = {
      x: START_SPALTE, y: START_ZEILE,
      vonX: START_SPALTE, vonY: START_ZEILE,
      zielX: START_SPALTE, zielY: START_ZEILE,
      hopT: 1,
      hopMitX: 0,                            // Tempo des Trägers während eines Seitensprungs im Wasser
      landungAusstehend: false,              // muss nach dem Sprung noch gelandet (eingerastet) werden?
      blick: 0,                              // Blickwinkel in Radiant (0 = nach oben)
      zustand: "lebt",                       // "lebt" | "tot" | "ziel"
      zustandZeit: 0,                        // Sekunden im aktuellen Zustand
      todArt: null,                          // "auto" | "wasser" | "rand"
      alleVoll: false,                       // war das die letzte freie Bucht?
      stoss: 0,                              // kurzes Wackeln, wenn ein Sprung nicht geht
      puffer: null,                          // vorgemerkter Sprung (siehe sprungEingabe)
      schutz: mitSchutz ? SCHUTZ_DAUER : 0,  // Sekunden Unverwundbarkeit gegen Fahrzeuge
      einrastVersatz: 0,                     // nur Optik: Rest des Einrastens, klingt ab
      fahrtV: 0,                             // Tempo des Trägers in Zellen/s (für glatte Zeichnung)
      traeger: -1,                           // Index des Trägers auf der Wasserbahn (-1 = keiner)
      zeit: levelDaten(runde).zeit,          // Restzeit für diesen Frosch (Zeitbalken)
    };
    // Neuer Versuch = Reihenzähler zurück auf die Startzeile. Sonst gäbe es
    // nach dem Sterben keine Punkte mehr für bereits erreichte Reihen.
    hoechsteReihe = START_ZEILE;
  }

  /** Bahnen, Schlange und Fliege für das aktuelle Level aufbauen. */
  function levelAufbauen() {
    const daten = levelDaten(runde);
    bahnen = neueBahnen(runde);
    schlange = daten.schlange ? neueSchlange() : null;
    fliege = null;
    fliegeTimer = FLIEGE_PAUSE[0];
    wahl.erreicht(runde);
    wahl.aktiv(runde);
    if (hudLevel) hudLevel.textContent = runde;
  }

  function neuesSpiel(ab = startLevel) {
    startLevel = ab;
    buchten = [false, false, false, false, false];
    buchtBlitz = [0, 0, 0, 0, 0];
    punkte = 0;
    leben = LEBEN_START;
    runde = ab;
    levelAufbauen();
    spielzeit = 0;
    bannerRest = 0;
    ringe = [];
    akkumulator = 0;
    dialogGezeigt = false;
    phase = "bereit";
    froschSetzen(false);

    // Der Dialog des letzten Spiels hat eventuell einen neuen Eintrag gespeichert.
    toplisteAktualisieren();
    punkteZaehler.sofort(0);
    rekordZaehler.sofort(rekordGespeichert);
    lebenAnzeigen();
  }

  /** Verliert der Frosch ein Leben: Zustand "tot", Animation läuft in schritt(). */
  function sterben(art) {
    leben -= 1;
    lebenAnzeigen();
    frosch.zustand = "tot";
    frosch.zustandZeit = 0;
    frosch.todArt = art;
    frosch.puffer = null;
    frosch.fahrtV = 0;
    frosch.einrastVersatz = 0;
    if (!ruhigerModus) {
      // Wasserringe beim Ertrinken, eine Staubwolke beim Überfahrenwerden. Reine Deko.
      ringe.push({
        x: (frosch.x + 0.5) * ZELLE, y: (frosch.y + 0.5) * ZELLE, alter: 0,
        farbe: art === "auto" ? "#e6dcb4" : "#ffffff",
      });
    }
  }

  /**
   * Startet einen Sprung. r = {dx, dy}.
   *
   * Der Frosch bleibt nicht mehr "logisch" sofort im Ziel: Seine Position x/y
   * wird in schritt() über HOP_DAUER Sekunden von (vonX, vonY) nach
   * (zielX, zielY) geschoben, und zwar auch für die Logik. Während dieser
   * Zeit (hopT < 1) ist der Frosch in der Luft und sicher (froschUrteil).
   */
  function hoppen(r) {
    // Blickrichtung auch dann drehen, wenn der Sprung nicht geht.
    frosch.blick = r.dy < 0 ? 0 : r.dy > 0 ? Math.PI : r.dx > 0 ? Math.PI / 2 : -Math.PI / 2;

    const ziel = hopZiel(frosch.x, frosch.y, r.dx, r.dy);
    if (!ziel) { frosch.stoss = 0.2; return; }          // Feldrand: stehen bleiben

    // Zeile 0: Nur eine FREIE Bucht lässt den Frosch ein. Hecke oder
    // besetzte Bucht = Sprung wird verweigert (er bleibt unten stehen).
    let bucht = -1;
    if (ziel.y === 0) {
      bucht = buchtFuerX(ziel.x);
      if (bucht < 0 || buchten[bucht]) { frosch.stoss = 0.2; return; }
      ziel.x = BUCHT_SPALTEN[bucht];                    // mittig in die Bucht
    }

    // Seitensprung auf einem Stamm: Start- und Zielpunkt wandern während des
    // Sprungs mit dem Träger mit. So hüpft der Frosch genau eine Zelle weit AUF
    // dem Stamm, nicht eine Zelle über das fahrende Wasser.
    frosch.hopMitX = 0;
    if (r.dy === 0 && zeilenArt(frosch.y) === "wasser" &&
        findeTraeger(bahnen[frosch.y], frosch.x, spielzeit) >= 0) {
      frosch.hopMitX = bahnGeschwindigkeit(bahnen[frosch.y], tempoFaktor(runde));
    }

    frosch.vonX = frosch.x;
    frosch.vonY = frosch.y;
    frosch.zielX = ziel.x;
    frosch.zielY = ziel.y;
    frosch.hopT = 0;
    frosch.landungAusstehend = bucht < 0;
    frosch.fahrtV = 0;

    // Bei "Bewegung reduzieren" gibt es keine Animation: Der Frosch steht sofort
    // im Ziel. Die Landung (Einrasten, Urteil) läuft trotzdem im nächsten Schritt.
    if (ruhigerModus) {
      frosch.x = frosch.zielX;
      frosch.y = frosch.zielY;
      frosch.hopT = 1;
      frosch.hopMitX = 0;
    }

    // Punkte nur für Reihen, die in diesem Versuch noch nie erreicht wurden.
    const reihe = reihenPunkte(ziel.y, hoechsteReihe);
    hoechsteReihe = reihe.hoechsteReihe;
    punkteDazu(reihe.punkte);

    if (bucht >= 0) {
      buchten[bucht] = true;
      buchtBlitz[bucht] = 1;
      punkteDazu(PUNKTE_PRO_BUCHT + Math.floor(frosch.zeit) * PUNKTE_PRO_SEKUNDE);
      if (fliege && fliege.bucht === bucht) {
        punkteDazu(PUNKTE_FLIEGE);
        bannerText = `FLIEGE! +${PUNKTE_FLIEGE}`;
        bannerRest = 1.2;
        fliege = null;
      }
      frosch.zustand = "ziel";
      frosch.zustandZeit = 0;
      frosch.alleVoll = buchten.every(Boolean);
      if (frosch.alleVoll) {
        punkteDazu(PUNKTE_RUNDENBONUS);
        bannerText = "BUCHTEN VOLL! +100";
        bannerRest = RUNDEN_PAUSE;
      }
    }
  }

  /**
   * Nimmt einen Sprungwunsch entgegen. Läuft gerade ein Sprung, kommt der
   * Wunsch in einen 1er-PUFFER und wird direkt nach der Landung ausgeführt.
   * Es wird immer nur der NEUESTE Wunsch behalten: So fühlt sich schnelles
   * Tippen flüssig an (nichts wird verschluckt), ohne dass sich lange Ketten
   * aufstauen, die der Spieler gar nicht mehr überblickt.
   */
  function sprungEingabe(r) {
    if (frosch.zustand !== "lebt") return;
    if (frosch.hopT < 1 || frosch.landungAusstehend) frosch.puffer = r;
    else hoppen(r);
  }

  /**
   * Die Landung nach einem Sprung. Im Wasser rastet der Frosch auf der
   * Plattform ein (landeAufPlattform). Die Distanz merken wir uns als
   * einrastVersatz, der in schritt() abklingt: Die Logik steht sofort
   * richtig, die Zeichnung gleitet in ~40 ms an die neue Stelle.
   */
  function landen() {
    frosch.landungAusstehend = false;
    if (zeilenArt(frosch.y) !== "wasser") return;
    const landung = landeAufPlattform(bahnen[frosch.y], frosch.x, spielzeit);
    if (landung) {
      frosch.einrastVersatz += ruhigerModus ? 0 : frosch.x - landung.x;
      frosch.x = landung.x;
    }
  }

  /**
   * Ein fester Logik-Schritt von `dt` Sekunden (hier immer SCHRITT).
   * Reihenfolge ist wichtig:
   *   1. Stehender Frosch auf dem Wasser: mitführen (Positionen VOR der Bewegung)
   *   2. Bahnen bewegen
   *   3. Sprung weiterschieben (Interpolation), bei Ende: landen
   *   4. Urteil (nur wenn gelandet), dann vorgemerkten Sprung ausführen
   */
  function schritt(dt) {
    spielzeit += dt;
    bannerRest = Math.max(0, bannerRest - dt);
    const faktor = tempoFaktor(runde);
    const lebt = frosch.zustand === "lebt";

    // 1. Mitführen. Nur ein STEHENDER Frosch wird getragen (in der Luft nicht).
    frosch.fahrtV = 0;
    if (lebt && frosch.hopT >= 1 && zeilenArt(frosch.y) === "wasser") {
      const bahn = bahnen[frosch.y];
      const neuesX = froschMitfuehren(bahn, frosch.x, faktor, dt, spielzeit);
      if (neuesX !== frosch.x) frosch.fahrtV = bahnGeschwindigkeit(bahn, faktor);
      frosch.x = neuesX;
    }

    // 2. Bahnen bewegen (und die Schlange, falls es eine gibt)
    for (const bahn of Object.values(bahnen)) bahnBewegen(bahn, dt, faktor);
    if (schlange) schlangeSchritt(schlange, dt, faktor);

    // Bonusfliege: taucht in einer freien Bucht auf und verschwindet wieder
    if (levelDaten(runde).fliege) {
      if (fliege) {
        fliege.rest -= dt;
        if (fliege.rest <= 0) { fliege = null; fliegeTimer = FLIEGE_PAUSE[0] + Math.random() * (FLIEGE_PAUSE[1] - FLIEGE_PAUSE[0]); }
      } else {
        fliegeTimer -= dt;
        const frei = buchten.map((voll, i) => (voll ? -1 : i)).filter((i) => i >= 0);
        if (fliegeTimer <= 0 && frei.length > 0) fliege = { bucht: frei[Math.floor(Math.random() * frei.length)], rest: FLIEGE_DAUER };
      }
    }

    // 3. Sprung-Interpolation: Position = von + (ziel - von) * Kurve(t)
    if (frosch.hopT < 1) {
      frosch.hopT = Math.min(1, frosch.hopT + dt / HOP_DAUER);
      frosch.vonX += frosch.hopMitX * dt;
      frosch.zielX += frosch.hopMitX * dt;
      const k = hopKurve(frosch.hopT);
      frosch.x = frosch.vonX + (frosch.zielX - frosch.vonX) * k;
      frosch.y = frosch.vonY + (frosch.zielY - frosch.vonY) * k;
      if (frosch.hopT >= 1) {            // exakt im Ziel enden, keine Rundungsreste
        frosch.x = frosch.zielX;
        frosch.y = frosch.zielY;
      }
    }

    // Weitere Animationen vorrücken
    frosch.stoss = Math.max(0, frosch.stoss - dt);
    frosch.einrastVersatz -= frosch.einrastVersatz * Math.min(1, dt * 25);
    if (Math.abs(frosch.einrastVersatz) < 0.001) frosch.einrastVersatz = 0;
    for (let i = 0; i < buchtBlitz.length; i++) buchtBlitz[i] = Math.max(0, buchtBlitz[i] - dt * 1.6);
    for (const ring of ringe) ring.alter += dt;
    ringe = ringe.filter((ring) => ring.alter < 0.8);

    if (frosch.zustand === "lebt") {
      frosch.schutz = Math.max(0, frosch.schutz - dt);
      // Zeitbalken: läuft nur, solange der Frosch unterwegs ist
      frosch.zeit = Math.max(0, frosch.zeit - dt);
      if (frosch.zeit <= 0 && frosch.hopT >= 1) { sterben("zeit"); return; }
      // 4. Gelandet? Dann einrasten und urteilen. Erst danach darf der
      // vorgemerkte Sprung starten: Wer die Landung nicht überlebt, hüpft nicht weiter.
      if (frosch.hopT >= 1 && frosch.landungAusstehend) landen();
      const urteil = froschUrteil(frosch, bahnen, spielzeit, schlange);
      if (urteil) {
        frosch.traeger = urteil.traeger ?? -1;
        if (urteil.art !== "sicher") sterben(urteil.art);
      }
      if (frosch.zustand === "lebt" && frosch.hopT >= 1 && frosch.puffer) {
        const r = frosch.puffer;
        frosch.puffer = null;
        hoppen(r);
      }
    } else if (frosch.zustand === "tot") {
      frosch.zustandZeit += dt;
      if (frosch.zustandZeit >= TOD_DAUER) {
        if (leben <= 0) phase = "vorbei";
        else froschSetzen(true);
      }
    } else if (frosch.zustand === "ziel") {
      frosch.zustandZeit += dt;
      if (frosch.zustandZeit >= (frosch.alleVoll ? RUNDEN_PAUSE : ZIEL_PAUSE)) {
        if (frosch.alleVoll) {
          // Nächstes Level: Buchten leeren, neue Bahnen, etwas schneller.
          buchten = [false, false, false, false, false];
          runde += 1;
          levelAufbauen();
          bannerText = `LEVEL ${runde} · ${levelDaten(runde).name.toUpperCase()}`;
          bannerRest = 1.8;
          ansage(`Level ${runde}: ${levelDaten(runde).name}`);
        }
        froschSetzen(true);
      }
    }
  }

  function dialogAnzeigen() {
    if (dialogGezeigt) return;
    dialogGezeigt = true;
    const dialog = gameOverDialog({
      spiel: SPIEL,
      titel: "GAME OVER",
      punkte,
      punkteText: `${punkte} Punkte`,
      richtung: "hoch",          // MEHR Punkte sind besser
      format: (p) => `${p} Punkte`,
      neustart: () => neuesSpiel(startLevel),
    });
    // Auch beim Schließen mit Esc soll die Topliste auf der Seite stimmen.
    dialog.addEventListener("close", () => {
      toplisteAktualisieren();
      rekordZaehler.sofort(rekordLive());
    });
  }

  /* ---------- Start / Pause ---------- */

  function spielStarten() {
    phase = "laeuft";
    akkumulator = 0;
  }

  function pauseUmschalten() {
    if (phase === "laeuft") phase = "pause";
    else if (phase === "pause") phase = "laeuft";
  }

  function bestaetigen() {
    if (phase === "bereit") spielStarten();
    else if (phase === "pause") phase = "laeuft";
    else if (phase === "vorbei" && dialogGezeigt && !document.getElementById("spiel-dialog")) neuesSpiel(startLevel);
  }

  /** Gemeinsame Sprung-Eingabe für Tastatur und Wischen. */
  function richtungsEingabe(r) {
    if (phase === "bereit") {
      spielStarten();               // die erste Taste startet UND hüpft
      sprungEingabe(r);
    } else if (phase === "pause") {
      phase = "laeuft";
      sprungEingabe(r);
    } else if (phase === "laeuft") {
      sprungEingabe(r);
    } else {
      bestaetigen();
    }
  }

  /* ============================================================
     Eingabe: Tastatur
     ============================================================ */
  const TASTEN = {
    arrowup: { dx: 0, dy: -1 }, w: { dx: 0, dy: -1 },
    arrowdown: { dx: 0, dy: 1 }, s: { dx: 0, dy: 1 },
    arrowleft: { dx: -1, dy: 0 }, a: { dx: -1, dy: 0 },
    arrowright: { dx: 1, dy: 0 }, d: { dx: 1, dy: 0 },
  };

  document.addEventListener("keydown", (ereignis) => {
    if (ereignis.ctrlKey || ereignis.metaKey || ereignis.altKey) return;
    // Offener Dialog: Dort tippt man Initialen, WASD darf nichts steuern.
    if (document.getElementById("spiel-dialog")) return;
    const ziel = ereignis.target;
    if (ziel instanceof HTMLElement && ziel.matches("input, textarea, select")) return;

    const taste = ereignis.key.toLowerCase();
    if (taste === "p") {
      if (phase === "laeuft" || phase === "pause") pauseUmschalten();
      return;
    }
    const r = TASTEN[taste];
    const istStartTaste = taste === " " || taste === "enter";
    if (!r && !istStartTaste) return;
    // Leertaste/Enter auf Knopf, Link oder Zusammenklapp-Titel bedient weiter diesen.
    if (istStartTaste && ziel instanceof HTMLElement && ziel.matches("button, a, summary")) return;

    ereignis.preventDefault();             // Pfeile und Leertaste würden sonst scrollen
    // Gehaltene Taste (Auto-Repeat) hüpft nicht endlos weiter: Jeder Sprung
    // soll eine bewusste Entscheidung sein, sonst läuft man ungewollt ins Auto.
    if (ereignis.repeat) return;
    if (r) richtungsEingabe(r);
    else bestaetigen();
  });

  /* ============================================================
     Eingabe: Wischen und Tippen (Pointer Events)
     ============================================================ */
  let wischStart = null;       // Punkt, ab dem die aktuelle Geste gemessen wird
  let hatGewischt = false;     // war die Geste ein Wischen (sonst: ein Tippen)?

  leinwand.addEventListener("pointerdown", (ereignis) => {
    wischStart = { x: ereignis.clientX, y: ereignis.clientY };
    hatGewischt = false;
    try { leinwand.setPointerCapture(ereignis.pointerId); } catch { /* egal */ }
  });

  leinwand.addEventListener("pointermove", (ereignis) => {
    if (!wischStart || hatGewischt) return;          // pro Geste genau EIN Sprung
    const dx = ereignis.clientX - wischStart.x;
    const dy = ereignis.clientY - wischStart.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < WISCH_SCHWELLE) return;
    // Die Achse mit der größeren Bewegung gewinnt.
    const r = Math.abs(dx) > Math.abs(dy)
      ? { dx: dx > 0 ? 1 : -1, dy: 0 }
      : { dx: 0, dy: dy > 0 ? 1 : -1 };
    hatGewischt = true;
    richtungsEingabe(r);
  });

  leinwand.addEventListener("pointerup", () => {
    // Ein Tippen (kein Wischen): im Spiel ein Sprung nach vorn,
    // sonst starten bzw. fortsetzen.
    if (wischStart && !hatGewischt) {
      if (phase === "laeuft") sprungEingabe({ dx: 0, dy: -1 });
      else bestaetigen();
    }
    wischStart = null;
  });
  leinwand.addEventListener("pointercancel", () => { wischStart = null; });

  // Tab-Wechsel pausiert, sonst würde der Frosch im Hintergrund überfahren.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && phase === "laeuft") phase = "pause";
  });

  resetKnopf.addEventListener("click", () => {
    spielZuruecksetzen(SPIEL);
    toplisteAktualisieren();
    wahl.neuLaden();
    rekordZaehler.sofort(rekordLive());
    if (phase === "laeuft") phase = "pause";
    resetKnopf.blur();                     // damit die nächste Leertaste nicht den Knopf drückt
  });

  /* ============================================================
     Hauptschleife
     ============================================================ */

  /**
   * Pro Bildschirm-Frame einmal. Muster "Akkumulator mit festem Zeitschritt"
   * (ausführlich bei Snake erklärt): Die vergangene Zeit wandert in ein
   * Sparschwein, und für jede volle 1/60 Sekunde läuft ein Logik-Schritt.
   * Ein 144-Hz-Monitor und ein langsamer Laptop sehen dadurch dasselbe Spiel.
   *
   * Was nach der Schleife im Sparschwein bleibt (weniger als ein Schritt), ist
   * der "Vorgriff": Die Zeichnung schiebt Fahrzeuge, Stämme und den getragenen
   * Frosch um genau diese Restzeit weiter. Das glättet die Bewegung, ohne die
   * Logik anzufassen.
   */
  function einzelbild(jetzt) {
    const abstand = Math.min(jetzt - letzteZeit, MAX_FRAME_ABSTAND_MS);
    letzteZeit = jetzt;
    ruhigerModus = bewegungReduziert();

    if (phase === "laeuft") {
      akkumulator += abstand;
      const schrittMs = SCHRITT * 1000;
      while (phase === "laeuft" && akkumulator >= schrittMs) {
        akkumulator -= schrittMs;
        schritt(SCHRITT);
      }
    }

    if (phase === "vorbei" && !dialogGezeigt) dialogAnzeigen();

    zeichneAlles(jetzt, phase === "laeuft" ? akkumulator / 1000 : 0);
    requestAnimationFrame(einzelbild);
  }

  /* ============================================================
     Zeichnen: Hilfsfunktionen
     ============================================================ */

  /** Pfad eines (abgerundeten) Rechtecks auf dem Kontext c. */
  function rundesRechteck(c, x, y, breite, hoehe, radius) {
    c.beginPath();
    if (c.roundRect) c.roundRect(x, y, breite, hoehe, radius);
    else c.rect(x, y, breite, hoehe);
  }

  function ellipse(c, x, y, rx, ry, drehung = 0) {
    c.beginPath();
    c.ellipse(x, y, rx, ry, drehung, 0, Math.PI * 2);
  }

  function mix(a, b, t) {
    return a + (b - a) * t;
  }

  /* ============================================================
     Zeichnen: das unbewegte Spielfeld (einmal vorzeichnen)
     ------------------------------------------------------------
     Gras, Asphalt, Wasser und Hecke ändern sich nie. Sie werden
     einmal auf ein unsichtbares Zweit-Canvas gemalt und pro Frame
     nur als EIN Bild kopiert. Der Pseudozufall mit festem Startwert
     sorgt dafür, dass die Textur bei jedem Start gleich aussieht.
     ============================================================ */

  function zeichneWiese(b, reihe, zufall) {
    const y0 = reihe * ZELLE;
    b.fillStyle = NATUR.gras;
    b.fillRect(0, y0, FELDGROESSE, ZELLE);
    // Mähstreifen: jede zweite Spalte minimal heller
    b.fillStyle = "rgba(255,255,255,0.045)";
    for (let s = 0; s < SPALTEN; s += 2) b.fillRect(s * ZELLE, y0, ZELLE, ZELLE);
    // Grashalme: kurze Striche in zwei Grüntönen
    b.lineWidth = 1;
    for (let k = 0; k < 190; k++) {
      const x = zufall() * FELDGROESSE;
      const y = y0 + 3 + zufall() * (ZELLE - 3);
      b.strokeStyle = zufall() < 0.5 ? NATUR.grasDunkel : NATUR.grasHell;
      b.beginPath();
      b.moveTo(x, y);
      b.lineTo(x + (zufall() - 0.5) * 3, y - 2 - zufall() * 3);
      b.stroke();
    }
    // hellere Tupfen
    b.fillStyle = "rgba(140,210,100,0.35)";
    for (let k = 0; k < 40; k++) {
      ellipse(b, zufall() * FELDGROESSE, y0 + zufall() * ZELLE, 1 + zufall() * 1.6, 0.8 + zufall());
      b.fill();
    }
    // ein paar Gänseblümchen
    for (let k = 0; k < 5; k++) {
      const x = 10 + zufall() * (FELDGROESSE - 20);
      const y = y0 + 8 + zufall() * (ZELLE - 16);
      b.fillStyle = "#f6f6ef";
      b.beginPath(); b.arc(x, y, 1.6, 0, Math.PI * 2); b.fill();
      b.fillStyle = "#f0c030";
      b.beginPath(); b.arc(x, y, 0.7, 0, Math.PI * 2); b.fill();
    }
  }

  /** Sandiges Ufer am oberen Rand des Mittelstreifens (dort beginnt der Fluss). */
  function zeichneUfer(b, zufall) {
    const y0 = 6 * ZELLE;
    b.fillStyle = NATUR.sand;
    b.beginPath();
    b.moveTo(0, y0);
    for (let x = 0; x <= FELDGROESSE; x += 8) b.lineTo(x, y0 + 3.5 + Math.sin(x * 0.13) * 1.4 + zufall() * 1.2);
    b.lineTo(FELDGROESSE, y0);
    b.closePath();
    b.fill();
    b.fillStyle = "rgba(60,40,10,0.18)";                 // feuchter Saum zum Wasser hin
    b.fillRect(0, y0, FELDGROESSE, 1.5);
    for (let k = 0; k < 34; k++) {                       // Kieselsteine
      b.fillStyle = zufall() < 0.5 ? NATUR.kiesel : "#b3a98a";
      ellipse(b, zufall() * FELDGROESSE, y0 + 1.5 + zufall() * 3.5, 0.9 + zufall() * 1.3, 0.7 + zufall() * 0.7);
      b.fill();
    }
  }

  function zeichneStrasse(b, zufall) {
    const y0 = 7 * ZELLE;
    const hoehe = 5 * ZELLE;
    // Asphalt mit feinem Korn
    b.fillStyle = NATUR.asphalt;
    b.fillRect(0, y0, FELDGROESSE, hoehe);
    for (let k = 0; k < 1400; k++) {
      b.fillStyle = zufall() < 0.5 ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0.16)";
      b.fillRect(zufall() * FELDGROESSE, y0 + zufall() * hoehe, 1 + (zufall() < 0.2 ? 1 : 0), 1);
    }
    // Reifenspuren: zwei dunklere Bänder pro Spur
    b.fillStyle = "rgba(0,0,0,0.09)";
    for (let reihe = 7; reihe <= 11; reihe++) {
      b.fillRect(0, reihe * ZELLE + 8, FELDGROESSE, 5);
      b.fillRect(0, reihe * ZELLE + 19, FELDGROESSE, 5);
    }
    // Randstreifen (Bordstein) und durchgezogene weiße Randlinien
    b.fillStyle = NATUR.randstein;
    b.fillRect(0, y0, FELDGROESSE, 3);
    b.fillRect(0, y0 + hoehe - 3, FELDGROESSE, 3);
    b.fillStyle = "rgba(0,0,0,0.25)";
    b.fillRect(0, y0 + 3, FELDGROESSE, 1);
    b.fillRect(0, y0 + hoehe - 4, FELDGROESSE, 1);
    b.fillStyle = NATUR.markWeiss;
    b.fillRect(0, y0 + 5, FELDGROESSE, 2);
    b.fillRect(0, y0 + hoehe - 7, FELDGROESSE, 2);
    // Gestrichelte Markierungen zwischen den Spuren, abwechselnd weiß und gelb
    b.lineWidth = 2;
    b.setLineDash([14, 12]);
    for (let reihe = 8; reihe <= 11; reihe++) {
      b.strokeStyle = reihe % 2 === 0 ? NATUR.markWeiss : NATUR.markGelb;
      b.globalAlpha = 0.92;
      b.beginPath();
      b.moveTo(reihe % 2 === 0 ? 4 : 11, reihe * ZELLE);
      b.lineTo(FELDGROESSE, reihe * ZELLE);
      b.stroke();
    }
    b.setLineDash([]);
    b.globalAlpha = 1;
  }

  function zeichneFluss(b, zufall) {
    const y0 = ZELLE;
    const hoehe = 5 * ZELLE;
    const verlauf = b.createLinearGradient(0, y0, 0, y0 + hoehe);
    verlauf.addColorStop(0, NATUR.wasserTief);
    verlauf.addColorStop(0.5, NATUR.wasser);
    verlauf.addColorStop(1, "#2f78b0");
    b.fillStyle = verlauf;
    b.fillRect(0, y0, FELDGROESSE, hoehe);
    // weiche Flecken in Hell und Dunkel: Tiefe im Wasser
    for (let k = 0; k < 46; k++) {
      b.fillStyle = zufall() < 0.5 ? "rgba(255,255,255,0.045)" : "rgba(0,20,60,0.07)";
      ellipse(b, zufall() * FELDGROESSE, y0 + zufall() * hoehe, 14 + zufall() * 26, 4 + zufall() * 7);
      b.fill();
    }
    // Schatten der Hecke auf dem Wasser
    const schatten = b.createLinearGradient(0, y0, 0, y0 + 9);
    schatten.addColorStop(0, "rgba(0,20,30,0.35)");
    schatten.addColorStop(1, "rgba(0,20,30,0)");
    b.fillStyle = schatten;
    b.fillRect(0, y0, FELDGROESSE, 9);
  }

  /** Ein Seerosenblatt (rund, mit Kerbe, Adern und Glanz). `tiefe` taucht es optisch ab. */
  function zeichneSeerosenblatt(c, cx, cy, radius, kerbe, tiefe = 0, blume = false) {
    c.save();
    c.translate(cx, cy);
    const skala = 1 - 0.15 * tiefe;
    c.scale(skala, skala);
    if (tiefe < 0.8) {                                     // Schatten auf dem Wasser
      c.fillStyle = `rgba(0,25,45,${0.28 * (1 - tiefe)})`;
      ellipse(c, 1.5, 2.5, radius, radius * 0.95);
      c.fill();
    }
    // Blattform: ein Kreis, aus dem eine Tortenecke (die Kerbe) fehlt
    const blattPfad = () => {
      c.beginPath();
      c.moveTo(0, 0);
      c.arc(0, 0, radius, kerbe + 0.24, kerbe + Math.PI * 2 - 0.24);
      c.closePath();
    };
    const verlauf = c.createRadialGradient(-radius * 0.25, -radius * 0.25, 1, 0, 0, radius);
    verlauf.addColorStop(0, NATUR.padHell);
    verlauf.addColorStop(0.65, NATUR.pad);
    verlauf.addColorStop(1, NATUR.padDunkel);
    blattPfad();
    c.fillStyle = verlauf;
    c.fill();
    c.lineWidth = 1;
    c.strokeStyle = NATUR.padDunkel;
    c.stroke();
    // Blattadern: strahlenförmig von der Mitte, mit Lücke bei der Kerbe
    c.strokeStyle = "rgba(20,70,25,0.45)";
    c.lineWidth = 0.9;
    c.beginPath();
    for (let k = 0; k < 8; k++) {
      const winkel = kerbe + 0.5 + (k * (Math.PI * 2 - 1.0)) / 7;
      c.moveTo(Math.cos(winkel) * radius * 0.18, Math.sin(winkel) * radius * 0.18);
      c.lineTo(Math.cos(winkel) * radius * 0.86, Math.sin(winkel) * radius * 0.86);
    }
    c.stroke();
    // Glanz
    c.fillStyle = "rgba(255,255,255,0.16)";
    ellipse(c, -radius * 0.3, -radius * 0.35, radius * 0.32, radius * 0.16, -0.6);
    c.fill();
    if (blume && tiefe < 0.5) {                            // kleine rosa Seerosenblüte
      for (let k = 0; k < 8; k++) {
        c.save();
        c.rotate((k * Math.PI) / 4);
        c.fillStyle = k % 2 === 0 ? "#f8c4d9" : "#f19ac0";
        ellipse(c, 0, -4.2, 1.7, 4);
        c.fill();
        c.restore();
      }
      c.fillStyle = "#f4cf3c";
      c.beginPath(); c.arc(0, 0, 1.9, 0, Math.PI * 2); c.fill();
    }
    if (tiefe > 0) {                                       // unter Wasser: bläulich überdeckt
      blattPfad();
      c.fillStyle = NATUR.wasser;
      c.globalAlpha = Math.min(0.88, tiefe * 0.95);
      c.fill();
    }
    c.restore();
  }

  /** Hecke mit Schilf, Zielbuchten als kleine Wasser-Nischen mit Seerose. */
  function zeichneHecke(b, zufall) {
    b.fillStyle = NATUR.hecke;
    b.fillRect(0, 0, FELDGROESSE, ZELLE);
    // Laub: viele überlappende Kreise in drei Grüntönen
    const toene = [NATUR.heckeMittel, NATUR.hecke, NATUR.heckeHell, "#17481d"];
    for (let k = 0; k < 230; k++) {
      b.fillStyle = toene[Math.floor(zufall() * toene.length)];
      b.beginPath();
      b.arc(zufall() * FELDGROESSE, zufall() * 28, 2.5 + zufall() * 3.5, 0, Math.PI * 2);
      b.fill();
    }
    // Uferstreifen aus Erde unter der Hecke
    b.fillStyle = NATUR.erde;
    b.fillRect(0, 28, FELDGROESSE, 4);
    b.fillStyle = "rgba(0,0,0,0.25)";
    b.fillRect(0, 28, FELDGROESSE, 1);

    // Schilf in den Heckenzellen zwischen den Buchten
    for (let s = 0; s < SPALTEN; s++) {
      if (BUCHT_SPALTEN.includes(s)) continue;
      if (s % 2 === 0) continue;                           // Zellen 1, 3, 5, ... 11 bekommen Schilf
      for (let k = 0; k < 4; k++) {
        const x = s * ZELLE + 6 + k * 6 + zufall() * 3;
        const spitze = 5 + zufall() * 9;
        b.strokeStyle = zufall() < 0.5 ? NATUR.schilf : "#a7b251";
        b.lineWidth = 1.4;
        b.beginPath();
        b.moveTo(x, 30);
        b.quadraticCurveTo(x + (zufall() - 0.5) * 6, 18, x + (zufall() - 0.5) * 5, spitze);
        b.stroke();
        if (k % 2 === 0) {                                   // Rohrkolben
          b.fillStyle = NATUR.kolben;
          ellipse(b, x + (k - 1) * 0.5, spitze + 4, 1.7, 4.6);
          b.fill();
        }
      }
    }

    // Die fünf Buchten: Wasser-Nische mit Erdrand und einem Seerosenblatt
    BUCHT_SPALTEN.forEach((spalte, i) => {
      const x = spalte * ZELLE;
      b.fillStyle = NATUR.erde;
      rundesRechteck(b, x, 2, ZELLE, ZELLE - 2, 4);
      b.fill();
      const wasser = b.createLinearGradient(0, 4, 0, ZELLE);
      wasser.addColorStop(0, NATUR.wasserTief);
      wasser.addColorStop(1, NATUR.wasser);
      b.fillStyle = wasser;
      rundesRechteck(b, x + 2, 4, ZELLE - 4, ZELLE - 4, 3);
      b.fill();
      b.fillStyle = "rgba(255,255,255,0.08)";             // kleine Glanzstriche im Wasser
      b.fillRect(x + 5, 9, 8, 1);
      b.fillRect(x + 19, 25, 7, 1);
      zeichneSeerosenblatt(b, x + ZELLE / 2, 19, 9, 0.9 + i * 1.3, 0, i % 2 === 1);
    });
  }

  function baueHintergrund() {
    const bild = document.createElement("canvas");
    bild.width = FELDGROESSE * PIXEL_SKALA;
    bild.height = FELDGROESSE * PIXEL_SKALA;
    const b = bild.getContext("2d");
    b.scale(PIXEL_SKALA, PIXEL_SKALA);
    const zufall = zufallsfolge(20261009);
    zeichneFluss(b, zufall);
    zeichneWiese(b, 6, zufall);
    zeichneWiese(b, 12, zufall);
    zeichneUfer(b, zufall);
    zeichneStrasse(b, zufall);
    zeichneHecke(b, zufall);
    return bild;
  }

  /* ============================================================
     Zeichnen: Fahrzeuge
     ------------------------------------------------------------
     Alle Fahrzeuge werden von oben gesehen und IMMER nach rechts
     fahrend gezeichnet (Front bei +x). Fährt die Bahn nach links,
     spiegelt scale(-1, 1) das ganze Bild. So stehen Scheinwerfer
     vorn und Rücklichter hinten, ohne zwei Zeichen-Varianten zu
     pflegen. Die Zeichnung beginnt in der Fahrzeugmitte (0, 0).
     ============================================================ */

  // Form der Pkw-Kabine als Bruchteil der Länge L (Mitte = 0, Front = +0,5):
  //   scheibe: vordere Kante der Frontscheibe, tiefe: wie lang die Scheibe ist
  //   dachEnde: hintere Dachkante, heck: Länge der Heckscheibe
  const PKW_FORM = {
    limousine:  { scheibe: 0.21, tiefe: 0.09, dachEnde: -0.13, heck: 0.10, streifen: false },
    kleinwagen: { scheibe: 0.17, tiefe: 0.12, dachEnde: -0.19, heck: 0.11, streifen: false },
    sportwagen: { scheibe: 0.10, tiefe: 0.15, dachEnde: -0.14, heck: 0.11, streifen: true },
  };

  const GLAS = "#25323e";

  /** Scheinwerfer (mit Lichtfleck auf der Straße) vorn, Rücklichter hinten. */
  function zeichneLichter(c, L, H, abstand) {
    for (const s of [-1, 1]) {
      // Lichtfleck vor dem Fahrzeug: weicher Verlauf von warmem Gelb nach durchsichtig
      const fleck = c.createRadialGradient(L / 2 + 2, s * abstand, 0.5, L / 2 + 6, s * abstand, 10);
      fleck.addColorStop(0, "rgba(255,240,170,0.38)");
      fleck.addColorStop(1, "rgba(255,240,170,0)");
      c.fillStyle = fleck;
      c.fillRect(L / 2 - 2, s * abstand - 10, 20, 20);
      c.fillStyle = "#fff6c4";                           // Scheinwerfer
      rundesRechteck(c, L / 2 - 4.2, s * abstand - 1.8, 3.6, 3.6, 1.2);
      c.fill();
      c.fillStyle = "#e0302a";                           // Rücklicht
      rundesRechteck(c, -L / 2 - 0.2, s * abstand - 1.8, 2.6, 3.6, 1);
      c.fill();
    }
  }

  function zeichnePkw(c, typ, L, H, farbe) {
    const f = PKW_FORM[typ];
    // Räder: schauen ein wenig unter der Karosserie hervor
    c.fillStyle = "#14161a";
    for (const rx of [L * 0.31, -L * 0.31]) {
      rundesRechteck(c, rx - 3.6, -H / 2 - 1.3, 7.2, H + 2.6, 2);
      c.fill();
    }
    // Karosserie mit Lichtverlauf (oben heller, unten dunkler)
    rundesRechteck(c, -L / 2, -H / 2, L, H, H * 0.36);
    c.fillStyle = farbe;
    c.fill();
    const glanz = c.createLinearGradient(0, -H / 2, 0, H / 2);
    glanz.addColorStop(0, "rgba(255,255,255,0.26)");
    glanz.addColorStop(0.5, "rgba(255,255,255,0)");
    glanz.addColorStop(1, "rgba(0,0,0,0.28)");
    c.fillStyle = glanz;
    c.fill();
    c.strokeStyle = "rgba(0,0,0,0.35)";
    c.lineWidth = 0.8;
    c.stroke();
    if (f.streifen) {                                    // Rennstreifen beim Sportwagen
      c.fillStyle = "rgba(255,255,255,0.8)";
      c.fillRect(-L / 2 + 2, -2.6, L * 0.62, 1.8);
      c.fillRect(-L / 2 + 2, 0.8, L * 0.62, 1.8);
    }
    // Frontscheibe, Dach, Heckscheibe
    const x1 = L * f.scheibe;
    const x2 = x1 - L * f.tiefe;
    const x3 = L * f.dachEnde;
    const x4 = x3 - L * f.heck;
    c.fillStyle = GLAS;
    c.beginPath();
    c.moveTo(x1, -H * 0.41); c.lineTo(x2, -H * 0.34); c.lineTo(x2, H * 0.34); c.lineTo(x1, H * 0.41);
    c.closePath();
    c.fill();
    c.beginPath();
    c.moveTo(x3, -H * 0.34); c.lineTo(x4, -H * 0.39); c.lineTo(x4, H * 0.39); c.lineTo(x3, H * 0.34);
    c.closePath();
    c.fill();
    rundesRechteck(c, x3, -H * 0.34, x2 - x3, H * 0.68, 2);
    c.fillStyle = farbe;
    c.fill();
    c.fillStyle = "rgba(255,255,255,0.12)";
    c.fill();
    c.strokeStyle = "rgba(0,0,0,0.3)";
    c.stroke();
    c.strokeStyle = "rgba(255,255,255,0.3)";              // Spiegelung auf der Frontscheibe
    c.beginPath();
    c.moveTo(x1 - 0.8, -H * 0.3); c.lineTo(x2 + 1, -H * 0.06);
    c.stroke();
    // Außenspiegel
    c.fillStyle = farbe;
    for (const s of [-1, 1]) {
      rundesRechteck(c, x1 - 2.2, s * (H / 2 + 0.2) - 1, 3.6, 2, 1);
      c.fill();
    }
    zeichneLichter(c, L, H, H / 2 - 5.2);
  }

  function zeichneLieferwagen(c, L, H, farbe) {
    c.fillStyle = "#14161a";
    for (const rx of [L * 0.3, -L * 0.3]) {
      rundesRechteck(c, rx - 3.6, -H / 2 - 1.3, 7.2, H + 2.6, 2);
      c.fill();
    }
    rundesRechteck(c, -L / 2, -H / 2, L, H, 4);
    c.fillStyle = farbe;
    c.fill();
    const glanz = c.createLinearGradient(0, -H / 2, 0, H / 2);
    glanz.addColorStop(0, "rgba(255,255,255,0.25)");
    glanz.addColorStop(1, "rgba(0,0,0,0.25)");
    c.fillStyle = glanz;
    c.fill();
    c.strokeStyle = "rgba(0,0,0,0.4)";
    c.lineWidth = 0.8;
    c.stroke();
    // kurze Haube, Frontscheibe, langes Kastendach mit Rippen
    const x1 = L * 0.38;
    const x2 = L * 0.28;
    c.fillStyle = GLAS;
    c.beginPath();
    c.moveTo(x1, -H * 0.4); c.lineTo(x2, -H * 0.37); c.lineTo(x2, H * 0.37); c.lineTo(x1, H * 0.4);
    c.closePath();
    c.fill();
    rundesRechteck(c, -L / 2 + 2, -H / 2 + 2.4, x2 - (-L / 2 + 2) - 1, H - 4.8, 2);
    c.fillStyle = "rgba(255,255,255,0.14)";
    c.fill();
    c.strokeStyle = "rgba(0,0,0,0.22)";
    c.stroke();
    c.beginPath();
    for (let x = -L / 2 + 8; x < x2 - 3; x += 6) {
      c.moveTo(x, -H / 2 + 3);
      c.lineTo(x, H / 2 - 3);
    }
    c.stroke();
    c.strokeStyle = "rgba(0,0,0,0.35)";                   // Hecktür-Fuge
    c.beginPath();
    c.moveTo(-L / 2 + 5, -H / 2 + 1.5); c.lineTo(-L / 2 + 5, H / 2 - 1.5);
    c.stroke();
    c.fillStyle = "#3a3d42";                               // große Außenspiegel
    for (const s of [-1, 1]) {
      rundesRechteck(c, x2 - 1, s * (H / 2 + 0.5) - 1.3, 4.5, 2.6, 1);
      c.fill();
    }
    zeichneLichter(c, L, H, H / 2 - 5.2);
  }

  /** Fahrerkabine von Lkw und Tanker (vorn) samt Windschutzscheibe. */
  function zeichneKabine(c, L, H, farbe) {
    const kabine = 25;
    const x = L / 2 - kabine;
    rundesRechteck(c, x, -H / 2 + 1.5, kabine, H - 3, 4);
    c.fillStyle = farbe;
    c.fill();
    const glanz = c.createLinearGradient(0, -H / 2, 0, H / 2);
    glanz.addColorStop(0, "rgba(255,255,255,0.25)");
    glanz.addColorStop(1, "rgba(0,0,0,0.28)");
    c.fillStyle = glanz;
    c.fill();
    c.strokeStyle = "rgba(0,0,0,0.4)";
    c.lineWidth = 0.8;
    c.stroke();
    rundesRechteck(c, L / 2 - 7.5, -H / 2 + 3.8, 5, H - 7.6, 1.5);   // Windschutzscheibe
    c.fillStyle = GLAS;
    c.fill();
    rundesRechteck(c, x + 3, -H / 2 + 4, 9, H - 8, 2);               // Dach mit Lüftungsklappe
    c.fillStyle = "rgba(255,255,255,0.13)";
    c.fill();
    c.fillStyle = "#1c1e22";                                          // Spiegel
    for (const s of [-1, 1]) {
      rundesRechteck(c, L / 2 - 11, s * (H / 2 - 0.6) - 1.2, 3.4, 2.4, 1);
      c.fill();
    }
  }

  function zeichneLkw(c, L, H, farbe, planenFarbe) {
    const kabine = 25;
    const anhaenger = L - kabine - 4;
    // Räder des Aufliegers (hinten) und der Kabine (vorn)
    c.fillStyle = "#14161a";
    for (const rx of [-L / 2 + 14, -L / 2 + 26, -L / 2 + 38, L / 2 - 10]) {
      rundesRechteck(c, rx - 4, -H / 2 - 1, 8, H + 2, 2);
      c.fill();
    }
    // Kupplung zwischen Kabine und Anhänger
    c.fillStyle = "#1c1e22";
    c.fillRect(L / 2 - kabine - 4.5, -3, 6, 6);
    // Anhänger mit Plane: Spanngurte quer, Dachkante längs
    rundesRechteck(c, -L / 2, -H / 2 + 0.8, anhaenger, H - 1.6, 3);
    c.fillStyle = planenFarbe;
    c.fill();
    const glanz = c.createLinearGradient(0, -H / 2, 0, H / 2);
    glanz.addColorStop(0, "rgba(255,255,255,0.25)");
    glanz.addColorStop(0.5, "rgba(255,255,255,0)");
    glanz.addColorStop(1, "rgba(0,0,0,0.25)");
    c.fillStyle = glanz;
    c.fill();
    c.strokeStyle = "rgba(0,0,0,0.38)";
    c.lineWidth = 0.9;
    c.stroke();
    c.strokeStyle = "rgba(0,0,0,0.2)";
    c.lineWidth = 1;
    c.beginPath();
    for (let x = -L / 2 + 9; x < -L / 2 + anhaenger - 4; x += 11) {
      c.moveTo(x, -H / 2 + 1.6);
      c.lineTo(x, H / 2 - 1.6);
    }
    c.moveTo(-L / 2 + 3, -H * 0.22); c.lineTo(-L / 2 + anhaenger - 3, -H * 0.22);
    c.moveTo(-L / 2 + 3, H * 0.22); c.lineTo(-L / 2 + anhaenger - 3, H * 0.22);
    c.stroke();
    c.fillStyle = farbe;                                  // Firmenstreifen in Kabinenfarbe
    c.globalAlpha = 0.65;
    c.fillRect(-L / 2 + 10, -1.5, anhaenger - 20, 3);
    c.globalAlpha = 1;
    zeichneKabine(c, L, H, farbe);
    zeichneLichter(c, L, H, H / 2 - 5);
  }

  function zeichneTanker(c, L, H, farbe, tankFarbe) {
    const kabine = 25;
    const tank = L - kabine - 4;
    c.fillStyle = "#14161a";
    for (const rx of [-L / 2 + 12, -L / 2 + 24, L / 2 - 10]) {
      rundesRechteck(c, rx - 4, -H / 2 - 1, 8, H + 2, 2);
      c.fill();
    }
    c.fillStyle = "#1c1e22";
    c.fillRect(L / 2 - kabine - 4.5, -3, 6, 6);
    // Tankkörper: Zylinder von oben = Rechteck mit starkem Lichtstreifen
    rundesRechteck(c, -L / 2, -H / 2 + 1, tank, H - 2, (H - 2) / 2);
    c.fillStyle = tankFarbe;
    c.fill();
    const zylinder = c.createLinearGradient(0, -H / 2, 0, H / 2);
    zylinder.addColorStop(0, "rgba(0,0,0,0.3)");
    zylinder.addColorStop(0.28, "rgba(255,255,255,0.55)");
    zylinder.addColorStop(0.55, "rgba(255,255,255,0)");
    zylinder.addColorStop(1, "rgba(0,0,0,0.4)");
    c.fillStyle = zylinder;
    c.fill();
    c.strokeStyle = "rgba(0,0,0,0.4)";
    c.lineWidth = 0.9;
    c.stroke();
    c.strokeStyle = "rgba(0,0,0,0.28)";                   // Schweißnähte / Spannbänder
    c.lineWidth = 1.2;
    c.beginPath();
    for (const bx of [0.2, 0.5, 0.8]) {
      c.moveTo(-L / 2 + tank * bx, -H / 2 + 2);
      c.lineTo(-L / 2 + tank * bx, H / 2 - 2);
    }
    c.stroke();
    c.fillStyle = "#6e7479";                              // Einstiegsluken
    for (const bx of [0.35, 0.65]) {
      c.beginPath(); c.arc(-L / 2 + tank * bx, 0, 2.6, 0, Math.PI * 2); c.fill();
      c.strokeStyle = "rgba(0,0,0,0.45)";
      c.lineWidth = 0.8;
      c.stroke();
    }
    zeichneKabine(c, L, H, farbe);
    zeichneLichter(c, L, H, H / 2 - 5);
  }

  /** Zeichnet das Fahrzeug Nr. i der Bahn an seiner (mit Vorgriff verschobenen) Stelle. */
  function zeichneFahrzeug(links, zeile, bahn, objekt) {
    const typ = FAHRZEUG_TYPEN[objekt.typ];
    const L = objekt.laenge * ZELLE - 2 * FAHRZEUG_RAND * ZELLE;   // sichtbare Länge in Pixeln
    const H = typ.hoehe * ZELLE;
    z.save();
    z.translate((links + objekt.laenge / 2) * ZELLE, zeile * ZELLE + ZELLE / 2);
    if (bahn.richtung < 0) z.scale(-1, 1);
    // weicher Schatten auf dem Asphalt
    z.fillStyle = "rgba(0,0,0,0.3)";
    rundesRechteck(z, -L / 2 + 0.5, -H / 2 + 2.5, L, H, H * 0.3);
    z.fill();
    if (objekt.typ === "lkw") zeichneLkw(z, L, H, objekt.farbe, objekt.farbe2 ?? "#d8d3c0");
    else if (objekt.typ === "tanker") zeichneTanker(z, L, H, objekt.farbe, objekt.farbe2 ?? "#d9dde0");
    else if (objekt.typ === "lieferwagen") zeichneLieferwagen(z, L, H, objekt.farbe);
    else zeichnePkw(z, objekt.typ, L, H, objekt.farbe);
    z.restore();
  }

  /* ============================================================
     Zeichnen: Stämme und Seerosen
     ============================================================ */

  /** Baumstamm: braune Walze mit Rinde, Astloch, Moos und runden Hirnholz-Enden. */
  function zeichneStamm(links, zeile, objekt, seed) {
    const x = (links + PLATTFORM_RAND) * ZELLE;
    const breite = (objekt.laenge - 2 * PLATTFORM_RAND) * ZELLE;
    const hoehe = 22;
    const y = zeile * ZELLE + 5;
    const zufall = zufallsfolge(seed);
    z.save();
    // Schatten und weißer Schaum rund um den Stamm
    z.fillStyle = "rgba(0,25,50,0.28)";
    rundesRechteck(z, x + 1, y + 3.5, breite, hoehe, 9);
    z.fill();
    z.strokeStyle = "rgba(255,255,255,0.3)";
    z.lineWidth = 2;
    rundesRechteck(z, x - 1.5, y - 1.5, breite + 3, hoehe + 3, 11);
    z.stroke();
    // Walzenkörper mit Verlauf quer zur Länge
    const verlauf = z.createLinearGradient(0, y, 0, y + hoehe);
    verlauf.addColorStop(0, NATUR.holzDunkel);
    verlauf.addColorStop(0.3, NATUR.holzHell);
    verlauf.addColorStop(0.55, NATUR.holz);
    verlauf.addColorStop(1, NATUR.holzDunkel);
    rundesRechteck(z, x, y, breite, hoehe, 9);
    z.fillStyle = verlauf;
    z.fill();
    // Rinde: wellige dunkle Längsrisse
    z.save();
    rundesRechteck(z, x, y, breite, hoehe, 9);
    z.clip();
    z.lineCap = "round";
    z.strokeStyle = "rgba(40,22,8,0.55)";
    z.lineWidth = 1.1;
    const risse = Math.round(objekt.laenge * 3.2);
    for (let k = 0; k < risse; k++) {
      const rx = x + 8 + zufall() * (breite - 20);
      const ry = y + 3 + zufall() * (hoehe - 6);
      const rl = 9 + zufall() * 18;
      z.beginPath();
      z.moveTo(rx, ry);
      z.bezierCurveTo(rx + rl * 0.3, ry - 1.8, rx + rl * 0.7, ry + 1.8, rx + rl, ry);
      z.stroke();
    }
    // Moospolster
    z.fillStyle = "rgba(90,130,50,0.5)";
    ellipse(z, x + breite * (0.3 + zufall() * 0.4), y + hoehe - 3, 7 + zufall() * 4, 2.6);
    z.fill();
    // Astloch mit Ring
    const ax = x + breite * (0.25 + zufall() * 0.5);
    z.fillStyle = "rgba(35,18,6,0.8)";
    ellipse(z, ax, y + hoehe * 0.42, 3, 2.3);
    z.fill();
    z.strokeStyle = "rgba(210,166,113,0.45)";
    ellipse(z, ax, y + hoehe * 0.42, 4.6, 3.6);
    z.stroke();
    // Lichtkante oben
    z.strokeStyle = "rgba(255,225,170,0.4)";
    z.lineWidth = 1.5;
    z.beginPath();
    z.moveTo(x + 10, y + 3.5);
    z.lineTo(x + breite - 10, y + 3.5);
    z.stroke();
    z.restore();
    z.strokeStyle = "rgba(30,15,5,0.7)";
    z.lineWidth = 1;
    rundesRechteck(z, x, y, breite, hoehe, 9);
    z.stroke();
    // Runde Enden: Hirnholz mit Jahresringen
    for (const ex of [x + 4.5, x + breite - 4.5]) {
      const ey = y + hoehe / 2;
      ellipse(z, ex, ey, 4.6, hoehe / 2 - 0.6);
      z.fillStyle = NATUR.holzEnde;
      z.fill();
      z.strokeStyle = "rgba(60,35,12,0.75)";
      z.lineWidth = 0.9;
      z.stroke();
      ellipse(z, ex, ey, 3, 6.6); z.stroke();
      ellipse(z, ex, ey, 1.4, 3.2); z.stroke();
    }
    z.restore();
  }

  /** Kleine Blubberblasen: steigen auf und verblassen. Bei reduzierter Bewegung stehen sie still. */
  function zeichneBlasen(cx, cy, seed, jetzt) {
    const zufall = zufallsfolge(seed);
    z.save();
    z.lineWidth = 1;
    for (let k = 0; k < 4; k++) {
      const phase0 = zufall();
      const bx = cx + (zufall() - 0.5) * 20;
      const r = 1 + zufall() * 1.7;
      const lauf = ruhigerModus ? 0.4 : ((jetzt / 800 + phase0) % 1);
      z.globalAlpha = 0.75 * (1 - lauf);
      z.strokeStyle = "#ffffff";
      z.beginPath();
      z.arc(bx, cy + 4 - lauf * 15, r, 0, Math.PI * 2);
      z.stroke();
    }
    z.restore();
  }

  /** Wackel-Versatz eines Seerosenblatts während der Warnung (für Blatt UND getragenen Frosch). */
  function wackelVersatz(sicht, seed, jetzt) {
    if (!sicht.wackeln || ruhigerModus) return { dx: 0, dy: 0 };
    return { dx: Math.sin(jetzt / 38 + seed) * 1.2, dy: Math.cos(jetzt / 47 + seed * 2) * 1.0 };
  }

  /** Eine Seerosen-Gruppe: pro Zelle ein Blatt. Taucht periodisch (Warnung, dann unter Wasser). */
  function zeichneSeerosen(links, zeile, objekt, objektNr, jetzt) {
    const sicht = tauchSicht(spielzeit, objekt);
    for (let j = 0; j < objekt.laenge; j++) {
      const seed = zeile * 977 + objektNr * 131 + j * 17;
      const zufall = zufallsfolge(seed);
      const radius = 13 + zufall() * 1.8;
      const kerbe = zufall() * Math.PI * 2;
      const blume = zufall() < 0.3;
      const w = wackelVersatz(sicht, seed, jetzt);
      const cx = (links + j + 0.5) * ZELLE + w.dx;
      const cy = zeile * ZELLE + ZELLE / 2 + w.dy;
      // Wasserring um das Blatt (verschwindet beim Untertauchen)
      z.strokeStyle = `rgba(255,255,255,${0.26 * (1 - sicht.tiefe)})`;
      z.lineWidth = 1.2;
      z.beginPath();
      z.arc(cx, cy, radius + 2, 0, Math.PI * 2);
      z.stroke();
      zeichneSeerosenblatt(z, cx, cy, radius, kerbe, sicht.tiefe, blume);
      if (sicht.zustand !== "oben" || sicht.tiefe > 0.1) zeichneBlasen(cx, cy, seed + 5, jetzt);
    }
  }

  /** Zeichnet alle Objekte einer Bahn. `vorgriff` = Restzeit in Sekunden (siehe einzelbild). */
  function zeichneBahn(zeile, jetzt, vorgriff) {
    const bahn = bahnen[zeile];
    const verschiebung = bahnGeschwindigkeit(bahn, tempoFaktor(runde)) * vorgriff;
    for (let i = 0; i < bahn.objekte.length; i++) {
      const objekt = bahn.objekte[i];
      const links = objektLinks(bahn, i) + verschiebung;
      // Nur zeichnen, was (teilweise) im Bild ist.
      if (links + objekt.laenge <= 0 || links >= SPALTEN) continue;
      if (bahn.art === "fahrzeug") zeichneFahrzeug(links, zeile, bahn, objekt);
      else if (objekt.krokodil) zeichneKrokodil(links, zeile, objekt, bahn.richtung, jetzt);
      else if (bahn.art === "stamm") zeichneStamm(links, zeile, objekt, zeile * 31 + i * 7 + 3);
      else zeichneSeerosen(links, zeile, objekt, i, jetzt);
    }
  }

  /* ============================================================
     Zeichnen: Frosch
     ============================================================ */

  /**
   * Zeichnet den Frosch von oben. Alles wird um (cx, cy) gezeichnet, gedreht um
   * `winkel` (0 = schaut nach oben).
   *   skalaX/skalaY  Größe (für Sprung und Plattdrücken verschieden)
   *   haltung        0 = sitzend (Beine angelegt), 1 = gestreckt (mitten im Sprung)
   *   tot            true = X-Augen
   * Die Beine sind Linienzüge Hüfte -> Knie -> Fuß; je nach `haltung` werden
   * die Gelenkpositionen zwischen "sitzend" und "gestreckt" gemischt.
   */
  function zeichneFroschKoerper(c, cx, cy, winkel, skalaX, skalaY, haltung = 0, tot = false) {
    c.save();
    c.translate(cx, cy);
    c.rotate(winkel);
    c.scale(skalaX, skalaY);
    c.lineCap = "round";
    c.lineJoin = "round";

    // Beine (zuerst, damit der Körper sie überdeckt)
    for (const s of [-1, 1]) {
      // Hinterbein: Hüfte, Knie, Fuß
      const knieX = mix(12.5, 8.5, haltung) * s;
      const knieY = mix(1, 15, haltung);
      const fussX = mix(10, 8.5, haltung) * s;
      const fussY = mix(12, 24, haltung);
      for (const [breite, farbe] of [[6.4, NATUR.froschDunkel], [4.4, NATUR.frosch]]) {
        c.strokeStyle = farbe;
        c.lineWidth = breite;
        c.beginPath();
        c.moveTo(5.5 * s, 5);
        c.lineTo(knieX, knieY);
        c.lineTo(fussX, fussY);
        c.stroke();
      }
      c.strokeStyle = NATUR.froschDunkel;                  // Zehen: drei kurze Striche
      c.lineWidth = 1.5;
      c.beginPath();
      for (const a of [-0.6, 0, 0.6]) {
        c.moveTo(fussX, fussY);
        c.lineTo(fussX + Math.sin(a) * 4.5 * s + s * 0.8, fussY + Math.cos(a) * 4.5);
      }
      c.stroke();
      // Vorderbein: Schulter, Ellbogen, Hand
      const ellX = mix(9.5, 6.8, haltung) * s;
      const ellY = mix(0, -11, haltung);
      const handX = mix(8.5, 6, haltung) * s;
      const handY = mix(-8, -19, haltung);
      for (const [breite, farbe] of [[4.6, NATUR.froschDunkel], [3, NATUR.frosch]]) {
        c.strokeStyle = farbe;
        c.lineWidth = breite;
        c.beginPath();
        c.moveTo(5.5 * s, -4);
        c.lineTo(ellX, ellY);
        c.lineTo(handX, handY);
        c.stroke();
      }
      c.strokeStyle = NATUR.froschDunkel;                  // Finger
      c.lineWidth = 1.2;
      c.beginPath();
      for (const a of [-0.5, 0, 0.5]) {
        c.moveTo(handX, handY);
        c.lineTo(handX + Math.sin(a) * 3.2, handY - Math.cos(a) * 3.2);
      }
      c.stroke();
    }

    // Körper + Kopf als eine Silhouette: erst beide mit dunklem Rand, dann beide füllen
    const koerper = c.createRadialGradient(-2, -3, 1, 0, 1, 13);
    koerper.addColorStop(0, NATUR.froschHell);
    koerper.addColorStop(0.55, NATUR.frosch);
    koerper.addColorStop(1, NATUR.froschDunkel);
    c.strokeStyle = NATUR.froschDunkel;
    c.lineWidth = 2.6;
    ellipse(c, 0, 2, 8.4, 11.5); c.stroke();
    ellipse(c, 0, -8, 7, 5.8); c.stroke();
    c.fillStyle = koerper;
    ellipse(c, 0, 2, 8.4, 11.5); c.fill();
    ellipse(c, 0, -8, 7, 5.8); c.fill();
    // Rückenstreifen und dunkle Flecken
    c.fillStyle = "rgba(170,225,110,0.5)";
    ellipse(c, 0, 1, 1.5, 9); c.fill();
    c.fillStyle = "rgba(25,85,30,0.55)";
    for (const [fx, fy, fr] of [[-4.2, -1, 1.9], [4.4, 1.5, 2.1], [-3.4, 6.5, 1.8], [3.6, 8, 1.6], [-1.5, -5, 1.2]]) {
      ellipse(c, fx, fy, fr, fr * 0.8); c.fill();
    }
    // Augen: Wülste auf dem Kopf mit gelber Iris
    for (const s of [-1, 1]) {
      const ex = 4.6 * s;
      const ey = -11.6;
      c.fillStyle = NATUR.frosch;
      c.strokeStyle = NATUR.froschDunkel;
      c.lineWidth = 1.2;
      c.beginPath(); c.arc(ex, ey, 3.9, 0, Math.PI * 2); c.fill(); c.stroke();
      if (tot) {
        c.fillStyle = "#f3f3e8";
        c.beginPath(); c.arc(ex, ey, 2.7, 0, Math.PI * 2); c.fill();
        c.strokeStyle = "#1b1b1b";                         // X-Augen
        c.lineWidth = 1.3;
        c.beginPath();
        c.moveTo(ex - 1.6, ey - 1.6); c.lineTo(ex + 1.6, ey + 1.6);
        c.moveTo(ex + 1.6, ey - 1.6); c.lineTo(ex - 1.6, ey + 1.6);
        c.stroke();
      } else {
        c.fillStyle = "#f2dc6a";
        c.beginPath(); c.arc(ex, ey, 2.7, 0, Math.PI * 2); c.fill();
        c.fillStyle = "#101010";
        ellipse(c, ex, ey, 1.5, 1.8); c.fill();
        c.fillStyle = "rgba(255,255,255,0.9)";
        c.beginPath(); c.arc(ex - 0.6, ey - 0.8, 0.6, 0, Math.PI * 2); c.fill();
      }
    }
    // Nasenlöcher
    c.fillStyle = "rgba(20,60,25,0.8)";
    for (const s of [-1, 1]) {
      c.beginPath(); c.arc(1.4 * s, -13.2, 0.55, 0, Math.PI * 2); c.fill();
    }
    c.restore();
  }

  /** Bildposition (Pixel) des Frosches: Spielposition + Einrast-Rest + Vorgriff des Trägers. */
  function froschBildPosition(vorgriff) {
    let x = frosch.x + frosch.einrastVersatz;
    if (frosch.zustand === "lebt" && frosch.hopT >= 1) x += frosch.fahrtV * vorgriff;
    return { x: (x + 0.5) * ZELLE, y: (frosch.y + 0.5) * ZELLE };
  }

  function froschSichtbar() {
    return !(frosch.zustand === "ziel" && frosch.hopT >= 1);   // sitzt schon in der Bucht
  }

  /** Zeichnet den Frosch: lebend (hüpfend/sitzend/blinkend) oder in der Sterbe-Animation. */
  function zeichneFrosch(jetzt, vorgriff) {
    if (!froschSichtbar()) return;
    const pos = froschBildPosition(vorgriff);
    let { x, y } = pos;

    if (frosch.zustand === "tot") {
      const f = Math.min(frosch.zustandZeit / TOD_DAUER, 1);
      // Blinken: alle 70 ms zwischen sichtbar und blass wechseln (reduziert: dauerhaft blass)
      const blinkt = ruhigerModus ? true : Math.floor(frosch.zustandZeit / 0.07) % 2 === 0;
      z.save();
      if (frosch.todArt === "auto") {
        // Plattgedrückt: breit und flach
        z.globalAlpha = ruhigerModus ? 0.7 : (blinkt ? 1 : 0.45) * (1 - f * 0.35);
        zeichneFroschKoerper(z, x, y + 3, frosch.blick, 1.3, 0.4, 0, true);
      } else {
        // Versinkend: kleiner werdend, dabei blinkend (reduziert: nur blass)
        z.globalAlpha = ruhigerModus ? 0.5 : (blinkt ? 1 : 0.4) * (1 - f * 0.8);
        const s = ruhigerModus ? 1 : 1 - f * 0.45;
        zeichneFroschKoerper(z, x, y, frosch.blick, s, s, 0, true);
      }
      z.restore();
      return;
    }

    // Lebender Frosch. Mitten im Sprung: gestreckt, etwas größer ("in der Luft"),
    // mit Schatten, der am Boden bleibt.
    const luft = frosch.hopT < 1 && !ruhigerModus ? Math.sin(Math.PI * frosch.hopT) : 0;
    let skala = 1 + luft * 0.16;
    let wackelX = frosch.stoss > 0 && !ruhigerModus ? Math.sin(frosch.stoss * 70) * 3 : 0;
    // Sitzt der Frosch auf einem wackelnden/sinkenden Seerosenblatt, macht er es mit.
    if (frosch.zustand === "lebt" && frosch.hopT >= 1 && frosch.traeger >= 0 && zeilenArt(frosch.y) === "wasser") {
      const bahn = bahnen[frosch.y];
      if (bahn.art === "seerose") {
        const sicht = tauchSicht(spielzeit, bahn.objekte[frosch.traeger]);
        const w = wackelVersatz(sicht, frosch.y * 977 + frosch.traeger * 131, jetzt);
        x += w.dx;
        y += w.dy;
        skala *= 1 - 0.1 * sicht.tiefe;
      }
    }
    // Unverwundbar: der Frosch blinkt (reduziert: dauerhaft leicht blass)
    let alpha = 1;
    if (frosch.schutz > 0) alpha = ruhigerModus ? 0.6 : (Math.floor(jetzt / 90) % 2 === 0 ? 1 : 0.35);

    z.save();
    z.globalAlpha = alpha * 0.28;                           // Schatten
    z.fillStyle = "#0a1a10";
    ellipse(z, x + 2, y + 3.5, 10.5 * (1 - luft * 0.2), 12 * (1 - luft * 0.2));
    z.fill();
    z.globalAlpha = alpha;
    zeichneFroschKoerper(z, x + wackelX, y - luft * 4, frosch.blick, skala, skala, luft);
    z.restore();
  }

  /** Expandierende Ringe (Wasserspritzer / Staubwolke). Reine Deko. */
  function zeichneRinge() {
    z.save();
    z.lineWidth = 2;
    for (const ring of ringe) {
      const f = ring.alter / 0.8;
      z.globalAlpha = (1 - f) * 0.75;
      z.strokeStyle = ring.farbe;
      z.beginPath();
      z.arc(ring.x, ring.y, 6 + f * 22, 0, Math.PI * 2);
      z.stroke();
    }
    z.restore();
  }

  /** Verbleibende Leben als Mini-Frösche links unten, Rundenzahl rechts unten. */
  function zeichneLebenUndRunde() {
    z.save();
    for (let i = 0; i < leben; i++) {
      zeichneFroschKoerper(z, 16 + i * 26, START_ZEILE * ZELLE + ZELLE / 2, 0, 0.55, 0.55);
    }
    z.textAlign = "right";
    z.textBaseline = "middle";
    z.shadowColor = "rgba(0,30,0,0.8)";                      // dunkler Rand, damit die Schrift auf Gras lesbar bleibt
    z.shadowBlur = 3;
    z.fillStyle = "#f4f7ea";
    z.font = `10px ${farben.schriftPixel}`;
    z.textAlign = "left";
    z.fillText(`LEVEL ${runde}`, 16 + leben * 26 + 6, START_ZEILE * ZELLE + ZELLE / 2 + 1);
    z.restore();
  }

  /** Besetzte Buchten: ein Frosch sitzt auf der Seerose (kurzes Aufleuchten beim Besetzen). */
  function zeichneBesetzteBuchten() {
    for (let i = 0; i < BUCHT_SPALTEN.length; i++) {
      if (!buchten[i]) continue;
      const x = BUCHT_SPALTEN[i] * ZELLE;
      // Der Frosch springt gerade erst hinein: dann zeichnet zeichneFrosch() ihn noch selbst.
      if (frosch.zustand === "ziel" && frosch.hopT < 1 && Math.abs(frosch.zielX - BUCHT_SPALTEN[i]) < 0.01) continue;
      const blitz = ruhigerModus ? 0 : buchtBlitz[i];
      zeichneFroschKoerper(z, x + ZELLE / 2, 19, 0, 0.78 + blitz * 0.2, 0.78 + blitz * 0.2);
      if (blitz > 0) {
        z.save();
        z.globalAlpha = blitz * 0.45;
        z.fillStyle = "#fff6c4";
        rundesRechteck(z, x + 2, 4, ZELLE - 4, ZELLE - 4, 3);
        z.fill();
        z.restore();
      }
    }
  }

  /* ============================================================
     Zeichnen: alles zusammen
     ============================================================ */

  /** Beweglicher Wasserglanz: kurze helle Wellenstriche, die mit der Strömung der Bahn wandern. */
  function zeichneStroemung(jetzt) {
    z.save();
    z.lineWidth = 1.2;
    z.strokeStyle = "rgba(255,255,255,0.2)";
    z.beginPath();
    for (let reihe = 1; reihe <= 5; reihe++) {
      const bahn = bahnen[reihe];
      const lauf = ruhigerModus ? 0 : (jetzt / 1000) * bahn.tempo * ZELLE * 0.55 * bahn.richtung;
      const zufall = zufallsfolge(reihe * 53 + 7);
      for (let k = 0; k < 7; k++) {
        const basis = zufall() * (FELDGROESSE + 40);
        const x = ((((basis + lauf) % (FELDGROESSE + 40)) + FELDGROESSE + 40) % (FELDGROESSE + 40)) - 20;
        const y = reihe * ZELLE + 5 + zufall() * 21;
        const laenge = 10 + zufall() * 10;
        z.moveTo(x, y);
        z.quadraticCurveTo(x + laenge / 2, y - 2.4, x + laenge, y);
      }
    }
    z.stroke();
    z.restore();
  }

  /**
   * Krokodil von oben: grüner, schuppiger Körper wie ein Stamm, vorn (in
   * Fahrtrichtung) der Kopf mit Augen und Zähnen. Das Maul klappt
   * regelmäßig auf, damit der gefährliche Teil sofort ins Auge fällt.
   */
  function zeichneKrokodil(links, zeile, objekt, richtung, jetzt) {
    const breite = (objekt.laenge - 2 * PLATTFORM_RAND) * ZELLE;
    const x = (links + PLATTFORM_RAND) * ZELLE;
    const y = zeile * ZELLE + 6;
    const hoehe = 20;
    z.save();
    // immer nach rechts zeichnen, bei Linksfahrt spiegeln (wie die Fahrzeuge)
    z.translate(x + breite / 2, y + hoehe / 2);
    if (richtung < 0) z.scale(-1, 1);
    const L = breite / 2;
    z.fillStyle = "rgba(0,25,50,0.28)";
    rundesRechteck(z, -L + 1, -hoehe / 2 + 3, breite, hoehe, 8);
    z.fill();
    // Schwanz (schmal, hinten), Körper, Kopf
    z.fillStyle = "#2f6b2a";
    z.beginPath();
    z.moveTo(-L, 0);
    z.lineTo(-L + 18, -6);
    z.lineTo(-L + 18, 6);
    z.closePath();
    z.fill();
    rundesRechteck(z, -L + 14, -hoehe / 2, breite - 14 - KROKODIL_KOPF * ZELLE + 6, hoehe, 8);
    z.fill();
    // Rückenschuppen
    z.fillStyle = "#4f9a3c";
    for (let sx = -L + 20; sx < L - KROKODIL_KOPF * ZELLE - 2; sx += 8) z.fillRect(sx, -3, 5, 6);
    // Beine
    z.fillStyle = "#24561f";
    for (const bx of [-L + 26, L - KROKODIL_KOPF * ZELLE - 10]) { z.fillRect(bx, -hoehe / 2 - 3, 6, 4); z.fillRect(bx, hoehe / 2 - 1, 6, 4); }
    // Kopf: rot umrandet, damit klar ist "hier nicht landen"
    const kopfX = L - KROKODIL_KOPF * ZELLE;
    const offen = ruhigerModus ? 0.5 : (Math.sin(jetzt / 320) + 1) / 2;
    z.fillStyle = "#3b7d33";
    rundesRechteck(z, kopfX, -8 - offen * 3, KROKODIL_KOPF * ZELLE, 8 + offen * 3, 4);
    z.fill();
    rundesRechteck(z, kopfX, 0, KROKODIL_KOPF * ZELLE, 8 + offen * 3, 4);
    z.fill();
    z.fillStyle = "#8e1f1f";
    z.fillRect(kopfX + 4, -offen * 3, KROKODIL_KOPF * ZELLE - 8, offen * 6);
    z.fillStyle = "#f4f2e6";
    for (let tx = kopfX + 6; tx < L - 4; tx += 5) { z.fillRect(tx, -1 - offen * 3, 2, 2); z.fillRect(tx + 2, offen * 3 - 1, 2, 2); }
    z.fillStyle = "#f0d040";
    z.fillRect(kopfX + 2, -9, 4, 4);
    z.fillRect(kopfX + 2, 5, 4, 4);
    z.fillStyle = "#111";
    z.fillRect(kopfX + 3, -8, 2, 2);
    z.fillRect(kopfX + 3, 6, 2, 2);
    z.restore();
  }

  /** Schlange auf dem Mittelstreifen: Zickzack-Körper, Kopf in Laufrichtung. */
  function zeichneSchlange(jetzt, vorgriff) {
    if (!schlange) return;
    const sx = (schlange.x + schlange.richtung * SCHLANGE_TEMPO * tempoFaktor(runde) * vorgriff) * ZELLE;
    const sy = 6 * ZELLE + ZELLE / 2;
    const L = SCHLANGE_LAENGE * ZELLE;
    z.save();
    z.lineCap = "round";
    z.lineJoin = "round";
    z.strokeStyle = "#1d3b14";
    z.lineWidth = 9;
    const pfad = () => {
      z.beginPath();
      for (let i = 0; i <= 10; i++) {
        const t = i / 10;
        const px = schlange.richtung > 0 ? sx + t * L : sx + L - t * L;
        const py = sy + Math.sin(t * Math.PI * 3 + (ruhigerModus ? 0 : jetzt / 120)) * 4;
        if (i === 0) z.moveTo(px, py); else z.lineTo(px, py);
      }
    };
    pfad(); z.stroke();
    z.strokeStyle = "#c9b23a";
    z.lineWidth = 6;
    pfad(); z.stroke();
    // Kopf vorn
    const kx = schlange.richtung > 0 ? sx + L : sx;
    z.fillStyle = "#9a8424";
    ellipse(z, kx, sy, 6, 5);
    z.fill();
    z.fillStyle = "#111";
    z.fillRect(kx - 1, sy - 3, 2, 2);
    z.fillRect(kx - 1, sy + 1, 2, 2);
    z.restore();
  }

  /** Bonusfliege über einer freien Bucht (summt leicht hin und her). */
  function zeichneFliege(jetzt) {
    if (!fliege) return;
    const x = BUCHT_SPALTEN[fliege.bucht] * ZELLE + ZELLE / 2 + (ruhigerModus ? 0 : Math.sin(jetzt / 90) * 2);
    const y = 17 + (ruhigerModus ? 0 : Math.cos(jetzt / 70) * 1.5);
    const blinkt = fliege.rest < 1.2 && !ruhigerModus && Math.floor(jetzt / 120) % 2 === 0;
    if (blinkt) return;
    z.save();
    z.fillStyle = "rgba(230,240,255,0.85)";
    ellipse(z, x - 4, y - 3, 4, 2.5, -0.5); z.fill();
    ellipse(z, x + 4, y - 3, 4, 2.5, 0.5); z.fill();
    z.fillStyle = "#1a1a1a";
    ellipse(z, x, y, 3, 4.5); z.fill();
    z.fillStyle = "#c0392b";
    z.fillRect(x - 2, y - 4, 1.5, 1.5);
    z.fillRect(x + 0.5, y - 4, 1.5, 1.5);
    z.restore();
  }

  /** Zeitbalken unten rechts: grün, bei wenig Zeit gelb, dann rot. */
  function zeichneZeitbalken() {
    const voll = levelDaten(runde).zeit;
    const anteil = frosch.zustand === "lebt" ? frosch.zeit / voll : 1;
    const b = 110;
    const x = FELDGROESSE - b - 12;
    const y = START_ZEILE * ZELLE + 11;
    z.save();
    z.fillStyle = "rgba(0,0,0,0.55)";
    z.fillRect(x - 2, y - 2, b + 4, 14);
    z.fillStyle = anteil > 0.4 ? "#7ad04a" : anteil > 0.2 ? "#f0c030" : "#e5483b";
    z.fillRect(x, y, Math.max(0, b * anteil), 10);
    z.restore();
  }

  function zeichneAlles(jetzt, vorgriff) {
    if (!hintergrundBild) hintergrundBild = baueHintergrund();
    // --- Spielszene auf das kleine Pixel-Canvas (8-Bit-Raster) ---
    z = pixelZ;
    z.setTransform(PIXEL_RASTER, 0, 0, PIXEL_RASTER, 0, 0);
    z.imageSmoothingEnabled = true;
    z.globalAlpha = 1;
    z.shadowBlur = 0;
    z.drawImage(hintergrundBild, 0, 0, FELDGROESSE, FELDGROESSE);

    zeichneStroemung(jetzt);
    zeichneBesetzteBuchten();
    zeichneFliege(jetzt);
    for (let y = 1; y <= 5; y++) zeichneBahn(y, jetzt, vorgriff);
    zeichneSchlange(jetzt, phase === "laeuft" ? vorgriff : 0);
    // Wer von einem Fahrzeug überfahren wurde, liegt UNTER dem Fahrzeug,
    // alle anderen Frösche sitzen (oder fliegen) darüber.
    const unterAuto = frosch.zustand === "tot" && frosch.todArt === "auto";
    if (unterAuto) zeichneFrosch(jetzt, vorgriff);
    for (let y = 7; y <= 11; y++) zeichneBahn(y, jetzt, vorgriff);
    zeichneRinge();
    if (!unterAuto) zeichneFrosch(jetzt, vorgriff);
    if (levelDaten(runde).nacht) {
      z.fillStyle = "rgba(5,10,40,0.42)";
      z.fillRect(0, 0, FELDGROESSE, FELDGROESSE);
    }

    // --- Hochskalieren ohne Glätten: daraus entsteht der Pixel-Look ---
    z = hauptZ;
    z.setTransform(1, 0, 0, 1, 0, 0);
    z.imageSmoothingEnabled = false;
    z.drawImage(pixelLeinwand, 0, 0, leinwand.width, leinwand.height);
    z.imageSmoothingEnabled = true;
    // Texte und Anzeigen in voller Auflösung, sonst wären sie unlesbar
    z.setTransform(PIXEL_SKALA, 0, 0, PIXEL_SKALA, 0, 0);
    zeichneLebenUndRunde();
    zeichneZeitbalken();

    if (bannerRest > 0 && phase !== "bereit") zeichneBanner();
    if (phase === "bereit") zeichneOverlay(text("TASTE DRÜCKEN", "ZUM START TIPPEN"), text("Pfeiltasten, WASD oder Leertaste", "oder eine Richtung wählen"), jetzt);
    else if (phase === "pause") zeichneOverlay("PAUSE", text("P oder Leertaste: weiter", "Antippen: weiter"), jetzt);
  }

  /* ---------- Overlays (Seiten-Design, bewusst im Neon-Stil der Seite) ---------- */

  function zeichneBanner() {
    z.save();
    z.globalAlpha = Math.min(1, bannerRest * 3);
    z.fillStyle = farben.hintergrund;
    z.fillRect(0, FELDGROESSE / 2 - 24, FELDGROESSE, 48);
    z.textAlign = "center";
    z.textBaseline = "middle";
    z.shadowColor = farben.lime;
    z.shadowBlur = 12;
    z.fillStyle = farben.lime;
    z.font = `16px ${farben.schriftPixel}`;
    z.fillText(bannerText, FELDGROESSE / 2, FELDGROESSE / 2 + 1);
    z.restore();
  }

  function zeichneOverlay(titel, untertitel, jetzt) {
    z.save();
    z.globalAlpha = 0.86;
    z.fillStyle = farben.hintergrund;
    z.fillRect(0, 0, FELDGROESSE, FELDGROESSE);
    z.globalAlpha = 1;
    z.textAlign = "center";
    z.textBaseline = "middle";
    z.shadowColor = farben.pink;
    z.shadowBlur = 14;
    z.fillStyle = farben.text;
    z.font = `18px ${farben.schriftPixel}`;
    z.fillText(titel, FELDGROESSE / 2, FELDGROESSE / 2 - 14);
    z.shadowBlur = 0;
    z.globalAlpha = ruhigerModus ? 1 : 0.8 + 0.2 * Math.sin(jetzt / 350);
    z.fillStyle = farben.text;
    z.font = `15px ${farben.schriftText}`;
    z.fillText(untertitel, FELDGROESSE / 2, FELDGROESSE / 2 + 22);
    z.restore();
  }

  /* ============================================================
     Start
     ============================================================ */
  // Level-Auswahl unter der Steuerungs-Erklärung (assets/levelwahl.js)
  const wahl = levelWahl({
    spiel: SPIEL,
    namen: LEVEL.map((l) => l.name),
    nach: document.querySelector(".steuerung"),
    gesperrt: () => phase === "laeuft",
    beiWahl: (n) => neuesSpiel(n),
  });
  // Handy: Steuerkreuz, Einpassen, Scroll-Sperre, Spielmodus (assets/mobil.js)
  spielSeite({ phase: () => phase, gamepad: { links: "kreuz" } });
  neuesSpiel(1);
  letzteZeit = performance.now();
  requestAnimationFrame(einzelbild);
}

// Nur im Browser starten. In Node (Tests) gibt es kein "document",
// dort werden nur die reinen Funktionen oben importiert.
if (typeof document !== "undefined") {
  starteSpiel();
}
