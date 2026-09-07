const DEFAULT_SETTINGS = {
  token: '',
  accountId: '',
  dataSource: 'tinkoff',
  moexLogin: '',
  moexPassword: '',
  useProxy: false,
  proxyUrl: ''
};

const fields = {
  token: document.getElementById('token'),
  accountId: document.getElementById('accountId'),
  dataSource: document.getElementById('dataSource'),
  moexLogin: document.getElementById('moexLogin'),
  moexPassword: document.getElementById('moexPassword'),
  useProxy: document.getElementById('useProxy'),
  proxyUrl: document.getElementById('proxyUrl')
};
const moexFields = document.getElementById('moexFields');
const statusEl = document.getElementById('status');

function updateMoexVisibility() {
  moexFields.style.display = fields.dataSource.value === 'moex' ? 'block' : 'none';
}
fields.dataSource.addEventListener('change', updateMoexVisibility);

async function load() {
  const settings = { ...DEFAULT_SETTINGS, ...(await chrome.storage.sync.get(DEFAULT_SETTINGS)) };
  fields.token.value = settings.token;
  fields.accountId.value = settings.accountId;
  fields.dataSource.value = settings.dataSource;
  fields.moexLogin.value = settings.moexLogin;
  fields.moexPassword.value = settings.moexPassword;
  fields.useProxy.checked = settings.useProxy;
  fields.proxyUrl.value = settings.proxyUrl;
  updateMoexVisibility();
}

async function save() {
  const settings = {
    token: fields.token.value.trim(),
    accountId: fields.accountId.value.trim(),
    dataSource: fields.dataSource.value,
    moexLogin: fields.moexLogin.value.trim(),
    moexPassword: fields.moexPassword.value,
    useProxy: fields.useProxy.checked,
    proxyUrl: fields.proxyUrl.value.trim()
  };

  if (settings.useProxy && settings.proxyUrl) {
    try {
      const origin = new URL(settings.proxyUrl).origin + '/*';
      await chrome.permissions.request({ origins: [origin] });
    } catch (e) {
      // Invalid URL or user declined — still save the rest of the settings.
    }
  }

  await chrome.storage.sync.set(settings);
  statusEl.textContent = 'Сохранено';
  setTimeout(() => (statusEl.textContent = ''), 1500);
}

document.getElementById('save').addEventListener('click', save);
load();
