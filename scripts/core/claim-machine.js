(function attachClaimMachine(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.FreebiesClaimMachine = api;
})(typeof globalThis === 'object' ? globalThis : self, () => {
  const TERMINAL_PHASES = new Set(['completed', 'failed']);

  function createClaimTask({ gameId, tabId, frameId = 0, now = Date.now(), title = null, url = null, catalogEligible = false }) {
    return {
      gameId,
      title,
      url,
      catalogEligible: Boolean(catalogEligible),
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
    const blockers = (Array.isArray(observation.blockers) ? observation.blockers : [])
      .filter((blocker, index, all) => all.indexOf(blocker) === index);
    if (blockers.length > 0) {
      if (current.phase !== 'needs_attention') current.resumePhase = current.phase;
      current.phase = 'needs_attention';
      current.terminalReason = blockers.join(', ');
      current.lastProgressAt = now;
      return { task: current, decision: decision('needs_attention', `Manual attention required: ${current.terminalReason}`) };
    }
    if (current.phase === 'needs_attention') {
      current.phase = current.resumePhase || 'waiting_for_get';
      current.terminalReason = null;
    }

    const isLegacyObservation = !observation.context && !('checkoutTotalEvidence' in observation) && !('offerEvidence' in observation);
    const offerEvidence = observation.offerEvidence || (isLegacyObservation ? observation.freeEvidence : 'unknown');
    const checkoutEvidence = observation.checkoutTotalEvidence
      || (isLegacyObservation ? observation.freeEvidence : 'unknown');
    const productEligible = offerEvidence !== 'nonzero' && (observation.catalogEligible === true
      || offerEvidence === 'confirmed'
      || (isLegacyObservation && observation.freeEvidence === 'confirmed'));
    const checkoutFree = checkoutEvidence === 'confirmed' && checkoutEvidence !== 'nonzero';
    const canConfirm = checkoutFree && current.offerVerified !== false
      && (actions.has('add_to_library') || actions.has('place_order'));

    if ((current.phase === 'waiting_for_get' || current.phase === 'needs_attention') && actions.has('get') && productEligible) {
      current.phase = 'awaiting_outcome';
      current.terminalReason = null;
      current.offerVerified = true;
      current.attempts += 1;
      current.lastProgressAt = now;
      return { task: current, decision: decision('click_get', 'Visible Get action is available.') };
    }

    if ((current.phase === 'waiting_for_get' || current.phase === 'awaiting_outcome' || current.phase === 'needs_attention') && canConfirm) {
      current.phase = 'confirmation_clicked';
      current.terminalReason = null;
      current.attempts += 1;
      current.lastProgressAt = now;
      return { task: current, decision: decision('click_confirm', 'Verified zero-cost confirmation action is available.') };
    }

    const reason = actions.has('get') && !productEligible
      ? offerEvidence === 'nonzero' ? 'Refusing Get: current CTA offer is not free.' : 'Waiting for Epic page state to settle; waiting for scoped product price evidence.'
      : (actions.has('add_to_library') || actions.has('place_order')) && !checkoutFree
        ? checkoutEvidence === 'nonzero' ? 'Refusing confirmation: checkout total is nonzero.' : 'Waiting for checkout total verification.'
        : current.phase === 'confirmation_clicked' ? 'Waiting for Epic to confirm ownership after the order click.'
          : current.phase === 'awaiting_outcome' ? 'Waiting for checkout or ownership after Get.'
            : 'Waiting for Epic page state to settle.';
    return { task: current, decision: decision('wait', reason) };
  }

  return { createClaimTask, reduceClaimTask };
});
