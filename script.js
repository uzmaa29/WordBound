const FREE_HINTS = { easy: 4, medium: 3, hard: 1 };

const DIFFICULTY_RANGE = { easy: [3, 4], medium: [4, 5], hard: [7, 12] };
const DIFFICULTIES = ['easy', 'medium', 'hard'];

const BASE_SCORE = 100;
const HINT_PENALTY = 10;
const INVALID_PENALTY = 5;
const TIME_BONUS = 50;
const SECONDS_PER_OPTIMAL_MOVE = 20;
const SPEED_DEMON_LIMIT = 30;
const LEADERBOARD_SIZE = 10;

const KEYS = {
  leaderboard: 'wordbound_leaderboard',
  stats: 'wordbound_stats',
  achievements: 'wordbound_achievements',
  theme: 'wordbound_theme',
};

const TABS = {
  'daily-easy': { title: 'Daily Easy', sub: '4 letters · Easy', daily: 'easy' },
  'daily-hard': { title: 'Daily Hard', sub: '4 letters · Hard', daily: 'hard' },
  'unlimited':  { title: 'Unlimited',  sub: '4 letters · Random difficulty' },
};

const words = { 4: [], 5: [] };
const wordSets = { 4: new Set(), 5: new Set() };
const graphCache = {};
let sessionCompleted = 0;

const state = {
  puzzle: null,
  ladder: [],
  moves: 0,
  hintsUsed: 0,
  hintsOnCurrent: 0,
  hintsLeft: 0,
  invalid: 0,
  startTime: 0,
  endTime: null,
  finished: false,
  timerId: null,
  tab: 'daily-easy',
  lbMode: 4,
  lastResult: null,
};

const $ = id => document.getElementById(id);

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : JSON.parse(JSON.stringify(fallback));
  } catch (e) {
    return JSON.parse(JSON.stringify(fallback));
  }
}

function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { }
}

function defaultStats() {
  return {
    started: 0,
    completed: 0,
    completedByMode: { 4: 0, 5: 0 },
    bestTime: { 4: null, 5: null },
    bestScore: { 4: 0, 5: 0 },
    hintFreeCompleted: 0,
    totalHints: 0,
    totalInvalid: 0,
    dailyStreak: 0,
    lastDailyDate: null,
    dailyDone: { easy: null, hard: null },
    flags: { perfectLadder: false, minimalist: false, noMistakes: false, speedDemon: false },
  };
}

function getStats() {
  const s = { ...defaultStats(), ...load(KEYS.stats, {}) };
  s.dailyDone = { ...defaultStats().dailyDone, ...(s.dailyDone || {}) };
  return s;
}

function dateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function yesterdayKey() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return dateKey(d);
}

function formatTime(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = String(totalSeconds % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString();
}

async function loadWords() {
  const res = await fetch('words.json');
  if (!res.ok) throw new Error('words.json could not be loaded');
  const data = await res.json();
  for (const len of [4, 5]) {
    const raw = data[len === 4 ? 'four' : 'five'] || [];
    const clean = [...new Set(raw.map(w => String(w).trim().toUpperCase()))]
      .filter(w => w.length === len && /^[A-Z]+$/.test(w));
    words[len] = clean;
    wordSets[len] = new Set(clean);
  }
}

function countDifferences(a, b) {
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) diff++;
  }
  return diff;
}

function diffPositions(a, b) {
  const positions = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) positions.push(i);
  }
  return positions;
}

function getGraph(len) {
  if (graphCache[len]) return graphCache[len];
  const list = words[len];
  const graph = new Map(list.map(w => [w, []]));
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (countDifferences(list[i], list[j]) === 1) {
        graph.get(list[i]).push(list[j]);
        graph.get(list[j]).push(list[i]);
      }
    }
  }
  graphCache[len] = graph;
  return graph;
}

function bfsDistances(source, graph) {
  const dist = new Map([[source, 0]]);
  const queue = [source];
  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    for (const neighbour of graph.get(current)) {
      if (!dist.has(neighbour)) {
        dist.set(neighbour, dist.get(current) + 1);
        queue.push(neighbour);
      }
    }
  }
  return dist;
}

