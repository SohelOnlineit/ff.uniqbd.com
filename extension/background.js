const DEFAULT_API_BASE = 'https://ff.uniqbd.com';
const GARENA_SHOP_URL = 'https://shop.garena.my/?channel=202953';

function normalizeBase(value) {
  const base = String(value || '').trim().replace(/\/+$/, '');
  if (!base || base === 'https://api.arorashop.com') return DEFAULT_API_BASE;
  return base;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['apiBase'], (res) => {
    chrome.storage.local.set({ apiBase: normalizeBase(res.apiBase) });
  });
  chrome.alarms.create('aroraPollOrders', { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'aroraPollOrders') {
    pollNextOrder(false);
  }
});

async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      ['apiBase', 'extKey', 'autoListen', 'activeTask', 'activeTabId', 'lastLog'],
      (res) => {
        resolve({
          apiBase: normalizeBase(res.apiBase),
          extKey: (res.extKey || '').trim(),
          autoListen: Boolean(res.autoListen),
          activeTask: res.activeTask || null,
          activeTabId: res.activeTabId || null,
          lastLog: res.lastLog || 'Idle',
        });
      }
    );
  });
}

async function clearGarenaShopCookies() {
  try {
    const domains = ['garena.my', 'garena.com'];
    for (const domain of domains) {
      const cookies = await chrome.cookies.getAll({ domain });
      for (const c of cookies) {
        const cleanDomain = c.domain.replace(/^\./, '');
        const url = `https://${cleanDomain}${c.path || '/'}`;
        await chrome.cookies.remove({ url, name: c.name }).catch(() => {});
      }
    }
  } catch (_) {}
}

async function closeFulfillmentTab(tabId) {
  if (!tabId) return;
  try {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return;
    const url = tab.url || '';
    // Safety: only auto-close Garena Shop or UniPin tabs (never close api.arorashop.com dashboard)
    if (!url.includes('shop.garena.my') && !url.includes('unipin.com')) {
      return;
    }
    const tabsInWindow = await chrome.tabs.query({ windowId: tab.windowId });
    if (tabsInWindow.length <= 1) {
      // Keep browser alive so background polling continues for future orders
      await chrome.tabs.create({ windowId: tab.windowId, url: 'chrome://newtab', active: false });
    }
    await chrome.tabs.remove(tabId).catch(() => {});
  } catch (_) {}
}

async function pollNextOrder(force = false) {
  const st = await getSettings();
  if (!st.extKey) return { ok: false, error: 'Extension Key not set.' };

  // Patient global fail-safe timeout: 150s normal, up to 240s if the active tab is still actively loading over a slow network
  if (st.activeTask && st.activeTask.startedAt) {
    const elapsedMs = Date.now() - st.activeTask.startedAt;
    if (elapsedMs > 150000) {
      let tabIsLoading = false;
      if (st.activeTabId) {
        const activeTab = await chrome.tabs.get(st.activeTabId).catch(() => null);
        if (activeTab && activeTab.status === 'loading') {
          tabIsLoading = true;
        }
      }
      if (!tabIsLoading || elapsedMs > 240000) {
        const secs = Math.round(elapsedMs / 1000);
        await submitOrderResult(
          {
            orderUtr: st.activeTask.order_utr,
            status: 'PROCESSING',
            errorMessage: `Auto delivery timed out (${secs}s) — Check UniPin Transaction History before retrying or completing manually`,
            releaseVoucher: false,
          },
          st.activeTabId
        );
        return { ok: true, timedOut: true };
      }
    }
  }

  if (!force && (!st.autoListen || st.activeTask)) {
    return { ok: true, skipped: true };
  }

  try {
    const res = await fetch(`${st.apiBase}/ext-api/next-order`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Extension-Key': st.extKey,
      },
    });
    const data = await res.json();
    if (!data.ok) {
      await chrome.storage.local.set({ lastLog: data.error || 'Auth error' });
      return data;
    }

    if (!data.task) {
      await chrome.storage.local.set({ lastLog: 'Queue empty — waiting for orders' });
      return { ok: true, task: null };
    }

    const task = {
      ...data.task,
      step: 'GARENA_UID',
      pausedForCaptcha: false,
      startedAt: Date.now(),
    };

    await chrome.storage.local.set({
      activeTask: task,
      lastLog: `Picked Order ${task.order_utr} (${task.package_name})`,
    });

    // Always clear previous Garena Shop session cookies before starting a fresh UID order
    await clearGarenaShopCookies();

    // Open or reuse Garena Shop / UniPin tab
    const tabs = await chrome.tabs.query({
      url: ['https://shop.garena.my/*', 'https://unipin.com/*', 'https://*.unipin.com/*'],
    });
    let targetTab = null;
    if (tabs.length > 0) {
      targetTab = await chrome.tabs.update(tabs[0].id, { url: GARENA_SHOP_URL, active: true });
    } else {
      targetTab = await chrome.tabs.create({ url: GARENA_SHOP_URL, active: true });
    }

    await chrome.storage.local.set({
      activeTabId: targetTab ? targetTab.id : null,
    });

    return { ok: true, task };
  } catch (err) {
    await chrome.storage.local.set({ lastLog: 'Network error: ' + err.message });
    return { ok: false, error: err.message };
  }
}

async function submitOrderResult({ orderUtr, status, receiptNote, errorMessage, releaseVoucher }, senderTabId = null) {
  const st = await getSettings();
  if (!st.extKey) return { ok: false, error: 'Missing Extension Key' };

  const tabToClose = senderTabId || st.activeTabId || null;

  try {
    const res = await fetch(`${st.apiBase}/ext-api/order-result`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Extension-Key': st.extKey,
      },
      body: JSON.stringify({
        order_utr: orderUtr,
        status,
        receipt_note: receiptNote,
        error_message: errorMessage,
        release_voucher: Boolean(releaseVoucher),
      }),
    });
    const data = await res.json();
    await chrome.storage.local.set({
      activeTask: null,
      activeTabId: null,
      lastLog: status === 'COMPLETED'
        ? `Completed ${orderUtr} — Tab closed`
        : `Failed ${orderUtr} (Admin notified, no retry) — Tab closed`,
    });

    // Clear Garena Shop cookies immediately so next order always starts with a clean UID login
    await clearGarenaShopCookies();

    // Auto-close the Garena/UniPin tab after a 3.5s pause so operator can see the confirmation clearly
    if (tabToClose) {
      setTimeout(() => {
        closeFulfillmentTab(tabToClose);
      }, 3500);
    }

    return data;
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'POLL_NOW') {
    pollNextOrder(true).then(sendResponse);
    return true;
  }
  if (msg.type === 'REPORT_ORDER_RESULT') {
    const senderTabId = sender && sender.tab ? sender.tab.id : null;
    submitOrderResult(msg.payload, senderTabId).then(sendResponse);
    return true;
  }
  if (msg.type === 'CLEAR_ACTIVE_TASK') {
    chrome.storage.local.set({ activeTask: null, activeTabId: null, lastLog: 'Cleared active task' }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }
});
