/* ==========================================================================
   Every string the game itself writes, in English and Czech. The page picks
   the language through <html lang>; the static text lives in index.html and
   cs/index.html. World and soundtrack names stay as they are — they are
   names.
   ========================================================================== */

export const LANG = /^cs\b/i.test(document.documentElement.lang || "") ? "cs" : "en";

const EN = {
  "title.sub":
    "Classic tetrominoes, tangled with shapes that have no business being here — across six worlds that change as you climb.",
  "btn.play": "Play",
  "btn.resume": "Resume",
  "btn.restart": "Restart",
  "btn.again": "Play again",
  "btn.menu": "Menu",
  "btn.share": "Share",
  "btn.close": "Close",
  "btn.reload": "Reload",
  "btn.pieces": "Pieces",
  "btn.awards": "Awards",

  "stat.score": "Score",
  "stat.best": "Best",
  "stat.lines": "Lines",
  "stat.level": "Level",
  "stat.games": "Games",
  "stat.time": "Time",
  "stat.left": "Left",
  "stat.bestTime": "Best time",
  "stat.runs": "Finished",
  "stat.today": "Today",
  "stat.streak": "Streak",
  "stat.maxStreak": "Longest",

  "hint.title": "Mode ← → · Play Enter · Rotate ↑ · Drop Space · Hold C · World T",
  "hint.over": "or press <strong>R</strong> · <strong>Esc</strong> for the menu",

  "paused": "Paused",
  "over.topout": "Game Over",
  "over.time": "Time’s up!",
  "over.goal": "Finished!",
  "over.record": "★ New personal best ★",
  "over.todayRecord": "★ Today’s best ★",
  "over.personalBest": "Personal best: {v}",
  "over.todayBest": "Today’s best: {v}",
  "over.sprintShort": "{n} of 40 lines",

  "gfx.title": "Graphics reset",
  "gfx.text": "The browser switched off the 3D graphics. Reload to carry on — your best score is saved.",
  "webgl.text":
    "This game draws its worlds with WebGL 2, which this browser or device does not provide. Try a current Chrome, Firefox, Safari or Edge, or enable hardware acceleration.",
  "load.text": "The game could not load its worlds. Check your connection and reload.",

  "scene.journey": "Journey",
  "scene.change": "change world",

  "a11y.hold": "Held piece: {p}",
  "a11y.next": "Next pieces: {p}",
  "a11y.none": "none",
  "a11y.noneNext": "none",
  "a11y.modes": "Game mode",
  "a11y.unlocked": "unlocked",
  "a11y.locked": "locked",
  "a11y.progress.level": "Progress to next level",
  "a11y.progress.sprint": "Lines to the goal",
  "a11y.progress.daily": "Time used",

  "clear.1": "Single",
  "clear.2": "Double",
  "clear.3": "Triple",
  "clear.4": "TANGLE!",
  "pop.b2b": "BACK-TO-BACK",
  "pop.combo": "{n}× COMBO",
  "pop.perfect": "PERFECT CLEAR",
  "pop.level": "LEVEL {n}",
  "pop.sweep": "SWEPT CLEAN",
  "pop.goal": "40 LINES!",
  "pop.time": "TIME!",

  "mode.marathon": "Marathon",
  "mode.daily": "Daily",
  "mode.sprint": "Sprint",
  "mode.chaos": "Chaos",
  "mode.zen": "Zen",
  "mode.dailyFull": "Daily Tangle #{n}",
  "desc.marathon": "Climb through all six worlds. The odd shapes get more common every level.",
  "desc.daily": "3 minutes, the same pieces for everyone today. {p}% tangled.",
  "desc.sprint": "Clear 40 lines as fast as you can.",
  "desc.chaos": "Every odd shape is in the bag from the very first piece.",
  "desc.zen": "No game over, no speed-up — a full stack is swept away. Just the worlds and the music.",

  "daily.next": "Next Tangle in {t}",
  "daily.done": "Played today — beat your score or come back tomorrow.",

  "challenge.score": "Challenge: beat <strong>{v}</strong> with the same pieces",
  "challenge.time": "Challenge: finish faster than <strong>{v}</strong> with the same pieces",
  "challenge.won": "Challenge beaten! 🎉",
  "challenge.short": "{d} short of the challenge",
  "challenge.slower": "{d} slower than the challenge",
  "challenge.unfinished": "Challenge not beaten — try again",
  "challenge.deal": "You are playing the same pieces as the game that was shared with you",
  "challenge.drop": "Play your own pieces instead",

  "toast.piece": "New piece",
  "toast.award": "Achievement",
  "toast.copied": "Copied — paste it anywhere",
  "toast.shareFail": "Sharing didn’t work",

  "col.title": "Pieces",
  "col.count": "{n} of {total} discovered",
  "col.placed": "placed {n}×",
  "col.unknown": "Not found yet",
  "col.classic": "Classic",
  "col.common": "Common",
  "col.uncommon": "Uncommon",
  "col.rare": "Rare",
  "col.more": "All about the pieces",
  "col.link": "pieces/",

  "aw.title": "Achievements",
  "aw.count": "{n} of {total} unlocked",

  "share.score": "Tangletris {mode}: {points}, {lines}, level {level}. Same pieces for you — can you beat it?",
  "share.sprint": "Tangletris Sprint: 40 lines in {time}. Same pieces for you — can you do it faster?",
  "share.daily": "Tangletris Daily #{n} 🧩\n{score} · {lines} · {p}% tangled",
  "share.streak": "\n🔥 {n}-day streak",
  "share.cardLines": "{lines} · level {level}",
  "share.cardBeat": "Can you beat it?",

  "aw.first-clear": ["First Line", "Clear your first line."],
  "aw.tangle": ["Tangle!", "Clear four lines at once."],
  "aw.b2b": ["Back to Back", "Clear two Tangles in a row."],
  "aw.perfect": ["Clean Sweep", "Empty the whole board."],
  "aw.combo5": ["On a Roll", "Clear lines with five pieces in a row."],
  "aw.odd-tangle": ["Tangled Up", "Score a Tangle with one of the odd shapes."],
  "aw.rocket": ["Lift-off", "Clear a line with the Rocket."],
  "aw.inferno": ["Into the Fire", "Reach level 6 — the Inferno."],
  "aw.centurion": ["Centurion", "Clear 100 lines in one game (not Zen)."],
  "aw.score50k": ["High Roller", "Score 50 000 points in one game (not Zen)."],
  "aw.sprint": ["Forty", "Finish a Sprint."],
  "aw.sprint-fast": ["Quick Hands", "Finish a Sprint in under 3 minutes."],
  "aw.daily": ["Daily Habit", "Play a Daily Tangle to the end."],
  "aw.streak3": ["Hat-trick", "Play the Daily Tangle three days in a row."],
  "aw.streak7": ["Full Week", "Play the Daily Tangle seven days in a row."],
  "aw.chaos": ["Chaos Tamer", "Clear 20 lines in Chaos."],
  "aw.zen": ["Inner Peace", "Clear 100 lines in one Zen game."],
  "aw.collector": ["Collector", "Discover all 24 pieces."],
  "aw.challenge": ["Challenge Accepted", "Beat a friend’s challenge."],
  "aw.sharer": ["Show-off", "Share a result."],
};