function seededRandom(seedText) {
  let h = 2166136261;
  for (const ch of seedText) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return (h >>> 0) / 4294967296;
  };
}

function findPuzzle(len, minD, maxD, rng) {
  const graph = getGraph(len);
  const list = words[len];
  for (let attempt = 0; attempt < 300; attempt++) {
    const target = list[Math.floor(rng() * list.length)];
    const dist = bfsDistances(target, graph);
    const candidates = [];
    dist.forEach((d, word) => {
      if (d >= minD && d <= maxD) candidates.push(word);
    });
    if (candidates.length > 0) {
      const start = candidates[Math.floor(rng() * candidates.length)];
      return { start, target, optimal: dist.get(start), distToTarget: dist };
    }
  }
  return null;
}

function generatePuzzle(len, difficulty, rng) {
  const [minD, maxD] = DIFFICULTY_RANGE[difficulty];
  const puzzle = findPuzzle(len, minD, maxD, rng) || findPuzzle(len, minD, Infinity, rng);
  if (!puzzle) throw new Error('Could not generate a puzzle for this word list.');
  return puzzle;
}

function findNextMove(current, distToTarget, used) {
  const graph = getGraph(current.length);
  const currentDist = distToTarget.get(current);
  const options = graph.get(current).filter(
    w => distToTarget.get(w) === currentDist - 1 && !used.includes(w)
  );
  return options.length > 0 ? options[0] : null;
}

function computeScore({ optimal, moves, hints, invalid, seconds }) {
  let score = BASE_SCORE;
  const extraMoves = Math.max(0, moves - optimal);
  score += Math.max(0, 30 - 5 * extraMoves);
  score -= hints * HINT_PENALTY;
  score -= invalid * INVALID_PENALTY;
  if (seconds <= optimal * SECONDS_PER_OPTIMAL_MOVE) score += TIME_BONUS;
  return Math.max(10, score);
}

const ACHIEVEMENTS = [
  { id: 'first_steps', icon: '👣', name: 'First Steps', description: 'Complete your first puzzle.',
    progress: c => ({ current: c.stats.completed, target: 1 }) },
  { id: 'word_explorer', icon: '🧭', name: 'Word Explorer', description: 'Complete 5 puzzles.',
    progress: c => ({ current: c.stats.completed, target: 5 }) },
  { id: 'getting_better', icon: '📈', name: 'Getting Better', description: 'Complete 10 puzzles.',
    progress: c => ({ current: c.stats.completed, target: 10 }) },
  { id: 'word_enthusiast', icon: '📚', name: 'Word Enthusiast', description: 'Complete 25 puzzles.',
    progress: c => ({ current: c.stats.completed, target: 25 }) },
  { id: 'perfect_ladder', icon: '🪜', name: 'Perfect Ladder', description: 'Complete a puzzle without using any hints.',
    progress: c => ({ current: c.stats.flags.perfectLadder ? 1 : 0, target: 1 }) },
  { id: 'minimalist', icon: '🎯', name: 'Minimalist', description: 'Complete a puzzle using the minimum possible number of moves.',
    progress: c => ({ current: c.stats.flags.minimalist ? 1 : 0, target: 1 }) },
  { id: 'no_mistakes', icon: '✅', name: 'No Mistakes', description: 'Complete a puzzle without submitting an invalid word.',
    progress: c => ({ current: c.stats.flags.noMistakes ? 1 : 0, target: 1 }) },
  { id: 'speed_demon', icon: '⚡', name: 'Speed Demon', description: 'Complete a puzzle in under 30 seconds.',
    progress: c => ({ current: c.stats.flags.speedDemon ? 1 : 0, target: 1 }) },
  { id: 'independent_thinker', icon: '🧠', name: 'Independent Thinker', description: 'Complete 5 puzzles without using hints.',
    progress: c => ({ current: c.stats.hintFreeCompleted, target: 5 }) },
  { id: 'four_master', icon: '4️⃣', name: 'Four Letter Master', description: 'Complete 10 four-letter puzzles.',
    progress: c => ({ current: c.stats.completedByMode[4], target: 10 }) },
  { id: 'five_master', icon: '5️⃣', name: 'Five Letter Master', description: 'Complete 10 five-letter puzzles.',
    progress: c => ({ current: c.stats.completedByMode[5], target: 10 }) },
  { id: 'word_marathon', icon: '🏃', name: 'Word Marathon', description: 'Complete 5 puzzles in one session.',
    progress: c => ({ current: c.sessionCompleted, target: 5 }) },
  { id: 'daily_dedication', icon: '📅', name: 'Daily Dedication', description: 'Complete daily challenges for 7 consecutive days.',
    progress: c => ({ current: c.stats.dailyStreak, target: 7 }) },
  { id: 'consistency_king', icon: '👑', name: 'Consistency King', description: 'Maintain a 14-day daily challenge streak.',
    progress: c => ({ current: c.stats.dailyStreak, target: 14 }) },
];

