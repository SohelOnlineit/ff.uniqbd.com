const DEFAULT_API_BASE = 'https://ff.uniqbd.com';
const GARENA_SHOP_URL = 'https://shop.garena.my/?channel=202953';
let pollChain = Promise.resolve();

function shownOrder(task) {
  const shop = String((task && task.shop_order_number) || '').trim();
  const code = shop || String((task && task.order_utr) || '').trim();
  if (/^\d+$/.test(code)) return '#' + code;
  const pair = code.match(/^(\d+)-\d+$/);
  return pair ? '#' + pair[1] : code;
}

function ensurePollAlarm() {
  chrome.alarms.clear('aroraPollOrders');
  chrome.alarms.create('uniqbdPollOrders', { periodInMinutes: 0.1 });
}

ensurePollAlarm();
pollNextOrder(false);
chrome.runtime.onInstalled.addListener(ensurePollAlarm);
chrome.runtime.onStartup.addListener(() => {
  ensurePollAlarm();
  pollNextOrder(false);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'uniqbdPollOrders') {
    pollNextOrder(false);
  }
});

async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      ['apiBase', 'extKey', 'autoListen', 'activeTask', 'activeTabId', 'lastLog', 'pendingResult'],
      (res) => {
        const savedBase = String(res.apiBase || '').trim().replace(/\/+$/, '');
        const apiBase = DEFAULT_API_BASE;
        if (savedBase !== apiBase) chrome.storage.local.set({ apiBase });
        resolve({
          apiBase,
          extKey: (res.extKey || '').trim(),
          autoListen: Boolean(res.autoListen),
          activeTask: res.activeTask || null,
          activeTabId: res.activeTabId || null,
          lastLog: res.lastLog || 'Idle',
          pendingResult: res.pendingResult || null,
        });
      }
    );
  });
}

const SHOP_COOKIE_DOMAINS = ['garena.my', 'garena.com', 'unipin.com'];
const SHOP_ORIGINS = [
  'https://shop.garena.my',
  'https://garena.my',
  'https://www.garena.my',
  'https://unipin.com',
  'https://www.unipin.com',
];

function cookieRemovalUrl(cookie) {
  const host = String(cookie.domain || '').replace(/^\./, '');
  const protocol = cookie.secure ? 'https:' : 'http:';
  return `${protocol}//${host}${cookie.path || '/'}`;
}

async function clearShopCookies() {
  try {
    const stores = await chrome.cookies.getAllCookieStores().catch(() => []);
    const storeIds = stores.length ? stores.map((store) => store.id) : [undefined];
    for (const storeId of storeIds) {
      for (const domain of SHOP_COOKIE_DOMAINS) {
        const cookies = await chrome.cookies.getAll(storeId ? { domain, storeId } : { domain });
        for (const cookie of cookies) {
          const details = { url: cookieRemovalUrl(cookie), name: cookie.name };
          if (cookie.storeId) details.storeId = cookie.storeId;
          if (cookie.partitionKey) details.partitionKey = cookie.partitionKey;
          await chrome.cookies.remove(details).catch(() => {});
        }
      }
    }
  } catch (_) {}
  try {
    if (chrome.browsingData && chrome.browsingData.remove) {
      await chrome.browsingData.remove(
        { origins: SHOP_ORIGINS },
        { cookies: true, localStorage: true }
      );
    }
  } catch (_) {}
}

function isDeliveryTab(url) {
  try {
    const host = new URL(url).hostname;
    return host === 'shop.garena.my' || host === 'unipin.com' || host.endsWith('.unipin.com');
  } catch (_) {
    return false;
  }
}

async function closeFulfillmentTab(tabId) {
  if (!tabId) return;
  try {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || !isDeliveryTab(tab.url || '')) return;
    const tabsInWindow = await chrome.tabs.query({ windowId: tab.windowId });
    if (tabsInWindow.length <= 1) {
      // Keep browser alive so background polling continues for future orders
      await chrome.tabs.create({ windowId: tab.windowId, url: 'chrome://newtab', active: false });
    }
    await chrome.tabs.remove(tabId).catch(() => {});
  } catch (_) {}
}

