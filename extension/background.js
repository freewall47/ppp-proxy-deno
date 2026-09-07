// background.js — MV3 service worker.
//
// Talks to the T-Invest API (invest-public-api.tinkoff.ru) to place a
// marketable-at-top-of-book limit order: buy at the current best bid,
// sell at the current best ask. Quotes come either straight from T-Invest
// MarketDataService (default, zero extra setup) or from MOEX ISS/Algopack
// (requires a MOEX Passport login with an Algopack subscription).
//
// NOTE: field/method names follow the public T-Invest API REST gateway as
// documented at developer.tbank.ru at the time this was written. The API
// does evolve — if a call starts failing, check the current docs for the
// exact request/response shape before assuming the logic here is wrong.

const TINKOFF_BASE = 'https://invest-public-api.tinkoff.ru/rest';
const MOEX_PASSPORT_URL = 'https://passport.moex.com/authenticate';
const moexOrderbookUrl = (secid) =>
  `https://iss.moex.com/iss/engines/stock/markets/shares/securities/${encodeURIComponent(
    secid
  )}/orderbook.json`;

const DEFAULT_SETTINGS = {
  token: '',
  accountId: '',
  dataSource: 'tinkoff', // 'tinkoff' | 'moex'
  moexLogin: '',
  moexPassword: '',
  useProxy: false,
  proxyUrl: ''
};

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

function quotationToNumber(q) {
  if (!q) return 0;
  return q.units + (q.nano || 0) / 1e9;
}

function numberToQuotation(n) {
  const units = Math.trunc(n);
  const nano = Math.round((n - units) * 1e9);
  return { units, nano };
}

// Routes a request through the ppp-proxy-deno CORS proxy when enabled.
// Normally unnecessary: a background service worker with host_permissions
// for a domain already bypasses CORS for it. This exists as a fallback.
async function proxiedFetch(url, options, settings) {
  if (!settings.useProxy || !settings.proxyUrl) {
    return fetch(url, options);
  }
  const target = new URL(url);
  const proxyUrl = new URL(settings.proxyUrl);
  proxyUrl.pathname = target.pathname;
  proxyUrl.search = target.search;

  const headers = new Headers(options.headers || {});
  const passthrough = [];
  for (const key of headers.keys()) {
    if (
      !['accept', 'accept-encoding', 'content-type', 'content-length'].includes(
        key.toLowerCase()
      )
    ) {
      passthrough.push(key);
    }
  }
  headers.set('X-Host', target.hostname);
  headers.set('X-Port', target.port || '443');
  if (passthrough.length) headers.set('X-Allowed-Headers', passthrough.join(','));

  return fetch(proxyUrl.toString(), { ...options, headers });
}

