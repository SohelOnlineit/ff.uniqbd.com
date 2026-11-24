(function () {
  const PAGE_SETTLE_MS = 1500;          // Wait 1.5s after document.readyState === 'complete'
  const ACTION_COOLDOWN_MS = 6500;      // Wait 6.5s after a navigation click before retrying on slow network
  const FORM_SUBMIT_DELAY_MS = 1200;    // Pause 1.2s after filling inputs before clicking Login/Confirm
  const CONFIRM_WAIT_TIMEOUT_MS = 60000; // Wait up to 60s after Confirm for UniPin payment + redirect
  const STEP_INTERVAL_MS = 3000;        // Steady 3s step loop (slower & safer for slow networks)

  let stepBusy = false;
  let lastAccordionClickAt = 0;
  let accordionAttemptIdx = 0;
  let denomMissingCount = 0;
  let confirmClickedAt = 0;
  let retriedSerialNoDash = false;
  let lastActionKey = '';
  let lastActionAt = 0;
  let pageLoadedAt = document.readyState === 'complete' ? Date.now() : 0;
  const reportedUtrs = new Set();

  window.addEventListener('load', () => {
    if (!pageLoadedAt) pageLoadedAt = Date.now();
  });

  function isPageReady() {
    if (document.readyState !== 'complete') return false;
    if (!pageLoadedAt) pageLoadedAt = Date.now();
    return Date.now() - pageLoadedAt >= PAGE_SETTLE_MS;
  }

  function isPageLoadingOverlayVisible() {
    const loaderSelectors = [
      '.blockUI.blockOverlay',
      '.loading-overlay',
      '.page-loader',
      '.preloader',
      '#preloader',
      '#loading',
      '.modal-loading',
      '.spinner-overlay',
      '[aria-busy="true"]',
    ];
    for (const sel of loaderSelectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        if (el.id === 'arora-ext-helper-bar' || el.closest('#arora-ext-helper-bar')) continue;
        if (isVisible(el)) return true;
      }
    }
    return false;
  }

  function isInActionCooldown(actionKey, cooldownMs = ACTION_COOLDOWN_MS) {
    return lastActionKey === actionKey && Date.now() - lastActionAt < cooldownMs;
  }

  function markAction(actionKey) {
    lastActionKey = actionKey;
    lastActionAt = Date.now();
  }

  function reportOnce(task, payload) {
    if (!task || !task.order_utr) return;
    if (reportedUtrs.has(task.order_utr)) return;
    reportedUtrs.add(task.order_utr);
    chrome.runtime.sendMessage({
      type: 'REPORT_ORDER_RESULT',
      payload,
    });
  }

  function isUniPinSuccessPage(pageText, url) {
    const u = (url || '').toLowerCase();
    if (
      /Transaction Successful|Payment Successful|Thank you for your purchase|Your payment is complete|Top[\s-]?up Successful|Redemption Successful|Transaction Complete|Order Complete|Purchase Successful|Payment Completed/i.test(
        pageText
      )
    ) {
      return true;
    }
    if (
      (u.includes('/unibox/complete') || u.includes('/unibox/success') || u.includes('/payment/success')) &&
      !/Failed|Error|Unsuccessful|Rejected/i.test(pageText)
    ) {
      return true;
    }
    return false;
  }

  function findVisiblePageError() {
    // Strictly check genuine jQuery Validate / Bootstrap / UniPin error labels, alerts, jGrowl & jconfirm popups
    const errSelectors = [
      'label.is-invalid',
      'span.is-invalid',
      'div.is-invalid',
      '.invalid-feedback',
      '.alert-danger',
      '.jGrowl-message',
      '.jconfirm-content',
      '.error-message',
      'label.error',
      'span.error',
      'div.error-msg',
    ];
    for (const sel of errSelectors) {
      const els = Array.from(document.querySelectorAll(sel));
      for (const el of els) {
        if (el.id === 'arora-ext-helper-bar' || el.closest('#arora-ext-helper-bar')) continue;
        if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') continue;
        if (!isVisible(el)) continue;
        const txt = (el.innerText || el.textContent || '').trim();
        if (txt.length >= 4 && txt.length <= 220 && !/success|completed|thank you/i.test(txt)) {
          return txt;
        }
      }
    }
    return '';
  }

  function setNativeValue(el, value) {
    if (!el) return;
    el.focus();
    const proto = Object.getPrototypeOf(el);
    const setter =
      Object.getOwnPropertyDescriptor(proto, 'value')?.set ||
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) {
      setter.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: String(value).slice(-1) }));
  }

  // Single, clean native click — NEVER double-clicks an accordion toggle!
  function triggerRealClick(el) {
    if (!el) return;
    const target =
      el.closest('a, button, [role="button"], [data-toggle], [data-bs-toggle], [onclick]') || el;
    target.scrollIntoView({ block: 'center', behavior: 'instant' });
    if (typeof target.click === 'function') {
      target.click();
    } else {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }
  }

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 12 && r.height > 12;
  }

  // Always returns the DEEPEST (most specific) visible element matching regex
  function findDeepestByText(regex, root = document) {
    const all = Array.from(root.querySelectorAll('*')).filter((el) => {
      if (el.id === 'arora-ext-helper-bar' || el.closest('#arora-ext-helper-bar')) return false;
      if (!isVisible(el)) return false;
      const txt = (el.innerText || el.textContent || '').trim();
      return regex.test(txt);
    });
    if (all.length === 0) return null;
    // Prefer elements that have no child also in the match list, then smallest area
    const leaves = all.filter((el) => !all.some((other) => other !== el && el.contains(other)));
    const pool = leaves.length > 0 ? leaves : all;
    pool.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return ra.width * ra.height - rb.width * rb.height;
    });
    return pool[0];
  }

  // Find the section box for "Physical Vouchers" or "Wallet" without bleeding into the other section or the Back button
  function findAccordionBox(sectionTitleRegex, otherTitleRegex) {
    const labelEl = findDeepestByText(sectionTitleRegex);
    if (!labelEl) return null;
    let curr = labelEl.parentElement;
    let bestBox = labelEl.parentElement;
    while (curr && curr !== document.body) {
      const txt = (curr.innerText || '').trim();
      if (
        (otherTitleRegex && otherTitleRegex.test(txt)) ||
        /Select Payment Channel/i.test(txt) ||
        curr.querySelector('a[href*="select_denom"]')
      ) {
        break;
      }
      bestBox = curr;
      curr = curr.parentElement;
    }
    return { labelEl, box: bestBox };
  }

  function isVisibleCaptchaOnPage() {
    const frames = Array.from(document.querySelectorAll('iframe'));
    for (const f of frames) {
      const src = (f.src || '').toLowerCase();
      const r = f.getBoundingClientRect();
      if (
        r.width > 120 &&
        r.height > 60 &&
        (src.includes('captcha-delivery.com') ||
          src.includes('recaptcha') ||
          src.includes('hcaptcha') ||
          src.includes('turnstile'))
      ) {
        return true;
      }
    }
    return false;
  }

  function renderFloatingBar(task, statusText, isPaused) {
    let bar = document.getElementById('arora-ext-helper-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'arora-ext-helper-bar';
      bar.style.cssText =
        'position:fixed;top:12px;right:12px;z-index:2147483647;background:#111720;color:#f1f5f9;border:1px solid #15b48b;border-radius:12px;padding:12px 14px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:12px;box-shadow:0 12px 32px rgba(0,0,0,0.55);width:310px;';
      document.body.appendChild(bar);
    }

    const modeBadge =
      task.mode === 'unipin_voucher'
        ? `Token (${task.voucher?.prefix || 'Voucher'} -> ${task.voucher?.channel_name || ''})`
        : `Account (${task.account?.label || 'Up Points'})`;

    bar.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
        <strong style="color:#15b48b;font-size:13px;">AroraShop Helper v1.4.3</strong>
        <span style="background:rgba(21,180,139,0.16);color:#34d399;padding:2px 7px;border-radius:99px;font-size:11px;font-weight:600;">${task.order_utr}</span>
      </div>
      <div style="color:#cbd5e1;margin-bottom:4px;">UID: <b>${task.player_uid}</b> &bull; <b>${task.denom_label}</b></div>
      <div style="color:#94a3b8;font-size:11px;margin-bottom:8px;">Mode: ${modeBadge}</div>
      <div style="padding:7px 9px;border-radius:8px;background:${isPaused ? 'rgba(245,158,11,0.16)' : '#090d12'};color:${isPaused ? '#fbbf24' : '#a7f3d0'};font-weight:600;margin-bottom:10px;">
        ${statusText}
      </div>
      <div style="display:flex;gap:6px;">
        <button id="aroraExtResumeBtn" style="flex:1;background:#15b48b;color:#fff;border:none;border-radius:7px;padding:7px 8px;font-size:11px;font-weight:600;cursor:pointer;">Resume Step</button>
        <button id="aroraExtDoneBtn" style="background:#1e293b;color:#34d399;border:1px solid rgba(52,211,153,0.35);border-radius:7px;padding:7px 8px;font-size:11px;font-weight:600;cursor:pointer;">Complete</button>
        <button id="aroraExtErrBtn" style="background:rgba(239,68,68,0.15);color:#fca5a5;border:1px solid rgba(239,68,68,0.35);border-radius:7px;padding:7px 8px;font-size:11px;font-weight:600;cursor:pointer;">Error</button>
      </div>
    `;

    document.getElementById('aroraExtResumeBtn').onclick = () => {
      chrome.storage.local.get(['activeTask'], (res) => {
        if (!res.activeTask) return;
        const updated = { ...res.activeTask, pausedForCaptcha: false };
        chrome.storage.local.set({ activeTask: updated }, () => runAutomationStep());
      });
    };

    document.getElementById('aroraExtDoneBtn').onclick = () => {
      chrome.runtime.sendMessage(
        {
          type: 'REPORT_ORDER_RESULT',
          payload: {
            orderUtr: task.order_utr,
            status: 'COMPLETED',
            receiptNote: `Completed via Extension (${modeBadge})`,
          },
        },
        () => bar.remove()
      );
    };

    document.getElementById('aroraExtErrBtn').onclick = () => {
      const reason = prompt('Error reason (voucher will be returned to stock if unused):', 'Failed on Garena/UniPin');
      if (reason === null) return;
      chrome.runtime.sendMessage(
        {
          type: 'REPORT_ORDER_RESULT',
          payload: {
            orderUtr: task.order_utr,
            status: 'CANCELLED',
            errorMessage: reason,
            releaseVoucher: true,
          },
        },
        () => bar.remove()
      );
    };
  }

  // Find UniPin v5 category card using #VOUCHER_charges or #WALLET_charges (exact DOM anchor)
  function findUniPinCategoryCard(type) {
    const chargesId = type === 'voucher' ? 'VOUCHER_charges' : 'WALLET_charges';
    const otherChargesId = type === 'voucher' ? 'WALLET_charges' : 'VOUCHER_charges';
    const chargesEl = document.getElementById(chargesId);

    if (chargesEl) {
      const cardBb = chargesEl.closest('.payment-card-bb') || chargesEl.parentElement;
      let curr = cardBb ? cardBb.parentElement : chargesEl.parentElement;
      let bestBox = cardBb || chargesEl.parentElement;
      while (curr && curr !== document.body) {
        if (
          curr.querySelector('#' + otherChargesId) ||
          curr.querySelector('a[href*="select_denom"]') ||
          /Select Payment Channel/i.test((curr.innerText || '').trim())
        ) {
          break;
        }
        bestBox = curr;
        curr = curr.parentElement;
      }
      return { cardBb, labelEl: cardBb, box: bestBox };
    }

    // Fallback to text search if IDs ever change
    const secRegex = type === 'voucher' ? /^\s*Physical Vouchers\s*$/i : /^\s*Wallet\s*$/i;
    const otherRegex = type === 'voucher' ? /Wallet/i : /Physical Vouchers/i;
    const fb = findAccordionBox(secRegex, otherRegex);
    return fb ? { cardBb: fb.labelEl, labelEl: fb.labelEl, box: fb.box } : null;
  }

  // NOTE: UniPin hardcodes aria-expanded="true" even when collapsed! Only trust .collapse.show
  function isAccordionExpanded(box) {
    if (!box) return false;
    return Boolean(box.querySelector('.panel-collapse.show, .collapse.show, .collapsing'));
  }

  function clickSingleElement(el) {
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 };
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
    } catch (_) {}
    if (typeof el.click === 'function') {
      el.click();
    } else {
      el.dispatchEvent(new MouseEvent('click', opts));
    }
  }

  function expandUniPinAccordion(box, cardBb) {
    if (!box) return;
    if (isAccordionExpanded(box)) return;
    if (Date.now() - lastAccordionClickAt < 1800) return;

    const candidates = [];
    const addCandidate = (el) => {
      if (el && isVisible(el) && !candidates.includes(el)) {
        candidates.push(el);
      }
    };

    // 1. Direct ancestor toggle of .payment-card-bb (e.g. <button>, <a data-toggle>, <div onclick>)
    if (cardBb) {
      addCandidate(cardBb.closest('button, a, [data-toggle], [data-bs-toggle], [aria-expanded], [onclick]'));
      addCandidate(cardBb.parentElement);
      addCandidate(cardBb);
      // Sibling right below .payment-card-bb (the strip with UniPin/UP Gift Card logos & v chevron)
      if (cardBb.nextElementSibling) {
        addCandidate(cardBb.nextElementSibling);
      }
    }

    // 2. Visible Bootstrap / ARIA collapse triggers inside box
    Array.from(
      box.querySelectorAll('[data-toggle="collapse"], [data-bs-toggle="collapse"], [aria-expanded="false"], [data-target], [data-bs-target]')
    ).forEach(addCandidate);

    // 3. Rightmost visible chevron icon inside box
    const visibleIcons = Array.from(box.querySelectorAll('i, svg, img[src*="arrow" i], img[src*="chevron" i]')).filter(isVisible);
    if (visibleIcons.length > 0) {
      visibleIcons.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
      const chevron = visibleIcons[0];
      addCandidate(chevron.closest('button, a, [role="button"], div') || chevron);
      addCandidate(chevron);
    }

    // 4. Outer box itself
    addCandidate(box);

    if (candidates.length === 0) return;
    const chosen = candidates[accordionAttemptIdx % candidates.length];
    accordionAttemptIdx += 1;
    lastAccordionClickAt = Date.now();
    console.log('[AroraExt] Expanding UniPin accordion attempt #' + accordionAttemptIdx, chosen);
    clickSingleElement(chosen);
  }

  function findExpandedChannelItems(rootBox, headerRegex) {
    if (!rootBox || rootBox === document || rootBox === document.body) return [];
    const collapseBody = rootBox.querySelector('.collapse.show, .accordion-collapse.show, .card-body');
    const scope = collapseBody && isVisible(collapseBody) ? collapseBody : rootBox;

    // Look for clickable channel cards/links/buttons inside the expanded section
    const candidates = Array.from(
      scope.querySelectorAll(
        'a[href], button, [onclick], [role="button"], .payment-channel, .channel-item, .channel-box, .list-group-item, div[class*="channel" i], div[class*="denom" i], div[class*="payment" i]'
      )
    ).filter((el) => {
      if (!isVisible(el)) return false;
      if (el.id === 'arora-ext-helper-bar' || el.closest('#arora-ext-helper-bar')) return false;
      // NEVER click a Back button or select_denom link!
      const href = (el.getAttribute('href') || '').toLowerCase();
      if (href.includes('select_denom') || href.includes('back') || href === '#' || href.startsWith('javascript:')) {
        if (href.includes('select_denom') || href.includes('back')) return false;
      }
      // Skip the accordion toggle header itself
      if (el.hasAttribute('data-toggle') || el.hasAttribute('data-bs-toggle') || el.hasAttribute('aria-expanded')) {
        return false;
      }
      const txt = (el.innerText || '').trim();
      if (headerRegex && headerRegex.test(txt)) return false;
      if (/Select Payment Channel/i.test(txt)) return false;
      // Must have either a payment channel URL, a price (BDT/UP/RM/MYR), or a recognizable channel name/image inside an expanded body
      const hasChannelImg = Boolean(el.querySelector('img'));
      return (
        href.includes('/unibox/c/') ||
        href.includes('/unibox/p/') ||
        href.includes('channel') ||
        /BDT|UP\s*\d|RM\s*\d|MYR|UniPin\s*Voucher|UP\s*Gift\s*Card|Up\s*Points|UPPoints|UniPin\s*Credits/i.test(txt) ||
        (Boolean(collapseBody) && hasChannelImg)
      );
    });

    // Deduplicate to deepest clickable elements so we don't return both wrapper and inner link
    const leaves = candidates.filter((el) => !candidates.some((other) => other !== el && el.contains(other)));
    return leaves.length > 0 ? leaves : candidates;
  }

  async function runAutomationStep() {
    if (stepBusy) return;
    stepBusy = true;

    try {
      chrome.storage.local.get(['activeTask'], async (res) => {
        const task = res.activeTask;
        if (!task) {
          const oldBar = document.getElementById('arora-ext-helper-bar');
          if (oldBar) oldBar.remove();
          stepBusy = false;
          return;
        }

        // 1. NEVER bypass CAPTCHA — report to Admin for manual delivery, never retry, and auto-close tab
        if (isVisibleCaptchaOnPage()) {
          renderFloatingBar(task, 'CAPTCHA Detected! Notifying Admin & closing tab...', true);
          reportOnce(task, {
            orderUtr: task.order_utr,
            status: 'CANCELLED',
            errorMessage: 'CAPTCHA required on Garena/UniPin — Auto delivery failed, please deliver manually',
            releaseVoucher: true,
          });
          stepBusy = false;
          return;
        }

        const host = location.hostname;
        const url = location.href;

        // Wait until the page has completely finished loading (+ settle time) before running any command
        if (!isPageReady()) {
          renderFloatingBar(task, 'Waiting for page to finish loading...', false);
          stepBusy = false;
          return;
        }

        // If a loading overlay/spinner is visible (slow network), wait patiently
        if (isPageLoadingOverlayVisible()) {
          renderFloatingBar(task, 'Network/page busy — waiting patiently...', false);
          stepBusy = false;
          return;
        }

        // ==================== A. GARENA SHOP (shop.garena.my) ====================
        if (host.includes('shop.garena.my')) {
          const proceedBtn = findDeepestByText(/Proceed to Payment/i);
          if (proceedBtn) {
            if (isInActionCooldown('garena_proceed', 7000)) {
              renderFloatingBar(task, 'Waiting for UniPin page to load...', false);
              stepBusy = false;
              return;
            }
            markAction('garena_proceed');
            renderFloatingBar(task, 'UID Verified! Clicking Proceed to Payment...', false);
            triggerRealClick(proceedBtn);
            stepBusy = false;
            return;
          }

          const bodyTxt = document.body?.innerText || '';
          if (/invalid player|player id not found|player not found|account not found|does not exist|incorrect player|wrong player|not a valid|check your (player )?id/i.test(bodyTxt)) {
            renderFloatingBar(task, 'Wrong Free Fire ID. Order cancelled.', true);
            reportOnce(task, {
              orderUtr: task.order_utr,
              status: 'CANCELLED',
              errorMessage: `Could not log in to Free Fire ID ${task.player_uid}. The order is cancelled.`,
              releaseVoucher: true,
            });
            stepBusy = false;
            return;
          }

          const uidInput = document.querySelector('input[placeholder*="player ID" i], input[placeholder*="UID" i]');
          if (uidInput && isVisible(uidInput)) {
            if (Number(task.uidTries || 0) >= 1) {
              renderFloatingBar(task, 'Could not log in to this Free Fire ID. Order cancelled.', true);
              reportOnce(task, {
                orderUtr: task.order_utr,
                status: 'CANCELLED',
                errorMessage: `Could not log in to Free Fire ID ${task.player_uid}. The order is cancelled.`,
                releaseVoucher: true,
              });
              stepBusy = false;
              return;
            }
            if (isInActionCooldown('garena_uid_login', 7000)) {
              renderFloatingBar(task, 'Waiting for Garena UID verification...', false);
              stepBusy = false;
              return;
            }
            markAction('garena_uid_login');
            chrome.storage.local.set({ activeTask: { ...task, uidTries: 1 } }, () => {
            renderFloatingBar(task, `Entering UID ${task.player_uid} & clicking Login...`, false);
            if (uidInput.value !== String(task.player_uid)) {
              setNativeValue(uidInput, task.player_uid);
            }
            setTimeout(() => {
              // Strictly pick the real <button>Login</button> next to the UID input (NEVER the "1 Login" heading text!)
              const formScope = uidInput.closest('form') || uidInput.parentElement?.parentElement || document;
              let loginBtn =
                Array.from(formScope.querySelectorAll('button, input[type="submit"]')).find(
                  (b) => isVisible(b) && /^\s*Login\s*$/i.test(b.innerText || b.value || '')
                ) || null;

              if (!loginBtn) {
                const inpTop = uidInput.getBoundingClientRect().top;
                const allBtns = Array.from(document.querySelectorAll('button, input[type="submit"]')).filter(
                  (b) => isVisible(b) && /^\s*Login\s*$/i.test(b.innerText || b.value || '')
                );
                allBtns.sort((a, b) => Math.abs(a.getBoundingClientRect().top - inpTop) - Math.abs(b.getBoundingClientRect().top - inpTop));
                loginBtn = allBtns[0] || null;
              }

              if (loginBtn) clickSingleElement(loginBtn);
            }, FORM_SUBMIT_DELAY_MS);
            });
          } else {
            if (!isInActionCooldown('garena_select_ff', 5000)) {
              const ffEl = findDeepestByText(/^Free Fire$/i);
              if (ffEl) {
                markAction('garena_select_ff');
                triggerRealClick(ffEl);
              }
            }
            renderFloatingBar(task, 'Selecting Free Fire on Garena Shop...', false);
          }
          stepBusy = false;
          return;
        }

        // ==================== B. UNIPIN (unipin.com) ====================
        if (host.includes('unipin.com')) {
          const pageText = document.body?.innerText || '';

          // 1. Transaction Completed Receipt -> Mark COMPLETED & Auto-close tab
          if (isUniPinSuccessPage(pageText, url)) {
            renderFloatingBar(task, 'Payment Successful! Marking Completed & closing tab...', false);
            reportOnce(task, {
              orderUtr: task.order_utr,
              status: 'COMPLETED',
              receiptNote:
                task.mode === 'unipin_voucher'
                  ? `Redeemed via ${task.voucher?.channel_name} (${task.voucher?.prefix})`
                  : `Paid via Up Points (${task.account?.label})`,
            });
            stepBusy = false;
            return;
          }

          // 2. Voucher / Payment / Validation / Unibox Error -> Notify Admin (No Auto-Retry) & Auto-close tab
          // If Confirm was just clicked (< 2.5s ago), let DOM settle before reading errors
          const allowErrorCheck = confirmClickedAt === 0 || Date.now() - confirmClickedAt >= 2500;
          if (allowErrorCheck) {
            const domErrText = findVisiblePageError();
            const textErrMatch = pageText.match(
              /Voucher already used|Voucher has been used|Invalid voucher|Invalid serial|Invalid PIN|Incorrect PIN|Wrong PIN|Insufficient balance|Not enough balance|Transaction Failed|Payment Failed|Unibox Error|Session expired|Unable to process|currently out of stock|Please enter no more than[^.\n]*|Please fill all Voucher field/i
            );
            if (domErrText || textErrMatch) {
              const errDetail = domErrText || textErrMatch[0];
              // Self-heal: if UniPin rejects dashed serial with "no more than 14 characters", retry once without hyphens!
              if (
                task.mode === 'unipin_voucher' &&
                task.voucher &&
                !retriedSerialNoDash &&
                /no more than \d+ characters/i.test(errDetail) &&
                /-/.test(task.voucher.serial || '')
              ) {
                retriedSerialNoDash = true;
                confirmClickedAt = 0;
                renderFloatingBar(task, 'Adjusting serial format (removing hyphens) & retrying...', false);
                stepBusy = false;
                return;
              }
              renderFloatingBar(task, `Failed (${errDetail})! Notifying Admin & closing tab...`, true);
              reportOnce(task, {
                orderUtr: task.order_utr,
                status: 'CANCELLED',
                errorMessage: `UniPin Error: ${errDetail} — Auto delivery failed, please complete manually`,
                releaseVoucher: false,
              });
              stepBusy = false;
              return;
            }
          }

          // 3. Denomination Selection Page (/unibox/select_denom/)
          if (url.includes('select_denom') || /Select Amount/i.test(pageText)) {
            if (isInActionCooldown('unipin_denom', 7000)) {
              renderFloatingBar(task, `Selected ${task.denom_label} — waiting for payment channel page...`, false);
              stepBusy = false;
              return;
            }
            const escaped = task.denom_label.replace(/\s+/g, '\\s+');
            const denomEl = findDeepestByText(new RegExp(`^\\s*${escaped}\\s*$`, 'i'));
            if (denomEl) {
              denomMissingCount = 0;
              markAction('unipin_denom');
              renderFloatingBar(task, `Selecting package: ${task.denom_label}...`, false);
              triggerRealClick(denomEl);
            } else {
              denomMissingCount += 1;
              if (denomMissingCount >= 12) {
                renderFloatingBar(task, `Package "${task.denom_label}" not found! Notifying Admin...`, true);
                reportOnce(task, {
                  orderUtr: task.order_utr,
                  status: 'CANCELLED',
                  errorMessage: `Package "${task.denom_label}" not found/unavailable on UniPin — Manual delivery required`,
                  releaseVoucher: true,
                });
              } else {
                renderFloatingBar(task, `Waiting for "${task.denom_label}" to load (${denomMissingCount}/12)...`, false);
              }
            }
            stepBusy = false;
            return;
          }

          // 4. Select Payment Channel Page (/unibox/d/)
          if (/Select Payment Channel/i.test(pageText) || url.includes('/unibox/d/')) {
            if (isInActionCooldown('unipin_channel', 7000)) {
              renderFloatingBar(task, 'Payment channel clicked — waiting for next page to load...', false);
              stepBusy = false;
              return;
            }
            if (task.mode === 'unipin_voucher' && task.voucher) {
              const panel = document.getElementById('VOUCHER_panel');
              const wantUpGift = task.voucher.prefix === 'UPBD';
              const targetName = task.voucher.channel_name; // "UniPin Voucher" (BDMB) or "UP Gift Card" (UPBD)

              if (panel) {
                const isOpen = panel.classList.contains('show') || panel.classList.contains('collapsing');
                if (!isOpen) {
                  const toggleBtn = document.querySelector('[data-target="#VOUCHER_panel"]');
                  renderFloatingBar(task, 'Opening Physical Vouchers section...', false);
                  if (toggleBtn && Date.now() - lastAccordionClickAt >= 2500) {
                    lastAccordionClickAt = Date.now();
                    toggleBtn.click();
                  }
                  stepBusy = false;
                  return;
                }

                // Panel is open! Strictly pick by text & DOM position (NEVER trust hardcoded pc_div_* IDs):
                // BDMB -> 1st button ("UniPin Voucher"), UPBD -> 2nd button ("UP Gift Card")
                const buttons = Array.from(panel.querySelectorAll('.payment-channel-button')).filter(isVisible);
                let targetBtn = null;
                if (wantUpGift) {
                  targetBtn =
                    buttons.find((b) => /UP\s*Gift\s*Card/i.test(b.innerText || '')) ||
                    (buttons.length > 1 ? buttons[1] : buttons[0]);
                } else {
                  targetBtn =
                    buttons.find(
                      (b) => /UniPin\s*Voucher/i.test(b.innerText || '') && !/UP\s*Gift\s*Card/i.test(b.innerText || '')
                    ) || buttons[0];
                }

                if (targetBtn) {
                  markAction('unipin_channel');
                  renderFloatingBar(task, `Prefix ${task.voucher.prefix} -> Clicking ${targetName}...`, false);
                  targetBtn.click();
                  stepBusy = false;
                  return;
                }
              }

              renderFloatingBar(task, 'Waiting for Physical Vouchers panel...', false);
              stepBusy = false;
              return;
            }

            if (task.mode === 'loaded_account') {
              const panel = document.getElementById('WALLET_panel');
              if (panel) {
                const isOpen = panel.classList.contains('show') || panel.classList.contains('collapsing');
                if (!isOpen) {
                  const toggleBtn = document.querySelector('[data-target="#WALLET_panel"]');
                  renderFloatingBar(task, 'Opening Wallet section...', false);
                  if (toggleBtn && Date.now() - lastAccordionClickAt >= 2500) {
                    lastAccordionClickAt = Date.now();
                    toggleBtn.click();
                  }
                  stepBusy = false;
                  return;
                }

                // Panel is open! Find Up Points button (#pc_div_669)
                const buttons = Array.from(panel.querySelectorAll('.payment-channel-button'));
                const targetBtn =
                  document.getElementById('pc_div_669') ||
                  buttons.find((b) => /Up\s*Points|UP\s*Gift\s*Card|UniPin\s*Credits/i.test(b.innerText || '')) ||
                  buttons[0];

                if (targetBtn) {
                  markAction('unipin_channel');
                  renderFloatingBar(task, 'Selecting Up Points inside Wallet...', false);
                  targetBtn.click();
                  stepBusy = false;
                  return;
                }
              }

              renderFloatingBar(task, 'Waiting for Wallet panel...', false);
              stepBusy = false;
              return;
            }
          }

          // 5. Voucher Serial/PIN Input OR Loaded Account Security PIN Page (/unibox/c/)
          // IMPORTANT: Always exclude submit/button/reset/image inputs so we NEVER type into the orange CONFIRM submit button!
          const visibleInputs = Array.from(
            document.querySelectorAll(
              'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"])'
            )
          ).filter(isVisible);

          function findConfirmSubmitButton() {
            const submitInput = Array.from(document.querySelectorAll('input[type="submit"], button[type="submit"]')).find(
              (el) => isVisible(el) && /^(Confirm|Submit|Redeem|Pay)$/i.test((el.value || el.innerText || '').trim())
            );
            if (submitInput) return submitInput;
            const anySubmit = Array.from(document.querySelectorAll('input[type="submit"], button[type="submit"]')).find(isVisible);
            if (anySubmit) return anySubmit;
            return findDeepestByText(/^(Confirm|Submit|Redeem|Pay)$/i);
          }

          if (task.mode === 'unipin_voucher' && task.voucher && visibleInputs.length > 0) {
            if (confirmClickedAt > 0) {
              const waitedMs = Date.now() - confirmClickedAt;
              const waitedSec = Math.round(waitedMs / 1000);
              if (waitedMs > CONFIRM_WAIT_TIMEOUT_MS) {
                const postErr =
                  findVisiblePageError() ||
                  'No confirmation received after 60s — Check UniPin history before retrying';
                renderFloatingBar(task, `Timed out (${waitedSec}s)! Notifying Admin...`, true);
                reportOnce(task, {
                  orderUtr: task.order_utr,
                  status: 'CANCELLED',
                  errorMessage: `UniPin Voucher Timeout: ${postErr}`,
                  releaseVoucher: false,
                });
              } else {
                renderFloatingBar(task, `Voucher submitted — waiting for UniPin confirmation (${waitedSec}s)...`, false);
              }
              stepBusy = false;
              return;
            }
            renderFloatingBar(task, `Filling ${task.voucher.prefix} Token & Confirming...`, false);
            const rawSerial = String(task.voucher.serial || '').trim();
            const noDashSerial = rawSerial.replace(/[^A-Za-z0-9]/g, '');
            const rawPin = String(task.voucher.pin || '').replace(/[^A-Za-z0-9]/g, '');
            const fmtPin = String(task.voucher.pin_formatted || rawPin).trim();

            function fitValueToInput(el, preferredVal, noDashVal) {
              if (retriedSerialNoDash && noDashVal) return noDashVal;
              const maxAttr = parseInt(
                el.getAttribute('maxlength') || el.getAttribute('data-rule-maxlength') || '0',
                10
              );
              if (maxAttr > 0 && preferredVal.length > maxAttr && noDashVal && noDashVal.length <= maxAttr) {
                return noDashVal;
              }
              return preferredVal;
            }

            if (visibleInputs.length === 1) {
              setNativeValue(visibleInputs[0], fitValueToInput(visibleInputs[0], fmtPin || rawSerial, rawPin || noDashSerial));
            } else if (visibleInputs.length === 2) {
              setNativeValue(visibleInputs[0], fitValueToInput(visibleInputs[0], rawSerial, noDashSerial));
              setNativeValue(visibleInputs[1], fitValueToInput(visibleInputs[1], fmtPin, rawPin));
            } else {
              setNativeValue(visibleInputs[0], fitValueToInput(visibleInputs[0], rawSerial, noDashSerial));
              const chunks = rawPin.match(/.{1,4}/g) || [];
              for (let i = 1; i < visibleInputs.length && i - 1 < chunks.length; i++) {
                setNativeValue(visibleInputs[i], chunks[i - 1]);
              }
            }
            confirmClickedAt = Date.now();
            setTimeout(() => {
              const confirmBtn = findConfirmSubmitButton();
              if (confirmBtn) clickSingleElement(confirmBtn);
            }, FORM_SUBMIT_DELAY_MS);
            stepBusy = false;
            return;
          }

          if (task.mode === 'loaded_account' && task.account) {
            // Email + Password login screen
            const emailInp = document.querySelector('input[type="email"], input[name*="email" i]');
            if (emailInp && isVisible(emailInp)) {
              if (isInActionCooldown('unipin_login', 8000)) {
                renderFloatingBar(task, 'Signing in — waiting for Security PIN page...', false);
                stepBusy = false;
                return;
              }
              markAction('unipin_login');
              renderFloatingBar(task, `Signing into ${task.account.label}...`, false);
              setNativeValue(emailInp, task.account.email);
              const passInp = document.querySelector('input[type="password"]');
              if (passInp && isVisible(passInp)) setNativeValue(passInp, task.account.password);
              setTimeout(() => {
                const loginBtn =
                  Array.from(document.querySelectorAll('button[type="submit"], input[type="submit"]')).find(isVisible) ||
                  findDeepestByText(/^(Sign In|Login|Log In|Submit|Continue)$/i);
                if (loginBtn) clickSingleElement(loginBtn);
              }, FORM_SUBMIT_DELAY_MS);
              stepBusy = false;
              return;
            }

            // 6-Digit Security PIN screen (UniPin v5 uses .input-pin-hidden and/or 6 individual PIN inputs!)
            const pinDigits = String(task.account.security_pin || '').trim();
            const hiddenPinInp = document.querySelector('input.input-pin-hidden, input[name="pin"], input[name="security_pin"]');
            const sixBoxInputs = Array.from(
              document.querySelectorAll(
                'input[maxlength="1"]:not([type="hidden"]):not([type="submit"]), input[class*="pin" i]:not(.input-pin-hidden):not([type="hidden"]):not([type="submit"])'
              )
            ).filter(isVisible);
            const hasPinScreen = /Security PIN/i.test(pageText) || Boolean(hiddenPinInp) || sixBoxInputs.length >= 6 || visibleInputs.length >= 6;

            if (pinDigits.length === 6 && hasPinScreen) {
              // Patiently wait up to 60s for UniPin to process payment & redirect to Success page!
              // Genuine errors (Wrong PIN / Insufficient balance) are caught immediately by step #2 above.
              if (confirmClickedAt > 0) {
                const waitedMs = Date.now() - confirmClickedAt;
                const waitedSec = Math.round(waitedMs / 1000);
                if (waitedMs > CONFIRM_WAIT_TIMEOUT_MS) {
                  const postErr =
                    findVisiblePageError() ||
                    'No confirmation received after 60s — Check UniPin Transaction History before retrying';
                  renderFloatingBar(task, `Timed out (${waitedSec}s)! Notifying Admin...`, true);
                  reportOnce(task, {
                    orderUtr: task.order_utr,
                    status: 'CANCELLED',
                    errorMessage: `UniPin Account Payment Timeout: ${postErr}`,
                    releaseVoucher: false,
                  });
                } else {
                  renderFloatingBar(task, `Payment submitted — waiting for UniPin confirmation (${waitedSec}s)...`, false);
                }
                stepBusy = false;
                return;
              }
              renderFloatingBar(task, 'Entering 6-Digit Security PIN & Confirming...', false);

              // Fill all 6 individual visible boxes if present
              const boxPool = sixBoxInputs.length >= 6 ? sixBoxInputs : visibleInputs.length >= 6 ? visibleInputs : [];
              if (boxPool.length >= 6) {
                for (let i = 0; i < 6; i++) {
                  setNativeValue(boxPool[i], pinDigits[i]);
                }
              }
              // ALSO fill UniPin's .input-pin-hidden backing input if present (and update any visual digit boxes)
              if (hiddenPinInp) {
                setNativeValue(hiddenPinInp, pinDigits);
              } else if (boxPool.length === 0 && visibleInputs.length > 0) {
                setNativeValue(visibleInputs[0], pinDigits);
              }

              confirmClickedAt = Date.now();
              setTimeout(() => {
                const confirmBtn = findConfirmSubmitButton();
                if (confirmBtn) clickSingleElement(confirmBtn);
              }, FORM_SUBMIT_DELAY_MS);
              stepBusy = false;
              return;
            }
          }

          renderFloatingBar(task, 'Waiting for UniPin page step...', false);
        }

        stepBusy = false;
      });
    } catch (_) {
      stepBusy = false;
    }
  }

  setTimeout(runAutomationStep, 1800);
  setInterval(runAutomationStep, STEP_INTERVAL_MS);
})();
