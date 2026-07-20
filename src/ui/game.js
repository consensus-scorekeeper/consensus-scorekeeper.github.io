// The game screen: renderGame orchestrates everything (jailbreak rebuild,
// scoreboard, question + player panels, sidebar) after every state change
// (it's the single subscriber wired in main/legacy). The navigation +
// padQuestionsToSlots + start/back live here too because they're tightly
// coupled to the game lifecycle.

import { state, subscribe } from '../state.js';
import { escapeHtml } from '../util/escape.js';
import { issueSlotSet } from '../parser/diagnostics.js';
import { rebuildJailbreakLocks } from '../game/jailbreak.js';
import { getInitials, getAnsweredBy } from '../game/categories.js';
import { saveState } from '../game/persistence.js';
import { syncInlinePdfToQuestion } from './pdf-viewer.js';
import { pushScoreboardUpdate } from './scoreboard-popout.js';
import { reconcileRoom, syncRoom, preselectIndex } from './room.js';
import { attachDragReorder } from './drag-reorder.js';

// Pads `state.questions` from the flat parsed list to a slot-indexed array
// (slot i = question number i+1). Called by startGame and reparseCurrentPdf.
export function padQuestionsToSlots() {
  if (state.hasQuestions && state.questions.length > 0) {
    const parsed = new Map(state.questions.map(q => [q.num, q]));
    const maxNum = Math.max(100, ...state.questions.map(q => q.num));
    state.questions = [];
    for (let i = 1; i <= maxNum; i++) {
      state.questions.push(parsed.get(i) || { num: i, question: '', answer: '', answerHtml: '', category: null, posInCategory: null, isMissing: true });
    }
  } else {
    state.questions = [];
    for (let i = 1; i <= 100; i++) {
      state.questions.push({ num: i, question: '', answer: '', answerHtml: '', category: null, posInCategory: null });
    }
  }
}

export function startGame() {
  state.teamA.name = document.getElementById('team-a-name').value.trim() || 'Team A';
  state.teamB.name = document.getElementById('team-b-name').value.trim() || 'Team B';
  // Empty rosters are allowed (confirmed, to catch mistakes): a moderator
  // can start the game, open a buzzer room, and add players to teams as
  // they join with the room code.
  if (state.teamA.players.length === 0 && state.teamB.players.length === 0) {
    if (!confirm('No players on either team yet. Start anyway? You can add players to teams as they join a buzzer room.')) {
      return;
    }
  }
  state.teamA.score = 0;
  state.teamB.score = 0;
  state.teamA.players.forEach(p => p.points = 0);
  state.teamB.players.forEach(p => p.points = 0);
  state.currentQuestion = 0;
  state.history = [];
  state.answeredQuestions = new Set();

  padQuestionsToSlots();

  // Build streak groups from parsed streakRange data.
  // A streak is a single parsed question that spans multiple question numbers
  // (e.g., Q80 with streakRange {start:80, end:81} means it covers slots 80-81).
  state.streakGroups = {};
  for (const q of state.questions) {
    if (q.streakRange) {
      const startIdx = q.streakRange.start - 1;
      const endIdx = q.streakRange.end - 1;
      for (let si = startIdx; si <= endIdx; si++) {
        state.questions[si].isStreak = true;
        state.questions[si].streakGroupStart = startIdx;
        // Copy streak data to placeholder slots
        if (si !== startIdx) {
          state.questions[si].category = q.category;
        }
      }
      const members = [];
      for (let si = startIdx; si <= endIdx; si++) members.push(si);
      state.streakGroups[startIdx] = { start: startIdx, end: endIdx, members, category: q.category, sourceQuestion: q };
    }
  }
  state.streakScoring = {};
  document.getElementById('setup').style.display = 'none';
  document.getElementById('game').style.display = 'block';
  renderGame();
}

export function backToSetup() {
  document.getElementById('setup').style.display = 'block';
  document.getElementById('game').style.display = 'none';
}

export function renderGame() {
  rebuildJailbreakLocks();
  reconcileRoom();  // drop stale buzz preselects BEFORE panels render
  document.getElementById('game-team-a-name').textContent = state.teamA.name;
  document.getElementById('game-team-b-name').textContent = state.teamB.name;
  document.getElementById('score-a').textContent = state.teamA.score;
  document.getElementById('score-b').textContent = state.teamB.score;
  renderQuestion();
  renderPlayerPanel('a');
  renderPlayerPanel('b');
  document.getElementById('undo-btn').disabled = state.history.length === 0;
  saveState();
  pushScoreboardUpdate();
  syncRoom();  // push snapshot/arm/qlog to phone buzzers + redraw room UI
}