async function tinkoffRpc(service, method, body, settings) {
  if (!settings.token) {
    throw new Error('Не задан токен T-Invest API — откройте настройки расширения');
  }
  const url = `${TINKOFF_BASE}/${service}/${method}`;
  const res = await proxiedFetch(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.token}`
      },
      body: JSON.stringify(body || {})
    },
    settings
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.message || `T-Invest API: ошибка ${res.status}`);
  }
  return data;
}

const instrumentCache = new Map(); // ticker -> { figi, lot }

async function resolveInstrument(ticker, settings) {
  const cached = instrumentCache.get(ticker);
  if (cached) return cached;

  const data = await tinkoffRpc(
    'tinkoff.public.invest.api.contract.v1.InstrumentsService',
    'FindInstrument',
    { query: ticker },
    settings
  );
  const instruments = data.instruments || [];
  const match =
    instruments.find(
      (i) => i.ticker === ticker && i.classCode === 'TQBR' && i.apiTradeAvailableFlag
    ) ||
    instruments.find((i) => i.ticker === ticker && i.apiTradeAvailableFlag) ||
    instruments.find((i) => i.ticker === ticker) ||
    instruments[0];

  if (!match) throw new Error(`Инструмент по тикеру «${ticker}» не найден`);

  const info = { figi: match.figi, lot: match.lot || 1 };
  instrumentCache.set(ticker, info);
  return info;
}

let cachedAccountId = null;
async function getAccountId(settings) {
  if (settings.accountId) return settings.accountId;
  if (cachedAccountId) return cachedAccountId;

  const data = await tinkoffRpc(
    'tinkoff.public.invest.api.contract.v1.UsersService',
    'GetAccounts',
    {},
    settings
  );
  const accounts = data.accounts || [];
  const account =
    accounts.find((a) => a.status === 'ACCOUNT_STATUS_OPEN') || accounts[0];
  if (!account) throw new Error('Не найден открытый брокерский счёт');

  cachedAccountId = account.id;
  return cachedAccountId;
}

// Best bid/ask straight from T-Invest — no MOEX subscription needed.
async function getTopOfBookTinkoff(figi, settings) {
  const data = await tinkoffRpc(
    'tinkoff.public.invest.api.contract.v1.MarketDataService',
    'GetOrderBook',
    { figi, instrumentId: figi, depth: 1 },
    settings
  );
  const bid = data.bids?.[0];
  const ask = data.asks?.[0];
  if (!bid || !ask) throw new Error('Пустой стакан по инструменту');
  return { bidPrice: bid.price, askPrice: ask.price };
}

let moexAuthDone = false;
async function ensureMoexAuth(settings) {
  if (moexAuthDone) return;
  if (!settings.moexLogin) {
    throw new Error('Не заданы логин/пароль MOEX Passport (Алгопак) в настройках');
  }
  const res = await fetch(MOEX_PASSPORT_URL, {
    credentials: 'include',
    headers: {
      Authorization: 'Basic ' + btoa(`${settings.moexLogin}:${settings.moexPassword}`)
    }
  });
  if (!res.ok) {
    throw new Error('Не удалось авторизоваться в MOEX Passport — проверьте подписку на Алгопак');
  }
  moexAuthDone = true;
}

// Best bid/ask from MOEX ISS/Algopack order book.
async function getTopOfBookMoex(ticker, settings) {
  await ensureMoexAuth(settings);
  const res = await fetch(moexOrderbookUrl(ticker), { credentials: 'include' });
  if (!res.ok) throw new Error(`MOEX ISS: ошибка ${res.status}`);
  const json = await res.json();
  const columns = json.orderbook?.columns || [];
  const rows = json.orderbook?.data || [];
  const buySellIdx = columns.indexOf('BUYSELL');
  const priceIdx = columns.indexOf('PRICE');
  const bidRow = rows.find((r) => r[buySellIdx] === 'B');
  const askRow = rows.find((r) => r[buySellIdx] === 'S');
  if (!bidRow || !askRow) {
    throw new Error('Пустой стакан MOEX (проверьте подписку на Алгопак и тикер)');
  }
  return {
    bidPrice: numberToQuotation(bidRow[priceIdx]),
    askPrice: numberToQuotation(askRow[priceIdx])
  };
}

async function placeOrder({ ticker, amount, side }) {
  const t0 = performance.now();
  const settings = await getSettings();
  const tickerU = String(ticker || '').trim().toUpperCase();
  const amountNum = Number(amount);

  if (!tickerU) throw new Error('Не указан тикер');
  if (!(amountNum > 0)) throw new Error('Некорректная сумма');
  if (side !== 'buy' && side !== 'sell') throw new Error('Некорректное направление заявки');

  const instrument = await resolveInstrument(tickerU, settings);
  const top =
    settings.dataSource === 'moex'
      ? await getTopOfBookMoex(tickerU, settings)
      : await getTopOfBookTinkoff(instrument.figi, settings);

  const price = side === 'buy' ? top.bidPrice : top.askPrice;
  const priceNum = quotationToNumber(price);
  const lots = Math.max(1, Math.floor(amountNum / (priceNum * instrument.lot)));

  const accountId = await getAccountId(settings);
  const order = await tinkoffRpc(
    'tinkoff.public.invest.api.contract.v1.OrdersService',
    'PostOrder',
    {
      instrumentId: instrument.figi,
      figi: instrument.figi,
      quantity: String(lots),
      price,
      direction: side === 'buy' ? 'ORDER_DIRECTION_BUY' : 'ORDER_DIRECTION_SELL',
      accountId,
      orderType: 'ORDER_TYPE_LIMIT',
      orderId: crypto.randomUUID()
    },
    settings
  );

  return {
    orderId: order.orderId,
    status: order.executionReportStatus,
    lots,
    price: priceNum,
    ticker: tickerU,
    side,
    latencyMs: Math.round(performance.now() - t0)
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'PPP_PLACE_ORDER') return;
  placeOrder(msg.payload)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true; // keep the message channel open for the async response
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
