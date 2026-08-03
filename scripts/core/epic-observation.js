(function attachEpicObservation(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.FreebiesEpicObservation = api;
})(typeof globalThis === 'object' ? globalThis : self, () => {
  const ACTION_LABELS = {
    get: ['get', 'get now', 'nhận', 'nhận ngay'],
    add_to_library: ['add to library', 'thêm vào thư viện'],
    place_order: ['place order', 'đặt hàng', 'confirm order', 'xác nhận đặt hàng']
  };

  function normalize(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function buildEpicObservation({ bodyText = '', buttons = [] } = {}) {
    const page = normalize(bodyText);
    const visibleButtons = buttons
      .filter((button) => button && button.visible !== false && button.disabled !== true)
      .map((button) => normalize(button.label));
    const visibleActions = [];
    for (const [action, labels] of Object.entries(ACTION_LABELS)) {
      if (visibleButtons.some((label) => labels.some((wanted) => label === wanted || label.includes(wanted)))) {
        visibleActions.push(action);
      }
    }
    const ownershipVisible = [
      'owned', 'in library', 'already purchased', 'đã sở hữu', 'trong thư viện'
    ].some((word) => page.includes(word));
    const blockers = [];
    if (page.includes('captcha')) blockers.push('captcha');
    const hasTermsContext = page.includes('terms of service')
      || page.includes('end user license')
      || page.includes('điều khoản dịch vụ');
    const hasTermsControl = visibleButtons.some((label) => [
      'accept', 'accept terms', 'agree', 'i agree', 'chấp nhận', 'đồng ý'
    ].some((wanted) => label === wanted || label.startsWith(`${wanted} `)));
    const hasRequiredTermsText = page.includes('must accept')
      || page.includes('please accept the terms')
      || page.includes('accept the terms to continue')
      || page.includes('required to accept')
      || page.includes('chấp nhận điều khoản để tiếp tục');
    if (hasTermsContext && (hasTermsControl || hasRequiredTermsText)) {
      blockers.push('terms');
    }
    const hasClaimAction = visibleActions.length > 0;
    const hasLoginButton = visibleButtons.some((label) => [
      'log in', 'login', 'sign in', 'đăng nhập'
    ].some((wanted) => label === wanted || label.startsWith(`${wanted} `)));
    const hasLoginWallText = [
      'please log in',
      'log in to continue',
      'login to continue',
      'sign in to continue',
      'you need to log in',
      'đăng nhập để tiếp tục'
    ].some((phrase) => page.includes(phrase));
    if (!hasClaimAction && (hasLoginButton || hasLoginWallText)) blockers.push('login');
    const hasExplicitFreeCheckout = page.includes('this is free. add it to your library to get started')
      || page.includes('this is free add it to your library to get started');
    const hasZero = /(?:\$\s*0(?:\.00)?|0,00\s*\$|0\s*₫|₫\s*0)/i.test(page);
    const hasNonZero = /(?:\$\s*[1-9]\d*(?:\.\d+)?|€\s*[1-9]|£\s*[1-9]|\d+[,.]\d+\s*₫)/i.test(page);
    return {
      ownershipVisible,
      visibleActions,
      freeEvidence: hasExplicitFreeCheckout ? 'confirmed' : (hasNonZero ? 'nonzero' : (hasZero ? 'confirmed' : 'unknown')),
      blockers
    };
  }

  return { buildEpicObservation, normalize };
});