export function renderQuestion() {
  const q = state.questions[state.currentQuestion];
  const hasContent = state.hasQuestions && q && q.question;

  // Inline PDF auto-follows the current question's page (no-op if no PDF loaded).
  syncInlinePdfToQuestion();

  // Category instructions (e.g., "Set of 3: Before and After" explainer text).
  // Shown on every question in a category that has them.
  const instrEl = document.getElementById('q-instructions');
  let instrText = q && q.categoryInstructions;
  if (!instrText && q && q.isStreak && q.streakGroupStart != null) {
    // Streak slots store category data on the source question; fall back to that.
    const sg = state.streakGroups[q.streakGroupStart];
    instrText = sg && sg.sourceQuestion && sg.sourceQuestion.categoryInstructions;
  }
  if (instrText) {
    instrEl.textContent = instrText;
    instrEl.style.display = 'block';
  } else {
    instrEl.style.display = 'none';
    instrEl.textContent = '';
  }

  // Reveal note that followed this question's answer in the pack (e.g. a
  // Mystery set's "(The theme was …)"). Streak slots carry it on the source
  // question, like instructions above.
  const revealEl = document.getElementById('q-reveal');
  let revealText = q && q.categoryReveal;
  if (!revealText && q && q.isStreak && q.streakGroupStart != null) {
    const sg = state.streakGroups[q.streakGroupStart];
    revealText = sg && sg.sourceQuestion && sg.sourceQuestion.categoryReveal;
  }
  if (revealText) {
    revealEl.textContent = revealText;
    revealEl.style.display = 'block';
  } else {
    revealEl.style.display = 'none';
    revealEl.textContent = '';
  }

  if (q && q.isStreak) {
    // Streak group display
    document.getElementById('q-answered-by').style.display = 'none';
    const groupStart = q.streakGroupStart;
    const group = state.streakGroups[groupStart];
    const catEl = document.getElementById('q-category');
    catEl.textContent = q.category || 'Streaks';
    catEl.style.display = 'block';

    // Show the streak question and its answers
    const src = group.sourceQuestion;
    const rangeLabel = `${group.start + 1}-${group.end + 1}`;
    let contentHtml = `<div style="margin-bottom:6px"><strong>${rangeLabel}.</strong> ${escapeHtml(src.question)}</div>`;
    if (src.answerHtml) {
      const html = src.answerHtml;
      if (html.startsWith('<div>')) {
        contentHtml += `<div style="margin-left:20px">${html}</div>`;
      } else {
        contentHtml += `<div style="margin-left:20px">Answer: ${html}</div>`;
      }
    }
    document.getElementById('q-text').innerHTML = contentHtml;
    document.getElementById('q-answer').innerHTML = '';

    // Show streak scoring info — one row per team that has accumulated points.
    const streakKey = groupStart;
    const streakInfo = state.streakScoring[streakKey];
    const streakStatusEl = document.getElementById('streak-status');
    const rows = [];
    if (streakInfo) {
      for (const t of ['a', 'b']) {
        const e = streakInfo[t];
        if (!e || e.totalPoints <= 0) continue;
        const tObj = t === 'a' ? state.teamA : state.teamB;
        const pName = tObj.players[e.playerIndex]?.name || '?';
        rows.push(`<div><strong>${escapeHtml(pName)}</strong> has <strong>${e.totalPoints}</strong> points on this streak &nbsp; <button class="btn" style="padding:3px 10px;font-size:0.85rem;background:#e0e0e0" data-action="reset-streak" data-streak-key="${streakKey}" data-team="${t}">Reset to 0</button></div>`);
      }
    }
    if (rows.length) {
      streakStatusEl.innerHTML = rows.join('');
      streakStatusEl.style.display = 'block';
    } else {
      streakStatusEl.innerHTML = '';
      streakStatusEl.style.display = 'none';
    }
  } else if (q) {
    // Normal question display
    document.getElementById('streak-status').style.display = 'none';
    const catEl = document.getElementById('q-category');
    if (q.category) {
      catEl.textContent = q.category + (q.posInCategory ? ` (${q.posInCategory})` : '');
      catEl.style.display = 'block';
    } else {
      catEl.style.display = 'none';
    }
    const qText = hasContent ? q.question : '(No question text available)';
    document.getElementById('q-text').textContent = `${q.num}. ${qText}`;
    const ansEl = document.getElementById('q-answer');
    if (hasContent && q.answer) {
      const html = q.answerHtml || escapeHtml(q.answer);
      if (html.startsWith('<div>Answer:')) {
        ansEl.innerHTML = html;
      } else {
        ansEl.innerHTML = `<span class="answer-label">Answer: </span>${html}`;
      }
    } else {
      ansEl.innerHTML = '';
    }
    // Show who answered
    const answeredByEl = document.getElementById('q-answered-by');
    const info = getAnsweredBy(state.currentQuestion);
    if (info) {
      const color = info.teamLetter === 'a' ? '#2563eb' : '#dc2626';
      answeredByEl.innerHTML = `<span style="color:${color}">&#9632;</span> Answered by <strong>${escapeHtml(info.name)}</strong> (${escapeHtml(info.team)}) for +${info.points} <button class="btn btn-clear" style="margin-left:8px;padding:2px 10px;font-size:0.8rem;" data-action="clear-current-question" title="Remove this assignment (keybind: c)">Clear (c)</button>`;
      answeredByEl.style.display = 'block';
    } else {
      answeredByEl.style.display = 'none';
    }
  }

  // Per-slot parse warnings (from the pack's suspected-parsing-issues
  // report). For streak slots, any issue on any member slot applies.
  const warnEl = document.getElementById('q-parse-warning');
  if (warnEl) {
    let slotNums = [];
    if (q && q.isStreak && q.streakGroupStart != null) {
      const sg = state.streakGroups[q.streakGroupStart];
      slotNums = sg ? sg.members.map(m => state.questions[m].num) : [q.num];
    } else if (q) {
      slotNums = [q.num];
    }
    const slotWarnings = (state.parseIssues || []).filter(issue =>
      (typeof issue.slot === 'number' && slotNums.includes(issue.slot)) ||
      (Array.isArray(issue.slots) && slotNums.some(n => n >= issue.slots[0] && n <= issue.slots[1])));
    if (slotWarnings.length) {
      warnEl.innerHTML = slotWarnings.map(i => `&#9888; ${escapeHtml(i.message)}`).join('<br>');
      warnEl.style.display = 'block';
    } else {
      warnEl.style.display = 'none';
      warnEl.innerHTML = '';
    }
  }

  // Build vertical sidebar with category groups
  const issueSlots = issueSlotSet(state.parseIssues);
  const sidebarEl = document.getElementById('q-sidebar');
  const groups = [];
  let currentCat = undefined;
  let currentGroup = null;

  state.questions.forEach((q, i) => {
    // Skip non-start streak questions (they're merged into a single sidebar entry)
    if (q.isStreak && q.streakGroupStart !== i) return;
    // Skip empty placeholder questions (no parsed content) — but show "missing" gaps
    if (!q.question && !q.isStreak && !q.isMissing) return;

    const cat = q.category || null;
    const isNewCategory = cat !== currentCat || (q.posInCategory === 1);
    if (isNewCategory && !q.isMissing) {
      currentGroup = { category: cat, items: [] };
      groups.push(currentGroup);
      currentCat = cat;
    }
    if (!currentGroup) {
      currentGroup = { category: cat, items: [] };
      groups.push(currentGroup);
      currentCat = cat;
    }

    if (q.isStreak) {
      const sg = state.streakGroups[i];
      const nums = sg.members.map(m => state.questions[m].num);
      const label = nums.length > 1 ? `${nums[0]}-${nums[nums.length - 1]}` : `${nums[0]}`;
      currentGroup.items.push({ q, i, streakLabel: label, streakGroup: sg });
    } else {
      currentGroup.items.push({ q, i });
    }
  });

  sidebarEl.innerHTML = groups.map(g => {
    const buttons = g.items.map(({ q, i, streakLabel, streakGroup }) => {
      if (q.isMissing && !q.isStreak) {
        return `<button class="q-btn missing" disabled title="Question ${q.num} is skipped in the source packet">${q.num}. (skipped)</button>`;
      }
      const isActive = streakGroup
        ? streakGroup.members.includes(state.currentQuestion)
        : i === state.currentQuestion;
      const activeClass = isActive ? 'active' : '';
      const displayLabel = streakLabel || q.num;
      let answeredTag = '';
      let answeredTeamClass = '';
      const isAnswered = state.answeredQuestions.has(i);
      if (isAnswered) {
        const info = getAnsweredBy(i);
        if (info) {
          const teamClass = info.teamLetter === 'a' ? 'team-a-tag' : 'team-b-tag';
          answeredTeamClass = info.teamLetter === 'a' ? 'answered-a' : 'answered-b';
          answeredTag = `<span class="q-answered-tag ${teamClass}">${escapeHtml(info.initials)}</span>`;
        } else if (streakGroup) {
          // Streak slots can have an entry per team — show one initials tag for each.
          const tags = [];
          for (const t of ['a', 'b']) {
            const h = state.history.find(h => h.question === i && h.isStreak && h.team === t);
            if (!h) continue;
            const tObj = t === 'a' ? state.teamA : state.teamB;
            const pName = tObj.players[h.playerIndex]?.name || '?';
            const teamClass = t === 'a' ? 'team-a-tag' : 'team-b-tag';
            if (!answeredTeamClass) answeredTeamClass = t === 'a' ? 'answered-a' : 'answered-b';
            tags.push(`<span class="q-answered-tag ${teamClass}">${escapeHtml(getInitials(pName))}</span>`);
          }
          answeredTag = tags.join('');
        }
      }
      const answeredClass = isAnswered ? 'answered' : '';
      const flagNums = streakGroup ? streakGroup.members.map(m => state.questions[m].num) : [q.num];
      const issueFlag = flagNums.some(n => issueSlots.has(n))
        ? '<span class="q-issue-flag" title="Suspected parsing issue on this slot — see the parse report on the setup screen">&#9888;</span>'
        : '';
      return `<button class="q-btn ${activeClass} ${answeredClass} ${answeredTeamClass}" data-action="goto" data-index="${i}">${displayLabel}${issueFlag}${answeredTag}</button>`;
    }).join('');

    const label = g.category
      ? `<div class="q-group-label">${escapeHtml(g.category)}</div>`
      : '';

    return `<div class="q-group">${label}${buttons}</div>`;
  }).join('');

  // Scroll active button into view
  const activeBtn = sidebarEl.querySelector('.q-btn.active');
  if (activeBtn) {
    activeBtn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }
}

