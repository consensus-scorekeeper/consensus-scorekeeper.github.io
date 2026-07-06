// Coach-marks tutorial overlay. Driven by a flat list of STEPS — each step
// optionally highlights an element with `target`, optionally auto-jumps the
// game to a question of a particular type before highlighting (so the
// streak / jailbreak / splits steps actually show those rounds), and shows
// a tooltip with title + body + step counter + Back / Next / Skip.
//
// Highlighting trick: a single CSS class sets a giant outer box-shadow that
// dims everything outside the element, plus a thin colored shadow inset
// that outlines it. No separate dim layer or SVG mask needed; the
// highlighted element naturally accepts clicks since the shadow is purely
// visual.
//
// `target` can be a single CSS selector string OR an array of selectors;
// the array form highlights every match. The first one is "primary" (gets
// the dim shadow) and subsequent ones get only the colored outline so the
// page-level dim doesn't compound. The tooltip positions relative to the
// primary.

import { state } from '../state.js';
import { goToQuestion } from './game.js';

// Reloading on exit drops the user back into their pre-tutorial saved
// state (since saveState was suppressed throughout the tutorial). Lifted
// to a module function so tests / future callers can override it.
let exitAction = () => location.reload();

const STEPS = [
  {
    title: 'Welcome to the tutorial',
    target: null,
    body: `We've set up a sandbox game with preset teams (Quizmasters vs Trivia Titans) and a real packet so you can try the controls. Press <kbd>Esc</kbd> or click <em>Skip Tutorial</em> to exit anytime, or use <em>Next →</em> to step through.`,
  },
  {
    title: 'Scoreboard',
    target: '.scoreboard',
    body: `Live team scores at the top of every screen. <strong>Pop Out</strong> opens a presentation-style scoreboard in a separate window — useful for projectors or a second monitor — and updates live as you award points.`,
  },
  {
    title: 'Announce each new category',
    target: '.question-content',
    body: `At the start of every <em>new</em> category, read the category name aloud (e.g. "Set of 4: Famous Authors"). If category instructions appear below the title, read those too — they tell players the answer format. After that, just read each question as you reach it; no need to repeat the category for every one. Don't read the bold/underlined answer until a team has buzzed.`,
  },
  {
    title: 'Question sidebar',
    target: '#q-sidebar',
    body: `Every question, grouped by category. The current question is highlighted; answered questions show a colored tag with the scorer's initials. Click any number to jump there directly.`,
  },
  {
    title: 'Awarding points',
    target: '#panel-a',
    body: `Click <strong>+10</strong> on a player to award the question — the cursor auto-advances. Number keys are shortcuts too, but the key-to-player assignment <em>changes dynamically based on roster size</em>: look at the small number badge next to each player's name to see their key. If you click another team's player on a question that's already been answered, the prior award is reversed and the points go to the new player instead.`,
  },
  {
    title: 'Streak rounds',
    target: '.question-content',
    body: `<strong>+5</strong> only — streaks award fewer points each but allow many in a row. <em>Both teams</em> can score independently on the same group, so each team racks up its own running total. The "Reset to 0" button per team wipes that team's streak total if they say an incorrect answer.`,
    autoJumpTo: (q) => q && q.isStreak,
  },
  {
    title: 'Jailbreak rounds',
    target: '.bottom-panels',
    body: `Each player can only buzz <em>once</em> per jailbreak round — once they've answered, they're visually muted ("locked") and can't buzz again for the rest of the jailbreak. When every player on a team has buzzed correctly, the players on that team get their locks reset.`,
    autoJumpTo: (q) => q && q.category && /jailbreak/i.test(q.category),
  },
  {
    title: 'Splits rounds',
    target: '.question-content',
    body: `Two paired sub-categories played back-to-back. <strong>Teams are required to split:</strong> they designate players for each category — it doesn't have to be an even split. <em>Announce both category names up front</em> so teams can decide who covers what. Both names appear in the sidebar and the inline pack viewer; the pop-out scoreboard also shows both with the current one highlighted.`,
    autoJumpTo: (q) => q && q.category && q.category.startsWith('Splits 1:'),
  },
  {
    title: 'Corrections',
    target: '#undo-btn',
    body: `<strong>Undo Last</strong> (<kbd>Ctrl</kbd>+<kbd>Z</kbd>) reverses the most recent scoring action. <strong>Clear</strong> (<kbd>C</kbd> key) removes the current question's answer without advancing the cursor. Use these whenever you misclick or assign to the wrong player.`,
  },
  {
    title: 'When parsing goes wrong',
    target: ['#custom-award', '#inline-pdf', '#toggle-inline-pdf-btn'],
    body: `<strong>+/− Points</strong> in the scoreboard area is your emergency override — assign or subtract arbitrary points on any question if the parser misread something. To check the source, the <strong>inline pack viewer</strong> on the right auto-follows the current question (click <em>Expand</em> for fullscreen with arrow keys). Click <strong>Hide Pack</strong> if you don't need it and want the screen space; click again to bring it back.`,
  },
  {
    title: 'Auto-save',
    target: null,
    body: `Your game saves to localStorage on every action. If you close the tab or refresh, everything restores: rosters, scores, history, the loaded packet. <em>Clear saved game</em> on the setup screen wipes it for a fresh start.`,
  },
  {
    title: 'Wrapping up',
    target: '.game-controls',
    body: `When the game ends, click <strong>Export CSV</strong> for a final-results file (metadata, team scores, per-player rows). <strong>Back to Setup</strong> returns you to the rosters/pack screen — your game is preserved, so you can come back to it.`,
  },
  {
    title: `You're ready`,
    target: null,
    body: `That's the full moderator workflow. This sandbox game stays loaded — try the controls without worry, and use the sidebar to jump between question types. Click <em>Done</em> to dismiss.`,
  },
];

