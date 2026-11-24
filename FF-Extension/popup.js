function shownOrder(task) {
  const shop = String((task && task.shop_order_number) || '').trim();
  const code = shop || String((task && task.order_utr) || '').trim();
  if (/^\d+$/.test(code)) return '#' + code;
  const pair = code.match(/^(\d+)-\d+$/);
  return pair ? '#' + pair[1] : code;
}

document.addEventListener('DOMContentLoaded', () => {
  const apiBaseEl = document.getElementById('apiBase');
  const extKeyEl = document.getElementById('extKey');
  const autoListenEl = document.getElementById('autoListen');
  const statusBox = document.getElementById('statusBox');

  function refreshUI() {
    chrome.storage.local.get(['extKey', 'autoListen', 'activeTask', 'lastLog'], (res) => {
      apiBaseEl.value = 'https://ff.uniqbd.com';
      if (res.extKey) extKeyEl.value = res.extKey;
      autoListenEl.checked = Boolean(res.autoListen);
      const text = res.activeTask
        ? `Active: ${shownOrder(res.activeTask)} (UID: ${res.activeTask.player_uid})`
        : (res.lastLog || 'Not connected');
      statusBox.textContent = text;
      statusBox.style.color = /not saved|rejected|cannot reach|failed|error/i.test(text) ? '#fb7185' : '#34d399';
    });
  }

  document.getElementById('saveBtn').addEventListener('click', () => {
    chrome.storage.local.set(
      {
        apiBase: 'https://ff.uniqbd.com',
        extKey: extKeyEl.value.trim(),
        autoListen: autoListenEl.checked,
        lastLog: 'Connecting to ff.uniqbd.com...',
      },
      () => {
        chrome.runtime.sendMessage({ type: 'CHECK_CONNECTION' }, () => refreshUI());
      }
    );
  });

  autoListenEl.addEventListener('change', () => {
    chrome.storage.local.set({ autoListen: autoListenEl.checked }, () => refreshUI());
  });

  document.getElementById('pollBtn').addEventListener('click', () => {
    statusBox.textContent = 'Checking queue...';
    chrome.runtime.sendMessage({ type: 'POLL_NOW' }, () => refreshUI());
  });

  document.getElementById('clearBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'CLEAR_ACTIVE_TASK' }, () => refreshUI());
  });

  refreshUI();
});