export function nextQuestion() {
  const q = state.questions[state.currentQuestion];
  if (q && q.isStreak) {
    // Jump past the streak group
    const group = state.streakGroups[q.streakGroupStart];
    if (group && group.end + 1 < state.questions.length) {
      state.currentQuestion = group.end + 1;
      renderGame();
    }
  } else if (state.currentQuestion < state.questions.length - 1) {
    let next = state.currentQuestion + 1;
    // Skip empty placeholders
    while (next < state.questions.length - 1 && !state.questions[next].question && !state.questions[next].isStreak) {
      next++;
    }
    state.currentQuestion = next;
    renderGame();
  }
}

export function prevQuestion() {
  if (state.currentQuestion > 0) {
    let prev = state.currentQuestion - 1;
    // Skip back over empty placeholders
    while (prev > 0 && !state.questions[prev].question && !state.questions[prev].isStreak) {
      prev--;
    }
    const pq = state.questions[prev];
    // If previous is part of a streak, jump to group start
    if (pq && pq.isStreak) {
      prev = pq.streakGroupStart;
    }
    state.currentQuestion = prev;
    renderGame();
  }
}

export function skipQuestion() { nextQuestion(); }

export function goToQuestion(index) {
  const q = state.questions[index];
  if (q && q.isMissing && !q.isStreak) return;
  // If clicking into a streak group, go to group start
  if (q && q.isStreak) {
    index = q.streakGroupStart;
  }
  state.currentQuestion = index;
  renderGame();
}