function checkAchievements(stats) {
  const data = load(KEYS.achievements, { unlocked: {}, latest: null });
  const ctx = { stats, sessionCompleted };
  const newlyUnlocked = [];
  for (const a of ACHIEVEMENTS) {
    if (data.unlocked[a.id]) continue;
    const { current, target } = a.progress(ctx);
    if (current >= target) {
      data.unlocked[a.id] = new Date().toISOString();
      data.latest = a.id;
      newlyUnlocked.push(a);
    }
  }
  save(KEYS.achievements, data);
  return newlyUnlocked;
}

function effectiveStreak(stats) {
  if (stats.lastDailyDate === dateKey() || stats.lastDailyDate === yesterdayKey()) {
    return stats.dailyStreak;
  }
  return 0;
}

function updateDailyStreak(stats) {
  const today = dateKey();
  if (stats.lastDailyDate === today) return;
  stats.dailyStreak = stats.lastDailyDate === yesterdayKey() ? stats.dailyStreak + 1 : 1;
  stats.lastDailyDate = today;
}

function loadTheme() {
  try {
    return localStorage.getItem(KEYS.theme) === 'dark' ? 'dark' : 'light';
  } catch (e) {
    return 'light';
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  $('theme-switch').setAttribute('aria-checked', String(theme === 'dark'));
  try { localStorage.setItem(KEYS.theme, theme); } catch (e) { }
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  applyTheme(current === 'dark' ? 'light' : 'dark');
}

function resetRunState(puzzle) {
  state.ladder = [puzzle.start];
  state.moves = 0;
  state.hintsUsed = 0;
  state.hintsOnCurrent = 0;
  state.hintsLeft = FREE_HINTS[puzzle.difficulty];
  state.invalid = 0;
  state.finished = false;
  state.endTime = null;
  state.startTime = Date.now();
}

function randomDifficulty() {
  return DIFFICULTIES[Math.floor(Math.random() * DIFFICULTIES.length)];
}

async function startPuzzle({ mode = 4, difficulty = 'medium', variant = null } = {}) {
  if (!words[4].length || !words[5].length) return;

  if (state.puzzle && !state.finished && state.moves > 0 &&
      !(await askConfirm('Start a new puzzle? Your current puzzle will be abandoned.'))) {
    return;
  }

  let puzzle;
  if (variant) {
    const today = dateKey();
    puzzle = generatePuzzle(4, variant, seededRandom(`wordbound-daily-${variant}-${today}`));
    puzzle.id = `daily-${variant}-${today}`;
    puzzle.mode = 4;
    puzzle.difficulty = variant;
    puzzle.daily = true;
    puzzle.variant = variant;
  } else {
    puzzle = generatePuzzle(mode, difficulty, Math.random);
    puzzle.id = `${mode}-${difficulty}-${Date.now()}`;
    puzzle.mode = mode;
    puzzle.difficulty = difficulty;
    puzzle.daily = false;
    puzzle.variant = null;
  }

  state.puzzle = puzzle;
  resetRunState(puzzle);

  const stats = getStats();
  stats.started++;
  save(KEYS.stats, stats);

  showView('game');
  renderGame(false);
  startTimer();
  $('word-input').focus();
  showMessage(`Start at ${puzzle.start}. Reach ${puzzle.target}, one letter at a time.`, 'info');
}

function submitWord() {
  if (!state.puzzle || state.finished) return;
  const input = $('word-input');
  const word = input.value.trim().toUpperCase();
  const len = state.puzzle.mode;
  const prev = state.ladder[state.ladder.length - 1];

  if (!word) {
    showMessage('Type a word first.', 'info');
    return;
  }

  if (word.length !== len || !/^[A-Z]+$/.test(word)) {
    return rejectWord('That word has the wrong number of letters.');
  }

  if (!wordSets[len].has(word)) {
    return rejectWord("That's not a valid word.");
  }

  if (state.ladder.includes(word)) {
    return rejectWord("You've already used that word.");
  }
  if (countDifferences(prev, word) !== 1) {
    return rejectWord('You can only change one letter at a time.');
  }

  const newDist = state.puzzle.distToTarget.get(word);
  if (newDist === undefined) {
    return rejectWord("That word can't lead to the target. Try a different route.");
  }

  state.ladder.push(word);
  state.moves++;
  state.hintsOnCurrent = 0;
  input.value = '';
  renderGame(true);

  if (word === state.puzzle.target) {
    completePuzzle();
    return;
  }
  const prevDist = state.puzzle.distToTarget.get(prev);
  showMessage(
    newDist < prevDist ? "You're getting closer!" : 'Nice move. Keep climbing.',
    'success'
  );
}

function rejectWord(text) {
  state.invalid++;
  showMessage(text, 'error');
  const input = $('word-input');
  input.classList.remove('shake');
  void input.offsetWidth;
  input.classList.add('shake');
}

function useHint() {
  if (!state.puzzle || state.finished) return;
  if (state.hintsLeft <= 0) {
    showMessage('No free hints left. You can still do it!', 'info');
    return;
  }
  const current = state.ladder[state.ladder.length - 1];
  const next = findNextMove(current, state.puzzle.distToTarget, state.ladder);
  if (!next) {
    showMessage('No clear clue from here. Try a different letter change.', 'info');
    return;
  }

  const pos = diffPositions(current, next)[0];
  const level = Math.min(state.hintsOnCurrent, 2);
  let text;
  if (level === 0) {
    text = `Try changing the ${ordinal(pos)} letter.`;
  } else if (level === 1) {
    text = `The ${ordinal(pos)} letter should become "${next[pos]}".`;
  } else {
    text = `The next word is ${next}.`;
  }

  state.hintsOnCurrent++;
  state.hintsUsed++;
  state.hintsLeft--;
  showMessage(`💡 ${text} (−${HINT_PENALTY} points)`, 'hint');
}

function ordinal(index) {
  return ['first', 'second', 'third', 'fourth', 'fifth'][index] || `#${index + 1}`;
}

async function resetPuzzle() {
  if (!state.puzzle) return;
  if (!(await askConfirm('Reset this puzzle? Your ladder, moves and hints will be cleared.'))) return;
  resetRunState(state.puzzle);
  renderGame(false);
  startTimer();
  $('word-input').value = '';
  showMessage('Puzzle reset. Same start and target. Good luck!', 'info');
}

function completePuzzle() {
  state.finished = true;
  state.endTime = Date.now();
  stopTimer();

  const p = state.puzzle;
  const seconds = Math.max(1, Math.round((state.endTime - state.startTime) / 1000));
  const score = computeScore({
    optimal: p.optimal, moves: state.moves, hints: state.hintsUsed,
    invalid: state.invalid, seconds,
  });

  const result = {
    puzzleId: p.id, mode: p.mode, difficulty: p.difficulty, daily: p.daily, variant: p.variant,
    moves: state.moves, optimal: p.optimal, hints: state.hintsUsed,
    invalid: state.invalid, seconds, score, path: state.ladder.slice(),
    date: new Date().toISOString(),
  };

  const stats = getStats();
  stats.completed++;
  stats.completedByMode[p.mode]++;
  stats.totalHints += state.hintsUsed;
  stats.totalInvalid += state.invalid;
  if (state.hintsUsed === 0) {
    stats.hintFreeCompleted++;
    stats.flags.perfectLadder = true;
  }
  if (state.moves === p.optimal) stats.flags.minimalist = true;
  if (state.invalid === 0) stats.flags.noMistakes = true;
  if (seconds < SPEED_DEMON_LIMIT) stats.flags.speedDemon = true;
  if (stats.bestTime[p.mode] === null || seconds < stats.bestTime[p.mode]) {
    stats.bestTime[p.mode] = seconds;
  }
  if (score > stats.bestScore[p.mode]) stats.bestScore[p.mode] = score;
  if (p.daily) {
    stats.dailyDone[p.variant] = dateKey();
    updateDailyStreak(stats);
  }
  save(KEYS.stats, stats);

  sessionCompleted++;
  const newlyUnlocked = checkAchievements(stats);

  state.lastResult = result;
  autoSaveToLeaderboard(result);
  showVictory(result, newlyUnlocked);
}

function autoSaveToLeaderboard(r) {
  const board = load(KEYS.leaderboard, []);
  if (board.some(e => e.puzzleId === r.puzzleId)) return;
  board.push({ mode: r.mode, moves: r.moves, optimal: r.optimal, hints: r.hints,
               seconds: r.seconds, score: r.score, date: r.date, puzzleId: r.puzzleId });
  board.sort(compareEntries);
  save(KEYS.leaderboard, board.slice(0, 200));
}

function compareEntries(a, b) {
  return (b.score - a.score) || (a.seconds - b.seconds);
}

function renderLeaderboard() {
  document.querySelectorAll('[data-lb]').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.lb) === state.lbMode);
  });
  const board = load(KEYS.leaderboard, [])
    .filter(e => e.mode === state.lbMode)
    .sort(compareEntries)
    .slice(0, LEADERBOARD_SIZE);

  const body = $('lb-body');
  body.innerHTML = '';
  if (board.length === 0) {
    body.innerHTML = '<tr><td colspan="6" class="empty">No scores yet. Finish a puzzle to get on the board!</td></tr>';
    return;
  }
  board.forEach((e, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${e.score}</td>
      <td>${e.moves}/${e.optimal}</td>
      <td>${e.hints}</td>
      <td>${formatTime(e.seconds)}</td>
      <td>${formatDate(e.date)}</td>`;
    body.appendChild(tr);
  });
}

function elapsedSeconds() {
  const end = state.finished && state.endTime ? state.endTime : Date.now();
  return Math.floor((end - state.startTime) / 1000);
}

function startTimer() {
  stopTimer();
  updateTimer();
  state.timerId = setInterval(updateTimer, 1000);
}

function stopTimer() {
  clearInterval(state.timerId);
  state.timerId = null;
}

function updateTimer() {
  $('game-timer').textContent = formatTime(elapsedSeconds());
}

function askConfirm(text) {
  return new Promise(resolve => {
    $('modal-text').textContent = text;
    $('modal').hidden = false;
    const finish = answer => {
      $('modal').hidden = true;
      $('modal-ok').onclick = null;
      $('modal-cancel').onclick = null;
      resolve(answer);
    };
    $('modal-ok').onclick = () => finish(true);
    $('modal-cancel').onclick = () => finish(false);
    $('modal-ok').focus();
  });
}

function showView(name) {
  document.querySelectorAll('.view').forEach(v => {
    v.hidden = v.id !== 'view-' + name;
  });
  $('site-header').hidden = name === 'intro';
  if (name !== 'game') stopTimer();
  window.scrollTo(0, 0);
}

function showMessage(text, type = 'info') {
  const el = $('message');
  el.textContent = text;
  el.className = 'message ' + type;
}

function renderGame(animateLast) {
  const p = state.puzzle;
  if (!p) return;

  $('game-mode-label').textContent = p.daily
    ? `Daily ${capitalise(p.variant)}`
    : `${p.mode} Letters · ${capitalise(p.difficulty)}`;
  $('target-word').textContent = p.target;

  const input = $('word-input');
  input.maxLength = p.mode;
  input.placeholder = `Next ${p.mode}-letter word`;
  input.disabled = state.finished;
  $('btn-submit').disabled = state.finished;
  $('btn-hint').disabled = state.finished;

  renderLadder($('ladder'), state.ladder, {
    goal: state.finished ? null : p.target,
    animateLast,
  });
  updateTimer();
}

function renderLadder(container, path, { goal = null, animateLast = false } = {}) {
  container.innerHTML = '';
  path.forEach((word, i) => {
    const row = makeBrickRow(word, i === 0 ? 'start' : '');
    if (animateLast && i === path.length - 1 && path.length > 1) row.classList.add('new');
    container.appendChild(row);
  });
  if (goal) container.appendChild(makeBrickRow(goal, 'goal'));
  container.scrollTop = container.scrollHeight;
}

function makeBrickRow(word, kind) {
  const row = document.createElement('div');
  row.className = 'brick-row ' + kind;
  [...word].forEach((letter, i) => {
    const brick = document.createElement('div');
    brick.className = 'brick';
    brick.style.animationDelay = (i * 0.08) + 's';
    brick.textContent = letter;
    row.appendChild(brick);
  });
  return row;
}

function capitalise(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function showVictory(result, newlyUnlocked) {
  $('final-score').textContent = `${result.score} pts`;
  $('victory-stats').innerHTML = [
    ['Moves', `${result.moves} (best ${result.optimal})`],
    ['Hints', result.hints],
    ['Time', formatTime(result.seconds)],
  ].map(([label, value]) =>
    `<div><span class="label">${label}</span><strong>${value}</strong></div>`
  ).join('');

  renderLadder($('victory-ladder'), result.path, {});
  $('btn-next').textContent = result.daily ? 'Back to Menu' : 'Next';

  showView('victory');
  newlyUnlocked.forEach((a, i) => setTimeout(() => showToast(a), i * 900));
}

function goNext() {
  const r = state.lastResult;
  if (!r || r.daily) {
    navigate('menu');
    return;
  }
  startPuzzle({ mode: r.mode, difficulty: r.difficulty });
}

function showToast(a) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `
    <div class="badge">${a.icon}</div>
    <div>
      <div class="toast-title">Achievement unlocked!</div>
      <strong>${a.name}</strong>
      <div class="toast-desc">${a.description}</div>
    </div>`;
  $('toasts').appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 400);
  }, 4000);
}

function renderAchievements() {
  const stats = getStats();
  const data = load(KEYS.achievements, { unlocked: {}, latest: null });
  const ctx = { stats, sessionCompleted };
  const grid = $('ach-grid');
  grid.innerHTML = '';

  let unlockedCount = 0;
  for (const a of ACHIEVEMENTS) {
    const unlocked = !!data.unlocked[a.id];
    if (unlocked) unlockedCount++;
    const { current, target } = a.progress(ctx);
    const card = document.createElement('div');
    card.className = 'ach-card ' + (unlocked ? 'unlocked' : 'locked');
    card.innerHTML = `
      <div class="badge">${a.icon}</div>
      <h3>${a.name}</h3>
      <p>${a.description}</p>
      <div class="ach-meta">${unlocked
        ? '✔ Unlocked ' + formatDate(data.unlocked[a.id])
        : `Progress ${Math.min(current, target)}/${target}`}</div>`;
    grid.appendChild(card);
  }

  const overall = Math.round((unlockedCount / ACHIEVEMENTS.length) * 100);
  $('ach-percent').textContent = overall + '%';
  $('ach-overall-text').textContent = `${unlockedCount} / ${ACHIEVEMENTS.length}`;
  $('ach-overall-bar').style.width = overall + '%';

  const locked = ACHIEVEMENTS
    .filter(a => !data.unlocked[a.id])
    .map(a => ({ a, p: a.progress(ctx) }))
    .sort((x, y) => (y.p.current / y.p.target) - (x.p.current / x.p.target));
  if (locked.length) {
    const { a, p } = locked[0];
    const shown = Math.min(p.current, p.target);
    $('next-text').textContent = `Next up: ${a.icon} ${a.name} (${shown}/${p.target})`;
    $('next-bar').style.width = Math.round((shown / p.target) * 100) + '%';
  } else {
    $('next-text').textContent = 'All achievements unlocked! 🏆';
    $('next-bar').style.width = '100%';
  }
}

function renderStats() {
  const stats = getStats();
  const streak = effectiveStreak(stats);
  $('stats-grid').innerHTML = [
    ['Puzzles solved', stats.completed],
    ['Win rate', stats.started ? Math.round((stats.completed / stats.started) * 100) + '%' : '—'],
    ['Best time (4)', stats.bestTime[4] !== null ? formatTime(stats.bestTime[4]) : '—'],
    ['Best time (5)', stats.bestTime[5] !== null ? formatTime(stats.bestTime[5]) : '—'],
    ['Daily streak', `${streak} 🔥`],
  ].map(([label, value]) =>
    `<div><span class="label">${label}</span><strong>${value}</strong></div>`
  ).join('');
  renderLeaderboard();
}

function renderMenu() {
  const stats = getStats();
  const today = dateKey();
  const info = TABS[state.tab];

  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === state.tab);
  });

  let sub = info.sub;
  let disabled = false;
  if (info.daily && stats.dailyDone[info.daily] === today) {
    sub = 'Completed today ✔';
    disabled = true;
  }
  $('card-title').textContent = info.title;
  $('card-sub').textContent = sub;
  $('btn-card-play').disabled = disabled;

  const hasActive = state.puzzle && !state.finished;
  $('btn-continue').hidden = !hasActive;
  if (hasActive) {
    $('btn-continue').textContent = `Continue ${state.puzzle.start} → ${state.puzzle.target}`;
  }
}

function playCurrentTab() {
  const info = TABS[state.tab];
  if (info.daily) {
    startPuzzle({ variant: info.daily });
  } else {
    startPuzzle({ mode: 4, difficulty: randomDifficulty() });
  }
}

function navigate(target) {
  if (target === 'menu') renderMenu();
  if (target === 'stats') renderStats();
  if (target === 'achievements') renderAchievements();
  showView(target);
}

function wireEvents() {
  document.querySelectorAll('[data-go]').forEach(btn =>
    btn.addEventListener('click', () => navigate(btn.dataset.go))
  );

  $('theme-switch').addEventListener('click', toggleTheme);

  $('btn-play').addEventListener('click', () => navigate('menu'));

  document.querySelectorAll('.tab').forEach(btn =>
    btn.addEventListener('click', () => {
      state.tab = btn.dataset.tab;
      renderMenu();
    })
  );
  $('btn-card-play').addEventListener('click', playCurrentTab);
  $('btn-five').addEventListener('click', () =>
    startPuzzle({ mode: 5, difficulty: randomDifficulty() })
  );

  $('btn-continue').addEventListener('click', () => {
    showView('game');
    renderGame(false);
    startTimer();
    $('word-input').focus();
  });

  $('btn-submit').addEventListener('click', submitWord);
  $('word-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') submitWord();
  });
  $('btn-hint').addEventListener('click', useHint);
  $('btn-reset').addEventListener('click', resetPuzzle);

  $('btn-next').addEventListener('click', goNext);

  document.querySelectorAll('[data-lb]').forEach(btn =>
    btn.addEventListener('click', () => {
      state.lbMode = Number(btn.dataset.lb);
      renderLeaderboard();
    })
  );
}

function buildMockGrid() {
  const grid = $('mock-grid');
  for (let i = 0; i < 20; i++) {
    const tile = document.createElement('span');
    tile.className = 'mock-tile' + (i % 6 === 2 || i % 7 === 4 ? ' alt' : '');
    grid.appendChild(tile);
  }
}

async function init() {
  applyTheme(loadTheme());
  buildMockGrid();
  wireEvents();
  try {
    await loadWords();
    $('load-error').hidden = true;
  } catch (err) {
    $('load-error').hidden = false;
    console.error(err);
  }
  renderMenu();
  showView('intro');
}

document.addEventListener('DOMContentLoaded', init);