const CS = {
  "title.sub":
    "Klasické kostky zamotané s tvary, které v téhle hře nemají co dělat — napříč šesti světy, které se mění, jak stoupáš.",
  "btn.play": "Hrát",
  "btn.resume": "Pokračovat",
  "btn.restart": "Znovu",
  "btn.again": "Hrát znovu",
  "btn.menu": "Menu",
  "btn.share": "Sdílet",
  "btn.close": "Zavřít",
  "btn.reload": "Načíst znovu",
  "btn.pieces": "Tvary",
  "btn.awards": "Úspěchy",

  "stat.score": "Skóre",
  "stat.best": "Rekord",
  "stat.lines": "Řady",
  "stat.level": "Level",
  "stat.games": "Hry",
  "stat.time": "Čas",
  "stat.left": "Zbývá",
  "stat.bestTime": "Nejlepší čas",
  "stat.runs": "Dokončeno",
  "stat.today": "Dnes",
  "stat.streak": "Série",
  "stat.maxStreak": "Nejdelší",

  "hint.title": "Mód ← → · Hrát Enter · Otočit ↑ · Shodit mezerník · Odložit C · Svět T",
  "hint.over": "nebo stiskni <strong>R</strong> · <strong>Esc</strong> pro menu",

  "paused": "Pauza",
  "over.topout": "Konec hry",
  "over.time": "Čas vypršel!",
  "over.goal": "V cíli!",
  "over.record": "★ Nový osobní rekord ★",
  "over.todayRecord": "★ Dnešní rekord ★",
  "over.personalBest": "Osobní rekord: {v}",
  "over.todayBest": "Dnešní rekord: {v}",
  "over.sprintShort": "{n} ze 40 řad",

  "gfx.title": "Grafika se restartovala",
  "gfx.text": "Prohlížeč vypnul 3D grafiku. Načti stránku znovu — tvůj rekord zůstane uložený.",
  "webgl.text":
    "Hra kreslí své světy pomocí WebGL 2, které tento prohlížeč nebo zařízení nepodporuje. Zkus aktuální Chrome, Firefox, Safari nebo Edge, případně zapni hardwarovou akceleraci.",
  "load.text": "Hře se nepodařilo načíst světy. Zkontroluj připojení a načti stránku znovu.",

  "scene.journey": "Cesta",
  "scene.change": "změnit svět",

  "a11y.hold": "Odložená kostka: {p}",
  "a11y.next": "Následující kostky: {p}",
  "a11y.none": "žádná",
  "a11y.noneNext": "žádné",
  "a11y.modes": "Herní mód",
  "a11y.unlocked": "získáno",
  "a11y.locked": "zamčeno",
  "a11y.progress.level": "Postup do dalšího levelu",
  "a11y.progress.sprint": "Řady do cíle",
  "a11y.progress.daily": "Uplynulý čas",

  "clear.1": "Řada",
  "clear.2": "Dvě řady",
  "clear.3": "Tři řady",
  "clear.4": "TANGLE!",
  "pop.b2b": "BACK-TO-BACK",
  "pop.combo": "{n}× KOMBO",
  "pop.perfect": "ČISTÁ DESKA",
  "pop.level": "LEVEL {n}",
  "pop.sweep": "SMETENO",
  "pop.goal": "40 ŘAD!",
  "pop.time": "ČAS!",

  "mode.marathon": "Maraton",
  "mode.daily": "Denní",
  "mode.sprint": "Sprint",
  "mode.chaos": "Chaos",
  "mode.zen": "Zen",
  "mode.dailyFull": "Denní Tangle #{n}",
  "desc.marathon": "Projdi všech šest světů. Divných tvarů s každým levelem přibývá.",
  "desc.daily": "3 minuty, dnes pro všechny stejné kostky. Zamotanost {p} %.",
  "desc.sprint": "Smaž 40 řad co nejrychleji.",
  "desc.chaos": "Všechny divné tvary hned od první kostky.",
  "desc.zen": "Žádný konec hry, žádné zrychlování — plná deska se smete. Jen světy a hudba.",

  "daily.next": "Další Tangle za {t}",
  "daily.done": "Dnes odehráno — překonej se, nebo přijď zítra.",

  "challenge.score": "Výzva: překonej <strong>{v}</strong> se stejnými kostkami",
  "challenge.time": "Výzva: dokonči rychleji než za <strong>{v}</strong> se stejnými kostkami",
  "challenge.won": "Výzva splněna! 🎉",
  "challenge.short": "Na výzvu chybí {d}",
  "challenge.slower": "O {d} pomaleji než výzva",
  "challenge.unfinished": "Výzva nesplněna — zkus to znovu",
  "challenge.deal": "Hraješ se stejnými kostkami jako ve hře, kterou ti někdo poslal",
  "challenge.drop": "Hrát raději vlastní kostky",

  "toast.piece": "Nový tvar",
  "toast.award": "Úspěch",
  "toast.copied": "Zkopírováno — vlož to kamkoli",
  "toast.shareFail": "Sdílení se nepovedlo",

  "col.title": "Tvary",
  "col.count": "Objeveno {n} z {total}",
  "col.placed": "položeno {n}×",
  "col.unknown": "Zatím neobjeveno",
  "col.classic": "Klasika",
  "col.common": "Běžný",
  "col.uncommon": "Méně častý",
  "col.rare": "Vzácný",
  "col.more": "Vše o tvarech",
  "col.link": "tvary/",

  "aw.title": "Úspěchy",
  "aw.count": "Odemčeno {n} z {total}",

  "share.score": "Tangletris {mode}: {points}, {lines}, level {level}. Máš stejné kostky — překonáš to?",
  "share.sprint": "Tangletris Sprint: 40 řad za {time}. Máš stejné kostky — dáš to rychleji?",
  "share.daily": "Tangletris Denní #{n} 🧩\n{score} · {lines} · zamotanost {p} %",
  "share.streak": "\n🔥 série {days}",
  "share.cardLines": "{lines} · level {level}",
  "share.cardBeat": "Překonáš to?",

  "aw.first-clear": ["První řada", "Smaž svou první řadu."],
  "aw.tangle": ["Tangle!", "Smaž čtyři řady najednou."],
  "aw.b2b": ["Dvakrát za sebou", "Udělej dva Tangly po sobě."],
  "aw.perfect": ["Čistý stůl", "Vyprázdni celou desku."],
  "aw.combo5": ["V ráži", "Smaž řady pěti kostkami za sebou."],
  "aw.odd-tangle": ["Zamotaný", "Udělej Tangle jedním z divných tvarů."],
  "aw.rocket": ["Start!", "Smaž řadu Raketou."],
  "aw.inferno": ["Do ohně", "Dostaň se na level 6 — do Inferna."],
  "aw.centurion": ["Stovka", "Smaž 100 řad v jedné hře (mimo Zen)."],
  "aw.score50k": ["Velké číslo", "Získej 50 000 bodů v jedné hře (mimo Zen)."],
  "aw.sprint": ["Čtyřicítka", "Dokonči Sprint."],
  "aw.sprint-fast": ["Rychlé ruce", "Dokonči Sprint za méně než 3 minuty."],
  "aw.daily": ["Denní rituál", "Dohraj Denní Tangle."],
  "aw.streak3": ["Hattrick", "Hraj Denní Tangle tři dny po sobě."],
  "aw.streak7": ["Celý týden", "Hraj Denní Tangle sedm dní po sobě."],
  "aw.chaos": ["Krotitel chaosu", "Smaž 20 řad v Chaosu."],
  "aw.zen": ["Vnitřní klid", "Smaž 100 řad v jedné Zen hře."],
  "aw.collector": ["Sběratel", "Objev všech 24 tvarů."],
  "aw.challenge": ["Výzva přijata", "Překonej výzvu od kamaráda."],
  "aw.sharer": ["Pochlub se", "Sdílej svůj výsledek."],
};