export function renderPlayerPanel(team) {
  const teamObj = team === 'a' ? state.teamA : state.teamB;
  const panel = document.getElementById(`panel-${team}`);

  let html = `<h3>${escapeHtml(teamObj.name)}</h3>`;
  const currentQ = state.questions[state.currentQuestion];
  const isStreak = currentQ && currentQ.isStreak;
  const isJailbreak = !!(currentQ && currentQ.category && /jailbreak/i.test(currentQ.category));
  const lockSet = isJailbreak ? state.jailbreakLocked[team] : null;
  // Phone-buzzer preselect: highlight the row of a matched remote buzz;
  // while an UNMATCHED buzz is pending, every row becomes a click-to-assign
  // target (handled by the panel's delegated click listener).
  const ps = state.room && state.room.preselect;
  const psAt = ps && !ps.unmatched ? preselectIndex(ps) : null;
  const buzzedIdx = psAt && psAt.team === team ? psAt.playerIndex : -1;
  const assignMode = !!(ps && ps.unmatched);
  html += teamObj.players.map((p, i) => {
    // Team A always uses keys 1-4 (indices 0-3); Team B always uses 5-9, 0
    // (indices 0-5). Roster size on the other team does not shift these.
    let keybind = null;
    if (team === 'a' && i < 4) keybind = i + 1;
    else if (team === 'b' && i < 5) keybind = i + 5;
    else if (team === 'b' && i === 5) keybind = 0;
    const points = isStreak ? 5 : 10;
    const scoreBtn = `<button draggable="false" class="btn ${isStreak ? 'btn-5' : 'btn-10'}" data-action="add-points" data-team="${team}" data-index="${i}" data-points="${points}">+${points}</button>`;
    const locked = lockSet && lockSet.includes(i);
    const lockedClass = locked ? ' player-row-locked' : '';
    const lockedTag = locked ? '<span class="player-lock-tag" title="Already buzzed this jailbreak round">locked</span>' : '';
    const buzzedClass = i === buzzedIdx ? ' player-row-buzzed' : '';
    const assignClass = assignMode ? ' player-row-assignable' : '';
    return `<div class="player-row${lockedClass}${buzzedClass}${assignClass}" draggable="true" data-team="${team}" data-index="${i}">
      <span class="drag-handle" aria-hidden="true" title="Drag to reorder">&#x2630;</span>
      ${keybind !== null ? `<span class="player-keybind">${keybind}</span>` : ''}
      <span class="player-name">${escapeHtml(p.name)}</span>
      ${lockedTag}
      <span class="player-points">${p.points}</span>
      <div class="player-actions">
        ${scoreBtn}
      </div>
    </div>`;
  }).join('');

  panel.innerHTML = html;
}