async function pingDesk(st) {
  if (!st.extKey) return { ok: false, error: 'Extension key is not saved' };
  try {
    const res = await fetch(`${st.apiBase}/ext-api/ping`, {
      method: 'GET',
      headers: { 'X-Extension-Key': st.extKey },
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 404) return { ok: true };
    if (!res.ok || data.ok === false) {
      return { ok: false, error: data.error || 'Website rejected the extension key' };
    }
    return { ok: true };
  } catch (_) {
    return { ok: false, error: 'Cannot reach ff.uniqbd.com' };
  }
}

function pollNextOrder(force = false) {
  const run = pollChain.then(() => pollNextOrderNow(force));
  pollChain = run.then(() => undefined, () => undefined);
  return run;
}

async function pollNextOrderNow(force = false) {
  const st = await getSettings();
  if (!st.extKey) {
    await chrome.storage.local.set({ lastLog: 'Extension key is not saved' });
    return { ok: false, error: 'Extension key is not saved' };
  }
  const ping = await pingDesk(st);
  if (!ping.ok) {
    await chrome.storage.local.set({ lastLog: ping.error });
    return ping;
  }
  if (st.pendingResult && st.pendingResult.orderUtr) {
    const sent = await submitOrderResult(st.pendingResult, null);
    if (!sent || sent.ok === false) return { ok: false, error: 'Website did not save the order status' };
    st.pendingResult = null;
    st.activeTask = null;
    st.activeTabId = null;
  }

  // A task with no start time, or one that has already run too long, must not block the next order.
  if (st.activeTask && !st.activeTask.startedAt) {
    await chrome.storage.local.set({ activeTask: null, activeTabId: null, lastLog: 'Cleared a stuck task' });
    st.activeTask = null;
  }

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
            status: 'CANCELLED',
            errorMessage: `Auto delivery timed out (${secs}s). The order is cancelled.`,
            releaseVoucher: true,
          },
          st.activeTabId
        );
        return { ok: true, timedOut: true };
      }
    }
  }

  if (!force && (!st.autoListen || st.activeTask)) {
    if (!st.activeTask) await chrome.storage.local.set({ lastLog: 'Connected to ff.uniqbd.com' });
    return { ok: true, connected: true, skipped: true };
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
      pausedForCaptcha: false,
      startedAt: Date.now(),
    };

    await chrome.storage.local.set({
      activeTask: task,
      lastLog: `Picked Order ${shownOrder(task)} (${task.package_name})`,
    });

    // Always clear previous Garena Shop session cookies before starting a fresh UID order
    await clearShopCookies();

    // Open or reuse Garena Shop / UniPin tab
    const tabs = await chrome.tabs.query({
      url: ['https://shop.garena.my/*', 'https://unipin.com/*', 'https://*.unipin.com/*'],
    });
    let targetTab = null;
    const freshUrl = `${GARENA_SHOP_URL}&start=${task.startedAt}`;
    if (tabs.length > 0) {
      targetTab = await chrome.tabs.update(tabs[0].id, { url: freshUrl, active: true });
    } else {
      targetTab = await chrome.tabs.create({ url: freshUrl, active: true });
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
  const allowed = ['COMPLETED', 'LOGIN_FAILED', 'CANCELLED'];
  if (!allowed.includes(status) || !String(orderUtr || '').trim()) {
    return { ok: false, error: 'Invalid order result' };
  }
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
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      await chrome.storage.local.set({
        pendingResult: { orderUtr, status, receiptNote, errorMessage, releaseVoucher },
        lastLog: `Website did not update ${orderUtr}. Trying again.`,
      });
      return { ok: false, error: data.error || 'Extension API failed' };
    }
    await chrome.storage.local.set({
      pendingResult: null,
      activeTask: null,
      activeTabId: null,
      lastLog: status === 'COMPLETED'
        ? `Completed ${orderUtr}`
        : status === 'LOGIN_FAILED'
        ? `Login Failed ${orderUtr}`
        : `Cancelled ${orderUtr}`,
    });

    // Clear Garena Shop cookies immediately so next order always starts with a clean UID login
    await clearShopCookies();

    // Auto-close the Garena/UniPin tab after a 3.5s pause so operator can see the confirmation clearly
    if (tabToClose) {
      setTimeout(() => {
        clearShopCookies().finally(() => closeFulfillmentTab(tabToClose));
      }, 3500);
    }

    return data;
  } catch (err) {
    await chrome.storage.local.set({
      pendingResult: { orderUtr, status, receiptNote, errorMessage, releaseVoucher },
      lastLog: `Website did not update ${orderUtr}. Trying again.`,
    });
    return { ok: false, error: err.message };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  if (sender.id !== chrome.runtime.id) return;
  if (msg.type === 'POLL_NOW' || msg.type === 'CHECK_CONNECTION') {
    pollNextOrder(msg.type === 'POLL_NOW').then(sendResponse);
    return true;
  }
  if (msg.type === 'REPORT_ORDER_RESULT') {
    const senderTabId = sender && sender.tab ? sender.tab.id : null;
    const pageUrl = String((sender && sender.url) || '');
    let allowedPage = false;
    try {
      const host = new URL(pageUrl).hostname;
      allowedPage = host === 'shop.garena.my' || host === 'unipin.com' || host.endsWith('.unipin.com');
    } catch (_) {}
    if (!allowedPage) {
      sendResponse({ ok: false, error: 'This page cannot report an order' });
      return;
    }
    submitOrderResult(msg.payload || {}, senderTabId).then(sendResponse);
    return true;
  }
  if (msg.type === 'CLEAR_ACTIVE_TASK') {
    chrome.storage.local.set({ activeTask: null, activeTabId: null, lastLog: 'Cleared active task' }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }
});
