(function attachEpicObservation(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.FreebiesEpicObservation = api;
})(typeof globalThis === 'object' ? globalThis : self, () => {
  const ACTION_LABELS = {
    get: ['get', 'get now', 'nhan', 'nhan ngay'],
    add_to_library: ['add to library', 'them vao thu vien'],
    place_order: ['place order', 'dat hang', 'confirm order', 'xac nhan dat hang']
  };

  const OWNED_LABELS = ['owned', 'in library', 'already purchased', 'already owned', 'in your library',
    'da so huu', 'trong thu vien', 'da co trong thu vien'];
  const ORDER_SUCCESS_PHRASES = ['thanks for your order', 'thank you for your order', 'order complete',
    'order confirmed', 'added to your library', 'cam on ban da dat hang', 'da them vao thu vien'];

  function isOwnershipText(value) {
    const text = normalize(value).replace(/[!.]+$/, '');
    if (!text) return false;
    return OWNED_LABELS.some((label) => text === label || text.startsWith(label + ' '))
      || ORDER_SUCCESS_PHRASES.some((phrase) => text.includes(phrase));
  }

  function normalize(value) {
    return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd').replace(/\s+/g, ' ').trim();
  }

  function priceValues(text) {
    const value = normalize(text);
    const values = [];
    const currency = '(?:[$€£₫฿]|usd|eur|gbp|vnd|thb)';
    const amount = '([0-9]+(?:[.,\\s][0-9]+)*)';
    const patterns = [
      new RegExp(`${currency}\\s*${amount}(?![0-9.,])`, 'g'),
      new RegExp(`(?<![0-9.,])${amount}\\s*${currency}`, 'g')
    ];
    // Only zero versus nonzero matters; consume the entire grouped amount.
    for (const pattern of patterns)
      for (const match of value.matchAll(pattern)) values.push(/[1-9]/.test(match[1]) ? 1 : 0);
    return values.filter(Number.isFinite);
  }

  function hasZeroPrice(text) {
    return priceValues(text).some((value) => value === 0);
  }

  function hasNonZeroPrice(text) {
    return priceValues(text).some((value) => value > 0);
  }

  function priceEvidence(text, { allowFreeLabel = false, zeroWins = true } = {}) {
    const value = normalize(text);
    const hasZero = hasZeroPrice(value);
    const hasNonZero = hasNonZeroPrice(value);
    // Product CTA regions may include a crossed-out original price and a current $0.
    if (hasNonZero && !zeroWins) return 'nonzero';
    if (hasZero) return 'confirmed';
    if (allowFreeLabel && /(?:^|\s)free(?:\s|$)/.test(value)) return 'confirmed';
    if (hasNonZero) return 'nonzero';
    return 'unknown';
  }

  // Epic's web session (EPIC_SSO) lasts about 8 hours; after that a purchase
  // sends the tab to www.epicgames.com/id/login/switch-account ("Welcome back"),
  // which lists the remembered account(s). Only a lone remembered account is
  // safe to pick automatically; a password or MFA prompt always needs the user.
  const ACCOUNT_PICKER_EXCLUDED = [
    'another account', 'different account', 'other account', 'add account', 'switch account',
    'sign up', 'create', 'forgot', 'privacy', 'terms', 'help', 'support', 'back', 'close', 'cancel',
    'cookie', 'accept', 'reject', 'decline', 'settings', 'log out', 'sign out', 'logout', 'remove',
    'language', 'english', 'show password', 'hide password', 'learn more', 'more options',
    'sign in with', 'continue with', 'facebook', 'google', 'apple', 'xbox', 'playstation', 'nintendo',
    'steam', 'lego', 'tai khoan khac', 'dang ky'
  ];

  function isAccountPickerUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.hostname === 'www.epicgames.com' && /^\/id\/login(?:\/|$)/i.test(parsed.pathname);
    } catch (error) {
      return false;
    }
  }

  function classifyAccountPicker({ url = '', bodyText = '', hasPasswordField = false, candidates = [] } = {}) {
    if (!isAccountPickerUrl(url)) return { state: 'none', index: -1 };
    const page = normalize(bodyText);
    const picker = /\/switch-account(?:$|[/?#])/i.test(url) || page.includes('welcome back') || page.includes('chao mung tro lai');
    if (!picker) return { state: hasPasswordField ? 'password' : 'none', index: -1 };
    if (hasPasswordField) return { state: 'password', index: -1 };
    const eligible = candidates
      .map((label, index) => ({ label: normalize(label), index }))
      .filter(({ label }) => label && label.length <= 160
        && !ACCOUNT_PICKER_EXCLUDED.some((word) => label === word || label.startsWith(word + ' ') || label.includes(word)));
    if (eligible.length === 1) return { state: 'single', index: eligible[0].index };
    return { state: eligible.length === 0 ? 'no_account' : 'ambiguous', index: -1, count: eligible.length };
  }

  function actionMatches(label, wanted) {
    return label === wanted;
  }

  function buildEpicObservation({
    bodyText = '',
    buttons = [],
    ctaRegions = [],
    checkoutRegions = [],
    ownershipText = '',
    context = 'unknown',
    catalogEligible = false,
    identityMatch = null,
    checkoutOverlay = false,
    accountPicker = null
  } = {}) {
    const page = normalize(bodyText);
    const visibleButtons = buttons
      .filter((button) => button && button.visible !== false && button.disabled !== true)
      .map((button) => ({
        label: normalize(button.label),
        regionText: normalize(button.regionText || '')
      }));
    const visibleActions = [];
    for (const [action, labels] of Object.entries(ACTION_LABELS)) {
      if (visibleButtons.some(({ label }) => labels.some((wanted) => actionMatches(label, wanted)))) {
        visibleActions.push(action);
      }
    }

    const productRegions = ctaRegions.length > 0
      ? ctaRegions.map(normalize)
      : visibleButtons.filter(({ label }) => ACTION_LABELS.get.some((wanted) => actionMatches(label, wanted)))
        .map(({ regionText }) => regionText).filter(Boolean);
    const checkoutTexts = checkoutRegions.map(normalize).filter(Boolean);
    const productEvidence = productRegions.reduce((result, text) => {
      const evidence = priceEvidence(text, { allowFreeLabel: catalogEligible });
      if (evidence === 'confirmed') return 'confirmed';
      if (evidence === 'nonzero' && result === 'unknown') return 'nonzero';
      return result;
    }, 'unknown');

    let checkoutTotalEvidence = 'unknown';
    if (context === 'checkout') {
      checkoutTotalEvidence = checkoutTexts.reduce((result, text) => {
        let evidence = priceEvidence(text, { zeroWins: false });
        if (evidence === 'unknown' && /this is free\.? add it to your library to get started/.test(text)) evidence = 'confirmed';
        if (evidence === 'nonzero') return 'nonzero';
        if (evidence === 'confirmed' && result === 'unknown') return 'confirmed';
        return result;
      }, 'unknown');
    }

    const ownershipVisible = isOwnershipText(ownershipText);
    const blockers = [];
    if (page.includes('captcha')) blockers.push('captcha');
    const hasTermsContext = page.includes('terms of service')
      || page.includes('end user license')
      || page.includes('dieu khoan dich vu');
    const hasTermsControl = visibleButtons.some(({ label }) => [
      'accept', 'accept terms', 'agree', 'i agree', 'chap nhan', 'dong y'
    ].some((wanted) => label === wanted || label.startsWith(wanted + ' ')));
    const hasRequiredTermsText = page.includes('must accept')
      || page.includes('please accept the terms')
      || page.includes('accept the terms to continue')
      || page.includes('required to accept')
      || page.includes('chap nhan dieu khoan de tiep tuc');
    if (hasTermsContext && (hasTermsControl || hasRequiredTermsText)) blockers.push('terms');
    const hasLoginButton = visibleButtons.some(({ label }) => [
      'log in', 'login', 'sign in', 'dang nhap'
    ].some((wanted) => label === wanted || label.startsWith(wanted + ' ')));
    const hasLoginWallText = [
      'please log in', 'log in to continue', 'login to continue',
      'sign in to continue', 'you need to log in', 'dang nhap de tiep tuc'
    ].some((phrase) => page.includes(phrase));
    if (hasLoginWallText || (hasLoginButton && visibleActions.length === 0)) blockers.push('login');
    if (page.includes('device not supported') || page.includes('not compatible with your current device')) blockers.push('compatibility');
    if (page.includes('parental control pin') || page.includes('enter your pin')) blockers.push('parental_pin');
    if (page.includes('unavailable in your region')) blockers.push('region');
    if (page.includes('verify your age') || page.includes('enter your date of birth')) blockers.push('age_verification');

    const freeEvidence = context === 'checkout'
      ? checkoutTotalEvidence
      : productEvidence;
    return {
      context,
      identityMatch,
      checkoutOverlay: Boolean(checkoutOverlay),
      accountPicker: accountPicker || null,
      catalogEligible: Boolean(catalogEligible),
      ownershipVisible,
      visibleActions,
      offerEvidence: productEvidence,
      checkoutTotalEvidence,
      freeEvidence,
      blockers
    };
  }

  return { buildEpicObservation, normalize, priceEvidence, isOwnershipText, OWNED_LABELS, classifyAccountPicker, isAccountPickerUrl };
});