// Wire the data-action click handlers for elements rendered into the
// sidebar / player panels / streak-status. Bind once to the closest stable
// container — the children are re-rendered on every state change but the
// containers themselves persist.
export function setupGameScreen() {
  // Subscribe renderGame as the single state-change listener.
  subscribe(() => renderGame());

  // Player panels: "+10" / "+5" buttons, plus drag-to-reorder. The reducer
  // (reorderPlayer) calls notify(), which fires renderGame and re-renders
  // both panels — no manual re-render needed here.
  for (const team of ['a', 'b']) {
    const panel = document.getElementById(`panel-${team}`);
    if (!panel) continue;
    panel.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-action="add-points"]');
      if (btn) {
        const { addPoints } = await import('../state.js');
        addPoints(btn.dataset.team, parseInt(btn.dataset.index, 10), parseInt(btn.dataset.points, 10));
        return;
      }
      // Unmatched phone buzz pending: clicking a player row assigns that
      // phone to the roster player (see ui/room.js).
      const row = e.target.closest('.player-row');
      if (row && state.room && state.room.preselect && state.room.preselect.unmatched) {
        const { assignBuzzer } = await import('./room.js');
        assignBuzzer(row.dataset.team, parseInt(row.dataset.index, 10));
      }
    });
    attachDragReorder(panel, { itemSelector: '.player-row' });
  }

  // Sidebar: question buttons.
  const sidebar = document.getElementById('q-sidebar');
  if (sidebar) {
    sidebar.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action="goto"]');
      if (!btn) return;
      goToQuestion(parseInt(btn.dataset.index, 10));
    });
  }

  // Streak-status reset buttons.
  const streakStatus = document.getElementById('streak-status');
  if (streakStatus) {
    streakStatus.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-action="reset-streak"]');
      if (!btn) return;
      const { resetStreak } = await import('../state.js');
      resetStreak(parseInt(btn.dataset.streakKey, 10), btn.dataset.team);
    });
  }

  // Question "Clear" button (lives inside #q-answered-by which is re-rendered each time).
  const answeredBy = document.getElementById('q-answered-by');
  if (answeredBy) {
    answeredBy.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-action="clear-current-question"]');
      if (!btn) return;
      const { clearCurrentQuestion } = await import('../state.js');
      clearCurrentQuestion();
    });
  }
}
