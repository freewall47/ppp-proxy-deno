// content.js — injects a small floating order panel over tbank.ru/terminal.
// Kept intentionally minimal: ticker, amount, two buttons, one status line.

(function () {
  if (document.getElementById('ppp-quickorder-host')) return;

  const STORAGE_KEY_LAST = 'ppp_quickorder_last';

  const host = document.createElement('div');
  host.id = 'ppp-quickorder-host';
  Object.assign(host.style, {
    position: 'fixed',
    top: '96px',
    right: '16px',
    zIndex: 2147483647
  });
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .panel {
        width: 208px;
        background: #1c1c1e;
        color: #e8e8ea;
        border-radius: 10px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
        font-size: 12px;
        overflow: hidden;
        border: 1px solid rgba(255, 255, 255, 0.08);
      }
      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 6px 10px;
        cursor: move;
        background: rgba(255, 255, 255, 0.04);
        user-select: none;
      }
      .header span { opacity: 0.7; letter-spacing: 0.02em; }
      .header button {
        background: none;
        border: none;
        color: inherit;
        opacity: 0.6;
        cursor: pointer;
        font-size: 13px;
        line-height: 1;
        padding: 2px 4px;
      }
      .header button:hover { opacity: 1; }
      .body { padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 6px; }
      .body.collapsed { display: none; }
      input {
        width: 100%;
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 6px;
        color: inherit;
        padding: 6px 8px;
        font-size: 12px;
        outline: none;
      }
      input:focus { border-color: rgba(255, 255, 255, 0.3); }
      .row { display: flex; gap: 6px; }
      button.trade {
        flex: 1;
        border: none;
        border-radius: 6px;
        padding: 7px 0;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        color: #fff;
      }
      button.trade:disabled { opacity: 0.5; cursor: default; }
      .buy { background: #1faa59; }
      .buy:hover:not(:disabled) { background: #189249; }
      .sell { background: #d5473a; }
      .sell:hover:not(:disabled) { background: #bd3c30; }
      .status {
        min-height: 14px;
        opacity: 0.75;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .status.error { color: #ff7a70; opacity: 1; }
      .status.ok { color: #6fd393; opacity: 1; }
    </style>
    <div class="panel">
      <div class="header" id="drag-handle">
        <span>Заявка</span>
        <button id="toggle" title="Свернуть/развернуть">–</button>
      </div>
      <div class="body" id="body">
        <input id="ticker" placeholder="Тикер, напр. SBER" autocomplete="off" spellcheck="false" />
        <input id="amount" type="number" placeholder="Сумма, ₽" min="0" step="100" />
        <div class="row">
          <button class="trade buy" id="buy">Купить</button>
          <button class="trade sell" id="sell">Продать</button>
        </div>
        <div class="status" id="status"></div>
      </div>
    </div>
  `;

  const $ = (id) => shadow.getElementById(id);
  const tickerEl = $('ticker');
  const amountEl = $('amount');
  const statusEl = $('status');
  const bodyEl = $('body');
  const buyBtn = $('buy');
  const sellBtn = $('sell');

  chrome.storage.local.get(STORAGE_KEY_LAST).then((r) => {
    const last = r[STORAGE_KEY_LAST];
    if (last) {
      tickerEl.value = last.ticker || '';
      amountEl.value = last.amount || '';
    }
  });

  $('toggle').addEventListener('click', () => {
    bodyEl.classList.toggle('collapsed');
  });

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }

  async function trade(side) {
    const ticker = tickerEl.value.trim().toUpperCase();
    const amount = Number(amountEl.value);

    if (!ticker) return setStatus('Укажите тикер', 'error');
    if (!(amount > 0)) return setStatus('Укажите сумму', 'error');

    buyBtn.disabled = true;
    sellBtn.disabled = true;
    setStatus(side === 'buy' ? 'Покупаю…' : 'Продаю…');

    chrome.storage.local.set({ [STORAGE_KEY_LAST]: { ticker, amount } });

    chrome.runtime.sendMessage(
      { type: 'PPP_PLACE_ORDER', payload: { ticker, amount, side } },
      (res) => {
        buyBtn.disabled = false;
        sellBtn.disabled = false;
        if (chrome.runtime.lastError) {
          return setStatus(chrome.runtime.lastError.message, 'error');
        }
        if (!res?.ok) {
          return setStatus(res?.error || 'Ошибка', 'error');
        }
        const r = res.result;
        setStatus(
          `${r.lots} лот × ${r.price} — ${r.latencyMs} мс`,
          'ok'
        );
      }
    );
  }

  buyBtn.addEventListener('click', () => trade('buy'));
  sellBtn.addEventListener('click', () => trade('sell'));

  // Simple drag-to-move by the header.
  const handle = $('drag-handle');
  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;

  handle.addEventListener('mousedown', (e) => {
    dragging = true;
    const rect = host.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    host.style.left = `${e.clientX - offsetX}px`;
    host.style.top = `${e.clientY - offsetY}px`;
    host.style.right = 'auto';
  });
  window.addEventListener('mouseup', () => {
    dragging = false;
  });
})();