let stepIdx = 0;
let active = false;
let prevTargets = []; // array of currently-highlighted Elements
let tooltipEl = null;
let escListener = null;
let resizeListener = null;

export function startTutorial() {
  if (active) return;
  active = true;
  stepIdx = 0;
  buildTooltip();
  escListener = (e) => { if (e.key === 'Escape') exitTutorial(); };
  resizeListener = () => { if (active) positionTooltip(prevTargets[0] || null); };
  document.addEventListener('keydown', escListener);
  window.addEventListener('resize', resizeListener);
  showStep(0);
}

function buildTooltip() {
  if (tooltipEl) return;
  tooltipEl = document.createElement('div');
  tooltipEl.className = 'tutorial-tooltip';
  document.body.appendChild(tooltipEl);
}

function showStep(i) {
  const step = STEPS[i];
  if (!step) { exitTutorial(); return; }
  stepIdx = i;

  // Auto-jump first so renderGame replaces the question/sidebar/panel DOM
  // before we look up the target selector.
  if (step.autoJumpTo) {
    const targetIdx = state.questions.findIndex(step.autoJumpTo);
    if (targetIdx >= 0 && targetIdx !== state.currentQuestion) {
      goToQuestion(targetIdx);
    }
  }

  // Move highlights from the old elements to the new ones.
  for (const el of prevTargets) {
    el.classList.remove('tutorial-highlight');
    el.classList.remove('tutorial-highlight-secondary');
  }
  prevTargets = [];

  const selectors = step.target == null ? []
    : Array.isArray(step.target) ? step.target
    : [step.target];
  for (let n = 0; n < selectors.length; n++) {
    const el = document.querySelector(selectors[n]);
    if (!el) continue;
    el.classList.add(n === 0 ? 'tutorial-highlight' : 'tutorial-highlight-secondary');
    prevTargets.push(el);
  }

  renderTooltip(step, i);
  positionTooltip(prevTargets[0] || null);
}

