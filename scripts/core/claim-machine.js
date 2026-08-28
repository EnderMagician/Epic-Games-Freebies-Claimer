(function attachClaimMachine(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.FreebiesClaimMachine = api;
})(typeof globalThis === 'object' ? globalThis : self, () => {
  const TERMINAL_PHASES = new Set(['completed', 'failed']);

  function createClaimTask({ gameId, tabId, frameId = 0, now = Date.now() }) {
    return {
      gameId,
      tabId,
      frameId,
      phase: 'waiting_for_get',
      attempts: 0,
      startedAt: now,
      updatedAt: now,
      lastProgressAt: now,
      lastObservation: null,
      terminalReason: null
    };
  }

  function decision(action, reason) {
    return { action, reason };
  }

  function reduceClaimTask(task, observation = {}, now = Date.now()) {
    const current = { ...task, updatedAt: now, lastObservation: { ...observation } };
    if (TERMINAL_PHASES.has(current.phase)) return { task: current, decision: decision('wait', 'Task is terminal.') };

    if (observation.ownershipVisible) {
      current.phase = 'completed';
      current.terminalReason = 'owned';
      current.lastProgressAt = now;
      return { task: current, decision: decision('complete_owned', 'Epic shows the game is owned or in the library.') };
    }

    const actions = new Set(observation.visibleActions || []);
    const hasClaimAction = actions.has('get') || actions.has('add_to_library') || actions.has('place_order');
    const hasConfirmationAction = actions.has('add_to_library') || actions.has('place_order');
    const blockers = (Array.isArray(observation.blockers) ? observation.blockers : [])
      .filter((blocker) => blocker !== 'login' || !hasClaimAction)
      .filter((blocker) => blocker !== 'terms' || !hasConfirmationAction);
    if (blockers.length > 0) {
      current.phase = 'needs_attention';
      current.terminalReason = blockers.join(', ');
      current.lastProgressAt = now;
      return { task: current, decision: decision('needs_attention', `Manual attention required: ${current.terminalReason}`) };
    }

    const canConfirm = observation.freeEvidence === 'confirmed' && (actions.has('add_to_library') || actions.has('place_order'));

    if ((current.phase === 'waiting_for_get' || current.phase === 'needs_attention') && actions.has('get') && observation.freeEvidence === 'confirmed') {
      current.phase = 'awaiting_outcome';
      current.terminalReason = null;
      current.attempts += 1;
      current.lastProgressAt = now;
      return { task: current, decision: decision('click_get', 'Visible Get action is available.') };
    }

    if ((current.phase === 'waiting_for_get' || current.phase === 'awaiting_outcome' || current.phase === 'needs_attention') && canConfirm) {
      current.phase = 'confirmation_clicked';
      current.terminalReason = null;
      current.attempts += 1;
      return { task: current, decision: decision('click_confirm', 'Verified zero-cost confirmation action is available.') };
    }

    return { task: current, decision: decision('wait', 'Waiting for Epic page state to settle.') };
  }

  return { createClaimTask, reduceClaimTask };
});
