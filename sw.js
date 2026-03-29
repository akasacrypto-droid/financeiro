const CACHE = 'controle-v1';
const ASSETS = ['./', './index.html', './icon.svg'];

const CRYPTO_CODES = ['BTC','ETH','BNB','SOL','XRP','ADA','DOGE','DOT'];
const CRYPTO_IDS = {
  BTC:'bitcoin', ETH:'ethereum', BNB:'binancecoin', SOL:'solana',
  XRP:'ripple', ADA:'cardano', DOGE:'dogecoin', DOT:'polkadot'
};

// Instala e cacheia assets principais
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

// Ativa e limpa caches antigos
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch — network first, cache fallback
self.addEventListener('fetch', e => {
  if(e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if(url.origin !== location.origin) return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        if(res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

// ── ALERTAS DE COTAÇÃO EM BACKGROUND ──
let _alerts = [];

self.addEventListener('message', e => {
  if(e.data?.type === 'UPDATE_ALERTS') {
    _alerts = e.data.alerts || [];
  }
  // BUG FIX: handle START_ALERT_CHECK (was silently ignored before)
  if(e.data?.type === 'PING' || e.data?.type === 'START_ALERT_CHECK') {
    checkAlerts();
  }
});

self.addEventListener('periodicsync', e => {
  if(e.tag === 'price-alerts') e.waitUntil(checkAlerts());
});

async function fetchFiatRates(moedas) {
  if(!moedas.length) return {};
  const pairs = moedas.map(m => `${m}-BRL`).join(',');
  const res = await fetch(`https://economia.awesomeapi.com.br/json/last/${pairs}`);
  const data = await res.json();
  const rates = {};
  moedas.forEach(m => {
    const key = `${m}BRL`;
    if(data[key]) rates[m] = parseFloat(data[key].bid);
  });
  return rates;
}

async function fetchCryptoRates(codes) {
  if(!codes.length) return {};
  const ids = codes.map(c => CRYPTO_IDS[c]).filter(Boolean).join(',');
  if(!ids) return {};
  const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=brl`);
  const data = await res.json();
  const rates = {};
  codes.forEach(c => {
    const id = CRYPTO_IDS[c];
    if(id && data[id]?.brl) rates[c] = data[id].brl;
  });
  return rates;
}

async function checkAlerts() {
  if(!_alerts.length) return;
  const active = _alerts.filter(a => a.active !== false && !a.triggered);
  if(!active.length) return;

  try {
    const fiatCodes  = [...new Set(active.map(a => a.moeda).filter(m => !CRYPTO_CODES.includes(m)))];
    const cryptoCodes = [...new Set(active.map(a => a.moeda).filter(m => CRYPTO_CODES.includes(m)))];

    // BUG FIX: now fetches both fiat AND crypto rates
    const [fiatRates, cryptoRates] = await Promise.all([
      fiatCodes.length  ? fetchFiatRates(fiatCodes)   : Promise.resolve({}),
      cryptoCodes.length ? fetchCryptoRates(cryptoCodes) : Promise.resolve({})
    ]);
    const allRates = { ...fiatRates, ...cryptoRates };

    const triggered = [];
    const updated = _alerts.map(a => {
      const rate = allRates[a.moeda];
      if(!rate) return a;
      const hit = a.cond === 'acima' ? rate >= a.valor : rate <= a.valor;
      if(hit && a.active !== false && !a.triggered) {
        triggered.push({ ...a, rateNow: rate });
        return { ...a, triggered: true };
      }
      return a;
    });

    if(triggered.length) {
      _alerts = updated;
      const clients = await self.clients.matchAll();
      clients.forEach(c => c.postMessage({ type: 'ALERTS_TRIGGERED', triggered, allAlerts: updated }));
      triggered.forEach(a => {
        const ico = a.cond === 'acima' ? '▲' : '▼';
        self.registration.showNotification(`🔔 Alerta ${a.moeda} ${ico} R$ ${a.valor.toFixed(2)}`, {
          body: `Cotação atual: R$ ${Number(a.rateNow).toLocaleString('pt-BR',{minimumFractionDigits:4,maximumFractionDigits:4})}`,
          icon: './icon.svg',
          badge: './icon.svg',
          tag: `alert-${a.moeda}`,
          renotify: true,
        });
      });
    }
  } catch(e) {}
}