const STRINGS = LANG === "cs" ? CS : EN;

// t("key", { n: 3 }) — {name} placeholders are filled from vars.
export function t(key, vars) {
  let s = key in STRINGS ? STRINGS[key] : key in EN ? EN[key] : key;
  if (vars && typeof s === "string") {
    s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  }
  return s;
}

// English: one / other. Czech: one / 2–4 / 5 and up (and 0).
function form(n, forms) {
  if (LANG === "cs") return n === 1 ? forms[0] : n >= 2 && n <= 4 ? forms[1] : forms[2];
  return n === 1 ? forms[0] : forms[1];
}

const LINES = { en: ["line", "lines"], cs: ["řada", "řady", "řad"] };
const DAYS = { en: ["day", "days"], cs: ["den", "dny", "dní"] };
const POINTS = { en: ["point", "points"], cs: ["bod", "body", "bodů"] };

// 18,430 in English, 18 430 in Czech — the gap a no-break space, so a score
// never splits across two lines.
export function fmtNumber(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, LANG === "cs" ? "\u00a0" : ",");
}

export function linesText(n) {
  return n + " " + form(n, LINES[LANG]);
}

export function daysText(n) {
  return n + " " + form(n, DAYS[LANG]);
}

export function pointsText(n) {
  return fmtNumber(n) + " " + form(n, POINTS[LANG]);
}

export function pieceName(p) {
  return LANG === "cs" ? p.cs : p.name;
}