function renderTooltip(step, i) {
  const isLast = i === STEPS.length - 1;
  const isFirst = i === 0;
  tooltipEl.innerHTML = `
    <div class="tutorial-tooltip-header">
      <span class="tutorial-step-counter">${i + 1} of ${STEPS.length}</span>
      <button type="button" class="tutorial-skip-btn" data-tutorial-action="skip">Skip Tutorial</button>
    </div>
    <h3 class="tutorial-tooltip-title">${step.title}</h3>
    <div class="tutorial-tooltip-body">${step.body}</div>
    <div class="tutorial-tooltip-nav">
      <button type="button" class="btn" data-tutorial-action="back" ${isFirst ? 'disabled' : ''}>&larr; Back</button>
      <button type="button" class="btn tutorial-next-btn" data-tutorial-action="next">${isLast ? 'Done' : 'Next &rarr;'}</button>
    </div>
  `;
}

function positionTooltip(target) {
  if (!tooltipEl) return;
  // Reset any previous transform/positioning before measuring.
  tooltipEl.style.transform = '';
  tooltipEl.style.position = 'fixed';

  if (!target) {
    // Centered modal style for steps without a target.
    tooltipEl.style.top = '50%';
    tooltipEl.style.left = '50%';
    tooltipEl.style.transform = 'translate(-50%, -50%)';
    return;
  }

  const rect = target.getBoundingClientRect();
  const tipRect = tooltipEl.getBoundingClientRect();
  const margin = 14;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Prefer placing the tooltip below the target.
  let top = rect.bottom + margin;
  let left = rect.left + rect.width / 2 - tipRect.width / 2;

  // If it would overflow the bottom, try above.
  if (top + tipRect.height > vh - 20) {
    const above = rect.top - margin - tipRect.height;
    if (above >= 20) {
      top = above;
    } else {
      // Try beside — pick the side with more room.
      const rightSpace = vw - rect.right;
      if (rightSpace > rect.left && rect.right + margin + tipRect.width < vw - 20) {
        top = Math.max(20, rect.top);
        left = rect.right + margin;
      } else {
        top = Math.max(20, rect.top);
        left = Math.max(20, rect.left - margin - tipRect.width);
      }
    }
  }

  // Clamp to viewport.
  left = Math.max(20, Math.min(left, vw - tipRect.width - 20));
  top = Math.max(20, Math.min(top, vh - tipRect.height - 20));

  tooltipEl.style.top = top + 'px';
  tooltipEl.style.left = left + 'px';
}

function exitTutorial() {
  if (!active) return;
  active = false;
  for (const el of prevTargets) {
    el.classList.remove('tutorial-highlight');
    el.classList.remove('tutorial-highlight-secondary');
  }
  prevTargets = [];
  if (tooltipEl) {
    tooltipEl.remove();
    tooltipEl = null;
  }
  if (escListener) {
    document.removeEventListener('keydown', escListener);
    escListener = null;
  }
  if (resizeListener) {
    window.removeEventListener('resize', resizeListener);
    resizeListener = null;
  }
  // If this was a tutorial sandbox session, reload so any pre-tutorial
  // saved state is restored and the in-memory preset rosters are dropped.
  if (state.tutorialMode) exitAction();
}

// Single delegated click listener for the tooltip's nav buttons. Stops
// propagation so the main.js ACTION_HANDLERS dispatcher (also document-level)
// doesn't see these clicks. Note we use data-tutorial-action so the dispatcher
// wouldn't have matched anyway, but stopping is still cheap insurance.
document.addEventListener('click', (e) => {
  if (!active) return;
  const btn = e.target.closest('[data-tutorial-action]');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const action = btn.dataset.tutorialAction;
  if (action === 'next') {
    if (stepIdx === STEPS.length - 1) exitTutorial();
    else showStep(stepIdx + 1);
  } else if (action === 'back') {
    if (stepIdx > 0) showStep(stepIdx - 1);
  } else if (action === 'skip') {
    exitTutorial();
  }
});
