// i18n 翻译引擎
(function() {
  // 注入切换按钮样式
  const style = document.createElement('style');
  style.textContent = `.lang-toggle{background:#1a1a1a;color:#8b949e;border:1px solid #3d3a39;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px;font-family:Inter,sans-serif;white-space:nowrap}.lang-toggle:hover{color:#00d992;border-color:#00d992}`;
  document.head.appendChild(style);

  const LANG_KEY = 'ai_platform_lang';
  let currentLang = localStorage.getItem(LANG_KEY) || 'zh-CN';

  function fallbackLang(lang) {
    return lang === 'zh-CN' ? 'en' : 'zh-CN';
  }

  function t(key, dict) {
    if (!dict) return key;
    if (dict[key] && dict[key][currentLang]) return dict[key][currentLang];
    if (dict[key] && dict[key][fallbackLang(currentLang)]) return dict[key][fallbackLang(currentLang)];
    return key;
  }

  function apply() {
    document.documentElement.lang = currentLang;
    // data-i18n
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      const dict = getDict(el);
      const val = t(key, dict);
      if (val !== key) el.textContent = val;
    });
    // data-i18n-placeholder
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const key = el.getAttribute('data-i18n-placeholder');
      const dict = getDict(el);
      const val = t(key, dict);
      if (val !== key) el.placeholder = val;
    });
    // data-i18n-title
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      const key = el.getAttribute('data-i18n-title');
      const dict = getDict(el);
      const val = t(key, dict);
      if (val !== key) el.title = val;
    });
    // Update toggle button text
    const btns = document.querySelectorAll('.lang-toggle');
    btns.forEach(b => { b.textContent = currentLang === 'zh-CN' ? 'EN' : '中文'; });
    // Update dir
    document.documentElement.dir = 'ltr';
  }

  function getDict(el) {
    // 从元素或其祖先查找 __i18n__ 数据
    let node = el;
    while (node) {
      if (node.__i18n__) return node.__i18n__;
      node = node.parentElement;
    }
    return window.__i18n__ || {};
  }

  function setDict(el, dict) {
    el.__i18n__ = dict;
  }

  function toggle() {
    currentLang = currentLang === 'zh-CN' ? 'en' : 'zh-CN';
    localStorage.setItem(LANG_KEY, currentLang);
    apply();
    if (window.onLangChange) window.onLangChange(currentLang);
  }

  window.i18n = { t, apply, toggle, currentLang, setDict, LANG_KEY };
})();
