/**
 * API Roleta Immersive — Scraper + REST API (Produção v3.1)
 *
 * Captura números da Immersive Roulette (Evolution Gaming) no Superbet
 * via CDP (Chrome DevTools Protocol) para acessar iframes cross-origin.
 *
 * ── AUTENTICAÇÃO VIA SESSION INJECTION + FALLBACK AUTOMÁTICO ────────────────
 * A sessão preferencial é injetada via storageState (auth.json), gerado pelo script:
 *
 *   node login-manual.js   ← roda LOCALMENTE, você faz o login à mão
 *
 * Se a sessão expirar, o bot tenta login automático e salva um novo auth.json.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Features:
 *   - Session Injection via storageState (auth.json)
 *   - Login automático de fallback quando a sessão manual expirar
 *   - Reconexão automática em caso de erro
 *   - Modo headless para produção
 *   - Graceful shutdown
 *
 * Endpoints:
 *   GET /                       → health check
 *   GET /api/resultados         → últimos 100 números
 *   GET /api/resultados?limit=N → últimos N números
 *   GET /api/status             → status do scraper
 *
 * ENV:
 *   PORT            → porta da API (padrão: 3000)
 *   HEADLESS        → "true"/"false" (padrão: true)
 *   POLL_INTERVAL   → intervalo de polling em ms (padrão: 5000)
 *   AUTH_PATH       → caminho do auth.json (padrão: ./auth.json)
 *   AUTO_LOGIN_ATTEMPTS → tentativas por conta no login automático (padrão: 4)
 */

const { chromium } = require("playwright");
const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

// ═══════════════════════════════════════════════════════
// CONFIGURAÇÃO
// ═══════════════════════════════════════════════════════
const PORT = parseInt(process.env.PORT) || 3000;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL) || 5000;
const MAX_ERRORS_BEFORE_RESTART = 60;
// Watchdog: se não houver número NOVO em X ms, recarrega o jogo
// Roleta ~50s/rodada → 5 rodadas sem captura = alarme (padrão: 5 min)
const STALE_TIMEOUT_MS = parseInt(process.env.STALE_TIMEOUT_MS) || 5 * 60 * 1000;
const DB_PATH = path.join(__dirname, "roleta.db");
const AUTH_PATH = process.env.AUTH_PATH || path.join(__dirname, "auth.json");
const GAME_URL = "https://superbet.bet.br/jogo/immersive-roulette/814483?demo=false";
const HOME_URL = "https://superbet.bet.br";
const HEADLESS = process.env.HEADLESS !== "false";
const AUTO_LOGIN_ATTEMPTS = parseInt(process.env.AUTO_LOGIN_ATTEMPTS) || 4;
const AUTO_LOGIN_ACCOUNTS = [
  {
    label: "principal",
    username: process.env.SUPERBET_USER_PRIMARY || process.env.SUPERBET_USER || "gustavozikk111",
    password: process.env.SUPERBET_PASS_PRIMARY || process.env.SUPERBET_PASS || "Tryndx@6",
  },
  {
    label: "fallback",
    username: process.env.SUPERBET_USER_FALLBACK || "analistamamede",
    password: process.env.SUPERBET_PASS_FALLBACK || "@Paula03111992",
  },
  {
    label: "fallback_2",
    username: process.env.SUPERBET_USER_FALLBACK_2 || "agacci1221",
    password: process.env.SUPERBET_PASS_FALLBACK_2 || "Agacci2006.",
  },
].filter((account) => account.username && account.password);

// ═══════════════════════════════════════════════════════
// BANCO DE DADOS
// ═══════════════════════════════════════════════════════
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS resultados (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero INTEGER NOT NULL CHECK(numero >= 0 AND numero <= 36),
    capturado_em TEXT NOT NULL DEFAULT (datetime('now')),
    rodada_detectada_em TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_capturado ON resultados(capturado_em DESC);
`);

const insertStmt = db.prepare(
  "INSERT INTO resultados (numero, rodada_detectada_em) VALUES (?, datetime('now'))"
);
const selectStmt = db.prepare(
  "SELECT id, numero, capturado_em FROM resultados ORDER BY id DESC LIMIT ?"
);
const countStmt = db.prepare("SELECT COUNT(*) as total FROM resultados");
const lastRowStmt = db.prepare(
  "SELECT numero FROM resultados ORDER BY id DESC LIMIT 1"
);

// ═══════════════════════════════════════════════════════
// ESTADO GLOBAL
// ═══════════════════════════════════════════════════════
let scraperStatus = "iniciando";
let lastNumbers = [];
let lastUpdate = null;
let lastNewNumberAt = null;   // timestamp do último número NOVO capturado
let errorCount = 0;
let consecutiveErrors = 0;
let totalCaptured = 0;
let startedAt = new Date().toISOString();
let browser = null;
let restartCount = 0;

function log(msg) {
  const ts = new Date().toISOString().replace("T", " ").substring(0, 19);
  console.log(`[${ts}] ${msg}`);
}

// ═══════════════════════════════════════════════════════
// SCRAPER PRINCIPAL
// ═══════════════════════════════════════════════════════
async function runScraper() {
  log("🚀 Iniciando scraper...");
  log(`   Modo: ${HEADLESS ? "headless" : "visível"}`);
  log(`   Poll: ${POLL_INTERVAL}ms`);

  // ─── Verificar auth.json antes de tudo ───
  const hasAuth = fs.existsSync(AUTH_PATH);
  if (!hasAuth) {
    log("");
    log("╔══════════════════════════════════════════════════════════════════╗");
    log("║  ⛔  auth.json NÃO ENCONTRADO                                   ║");
    log("║                                                                  ║");
    log("║  O bot vai tentar login automático para gerar uma nova sessão.   ║");
    log("║  Se o site pedir desafio/facial, gere manualmente com:           ║");
    log("║    node login-manual.js                                          ║");
    log("║                                                                  ║");
    log("╚══════════════════════════════════════════════════════════════════╝");
    log("");
  }

  // ─── Validar auth.json ───
  let authState = null;
  if (hasAuth) {
    try {
      authState = JSON.parse(fs.readFileSync(AUTH_PATH, "utf8"));
      log(`🔑 auth.json carregado (${authState.cookies?.length ?? 0} cookies, ${Object.keys(authState.origins ?? {}).length} origens)`);
    } catch (e) {
      log(`❌ auth.json corrompido ou inválido: ${e.message}`);
      log("   O bot vai tentar login automático para gerar outro auth.json.");
      scraperStatus = "erro_auth";
    }
  }

  scraperStatus = "abrindo_browser";

  browser = await chromium.launch({
    headless: HEADLESS,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-setuid-sandbox",
    ],
  });

  const contextOptions = {
    viewport: { width: 1920, height: 1080 },
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    geolocation: { latitude: -23.5505, longitude: -46.6333 },
    permissions: ["geolocation"],
  };
  if (authState) {
    contextOptions.storageState = AUTH_PATH; // Injeta a sessão completa (cookies + localStorage)
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  // CDP: acesso a iframes cross-origin
  const cdpSession = await context.newCDPSession(page);
  await cdpSession.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });

  // ─── Helper: fechar popups ───
  async function dismissPopups() {
    for (const sel of [
      "#onetrust-accept-btn-handler",
      'button:has-text("Aceitar todos os cookies")',
      'button:has-text("Aceitar cookies")',
      'button:has-text("Aceitar")',
      'button:has-text("Accept all cookies")',
      'button:has-text("Accept All")',
      'button:has-text("Allow all")',
      '[id*="onetrust-accept"]',
      '[class*="cookie"] button',
      '[class*="consent"] button',
      '[data-testid*="cookie"] button',
    ]) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 800 })) {
          await el.click({ force: true });
          log(`🍪 Popup/cookies fechado via seletor: ${sel}`);
          await page.waitForTimeout(500);
        }
      } catch (e) {}
    }
    for (const text of ["OK", "FECHAR", "Fechar", "Entendi"]) {
      try {
        const btn = page.locator(`button:has-text("${text}")`).first();
        if (await btn.isVisible({ timeout: 500 })) {
          await btn.click({ force: true });
          await page.waitForTimeout(300);
        }
      } catch (e) {}
    }
  }

  // ─── Helper: verificar se ainda está logado ───
  async function isLoggedIn() {
    const loggedInSelectors = [
      'text=/^Depositar$/i',
      'text=/^R\\$\\s*[\\d.,]+$/i',
      '[data-testid*="account"]',
      '[data-testid*="user"]',
      '[data-testid*="balance"]',
      '[class*="balance"]',
    ];

    for (const sel of loggedInSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 1200 })) {
          return true;
        }
      } catch (e) {}
    }

    for (const account of AUTO_LOGIN_ACCOUNTS) {
      try {
        const userBadge = page.locator(`text=${account.username}`).first();
        if (await userBadge.isVisible({ timeout: 800 })) {
          return true;
        }
      } catch (e) {}
    }

    const loggedOutSelectors = [
      'input[type="password"]',
      'input[name="username"]',
      'input[name="login"]',
      'input[name="email"]',
      "button.e2e-login",
    ];

    for (const sel of loggedOutSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 1200 })) {
          return false;
        }
      } catch (e) {}
    }

    const currentUrl = page.url();
    if (currentUrl.includes("immersive-roulette")) {
      const hasEvolutionFrame = page.frames().some((frame) => frame.url().includes("evo-games"));
      if (hasEvolutionFrame) return true;
    }

    return false;
  }

  async function clickFirstVisible(selectors, timeout = 1200) {
    for (const sel of selectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout })) {
          await el.click({ force: true });
          return sel;
        }
      } catch (e) {}
    }
    return null;
  }

  async function fillFirstVisible(selectors, value, timeout = 1200) {
    for (const sel of selectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout })) {
          await el.fill(value);
          return sel;
        }
      } catch (e) {}
    }
    return null;
  }

  async function submitLoginForm() {
    const submitSelectors = [
      'button[type="submit"]:has-text("Entrar")',
      'button:has-text("Entrar")',
      'button:has-text("Login")',
      'button:has-text("Iniciar sessão")',
      'button:has-text("Acessar")',
      '[data-testid*="login"] button[type="submit"]',
    ];
    if (await clickFirstVisible(submitSelectors, 1000)) return;
    await page.keyboard.press("Enter");
  }

  async function tryAutomaticLogin(account, attempt) {
    log(`🔐 Login automático (${account.label}) tentativa ${attempt}/${AUTO_LOGIN_ATTEMPTS} — usuário: ${account.username}`);
    scraperStatus = "login_automatico";

    await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500);
    await dismissPopups();
    await page.waitForTimeout(1000);

    if (await isLoggedIn()) {
      log("✅ Sessão já voltou logada antes de preencher credenciais.");
      await context.storageState({ path: AUTH_PATH });
      return true;
    }

    await clickFirstVisible([
      "button.e2e-login",
      'button:has-text("Entrar")',
      'button:has-text("Login")',
      'a:has-text("Entrar")',
    ], 3000);
    await page.waitForTimeout(1500);
    await dismissPopups();
    await page.waitForTimeout(1000);

    const userSelector = await fillFirstVisible([
      'input[name="username"]',
      'input[name="login"]',
      'input[name="email"]',
      'input[type="email"]',
      'input[autocomplete="username"]',
      'input[placeholder*="usuário" i]',
      'input[placeholder*="usuario" i]',
      'input[placeholder*="e-mail" i]',
      'input[placeholder*="email" i]',
      'input[placeholder*="CPF" i]',
      'input[type="text"]',
    ], account.username, 3000);

    const passSelector = await fillFirstVisible([
      'input[name="password"]',
      'input[type="password"]',
      'input[autocomplete="current-password"]',
      'input[placeholder*="senha" i]',
    ], account.password, 3000);

    if (!userSelector || !passSelector) {
      await dismissPopups();
      await page.waitForTimeout(1000);

      const retryUserSelector = await fillFirstVisible([
        'input[name="username"]',
        'input[name="login"]',
        'input[name="email"]',
        'input[type="email"]',
        'input[autocomplete="username"]',
        'input[placeholder*="usuário" i]',
        'input[placeholder*="usuario" i]',
        'input[placeholder*="e-mail" i]',
        'input[placeholder*="email" i]',
        'input[placeholder*="CPF" i]',
        'input[type="text"]',
      ], account.username, 3000);

      const retryPassSelector = await fillFirstVisible([
        'input[name="password"]',
        'input[type="password"]',
        'input[autocomplete="current-password"]',
        'input[placeholder*="senha" i]',
      ], account.password, 3000);

      if (retryUserSelector && retryPassSelector) {
        log("✅ Campos de login apareceram após fechar popup/cookies.");
        await submitLoginForm();
        await page.waitForTimeout(7000);
        await dismissPopups();

        if (await isLoggedIn()) {
          await context.storageState({ path: AUTH_PATH });
          log("✅ Login automático OK — auth.json salvo com a nova sessão.");
          return true;
        }
      }

      log("⚠️ Não encontrei os campos de usuário/senha no formulário de login.");
      await page.screenshot({ path: path.join(__dirname, `erro-login-form-${account.label}-${attempt}.png`) });
      return false;
    }

    await submitLoginForm();
    await page.waitForTimeout(7000);
    await dismissPopups();

    if (await isLoggedIn()) {
      await context.storageState({ path: AUTH_PATH });
      log("✅ Login automático OK — auth.json salvo com a nova sessão.");
      return true;
    }

    await page.screenshot({ path: path.join(__dirname, `erro-login-${account.label}-${attempt}.png`) });
    log("❌ Login automático não confirmou sessão logada.");
    return false;
  }

  async function performAutomaticLogin() {
    for (const account of AUTO_LOGIN_ACCOUNTS) {
      for (let attempt = 1; attempt <= AUTO_LOGIN_ATTEMPTS; attempt++) {
        try {
          if (await tryAutomaticLogin(account, attempt)) return true;
        } catch (e) {
          log(`❌ Erro no login automático (${account.label}) tentativa ${attempt}: ${e.message}`);
        }
        await page.waitForTimeout(3000);
      }
      log(`⚠️ ${AUTO_LOGIN_ATTEMPTS} tentativas falharam para a conta ${account.label}.`);
    }
    return false;
  }

  async function waitForManualAuth() {
    scraperStatus = "aguardando_auth";
    const oldMtime = fs.existsSync(AUTH_PATH) ? fs.statSync(AUTH_PATH).mtimeMs : 0;
    await new Promise((resolve) => {
      const check = setInterval(() => {
        try {
          const newMtime = fs.existsSync(AUTH_PATH) ? fs.statSync(AUTH_PATH).mtimeMs : 0;
          if (newMtime && newMtime !== oldMtime) {
            log("✅ Novo auth.json detectado! Reiniciando scraper...");
            clearInterval(check);
            resolve();
          } else {
            log("⏳ Aguardando novo auth.json...");
          }
        } catch (e) {
          log("⏳ Aguardando auth.json...");
        }
      }, 30000);
    });
  }

  async function restartWithFreshSession(reason) {
    try { await browser.close(); } catch (e) {}
    browser = null;
    restartCount++;
    startScraper();
    const err = new Error(reason);
    err.restartAlreadyScheduled = true;
    throw err;
  }

  // ─── Helper: sessão expirada — tenta re-login antes de pedir auth manual ───
  async function handleSessionExpired() {
    scraperStatus = "sessao_expirada";
    log("");
    log("╔══════════════════════════════════════════════════════════════════╗");
    log("║  ⚠️  SESSÃO EXPIRADA — auth.json inválido                       ║");
    log("║                                                                  ║");
    log("║  Vou tentar login automático antes de pedir novo auth manual.    ║");
    log("╚══════════════════════════════════════════════════════════════════╝");
    log("");

    if (await performAutomaticLogin()) {
      await restartWithFreshSession("Reiniciando com sessão renovada por login automático");
    }

    log("");
    log("╔══════════════════════════════════════════════════════════════════╗");
    log("║  ⛔  LOGIN AUTOMÁTICO FALHOU                                    ║");
    log("║                                                                  ║");
    log("║  1. Execute LOCALMENTE: node login-manual.js                     ║");
    log("║  2. Transfira o novo auth.json para o servidor                   ║");
    log("║  3. O bot detectará o novo arquivo automaticamente               ║");
    log("╚══════════════════════════════════════════════════════════════════╝");
    log("");
    await waitForManualAuth();
    await restartWithFreshSession("Reiniciando com nova sessão manual");
  }

  // ═══ ETAPA 1: ACESSAR SUPERBET ═══
  scraperStatus = "acessando_superbet";
  log("🌐 Abrindo Superbet (com sessão injetada)...");
  await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4000);
  await dismissPopups();
  await page.waitForTimeout(1000);

  // ═══ ETAPA 2: VERIFICAR SESSÃO (tenta login automático se expirou) ═══
  if (!(await isLoggedIn())) {
    log("❌ Sessão injetada é inválida ou expirou.");
    await page.screenshot({ path: path.join(__dirname, "erro-sessao.png") });
    await handleSessionExpired();
  } else {
    log("✅ Sessão válida — logado com sucesso via auth.json!");
  }

  // ═══ ETAPA 3: NAVEGAR PARA O JOGO ═══
  scraperStatus = "abrindo_jogo";
  log("🎰 Abrindo Immersive Roulette...");
  await page.goto(GAME_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(5000);
  await dismissPopups();
  // Atualiza o auth.json com o estado atual da sessão (renova tokens)
  await context.storageState({ path: AUTH_PATH });
  log("💾 auth.json atualizado com estado da sessão atual");

  // ═══ ETAPA 4: ESPERAR IFRAME EVOLUTION ═══
  scraperStatus = "esperando_iframe";
  log("⏳ Esperando iframe Evolution...");

  let evoFound = false;
  for (let i = 0; i < 30; i++) {
    if (page.frames().find((f) => f.url().includes("evo-games"))) {
      evoFound = true;
      break;
    }
    await page.waitForTimeout(2000);
  }

  if (!evoFound) {
    log("⚠️ Iframe não encontrado — verificando sessão...");
    await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);
    await dismissPopups();

    if (!(await isLoggedIn())) {
      log("❌ Sessão expirou enquanto tentava carregar o jogo.");
      await page.screenshot({ path: path.join(__dirname, "erro-sessao.png") });
      await handleSessionExpired();
    }

    // Sessão ainda válida — tenta carregar o jogo de novo
    await page.goto(GAME_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(5000);
    await dismissPopups();

    for (let i = 0; i < 30; i++) {
      if (page.frames().find((f) => f.url().includes("evo-games"))) {
        evoFound = true;
        break;
      }
      await page.waitForTimeout(2000);
    }

    if (!evoFound) {
      await page.screenshot({ path: path.join(__dirname, "erro-iframe.png") });
      scraperStatus = "erro_iframe";
      throw new Error("Iframe Evolution não encontrado");
    }
  }

  log("✅ Iframe Evolution detectado!");
  await context.storageState({ path: AUTH_PATH });

  log("⏳ Esperando jogo carregar...");
  await page.waitForTimeout(10000);
  await dismissPopups();

  // ═══ ETAPA 5: POLLING ═══
  scraperStatus = "capturando";
  log("🎯 Captura ativa!");

  let previousFirst = null;
  const lastRow = lastRowStmt.get();
  if (lastRow) {
    previousFirst = lastRow.numero;
    log(`   Último número no DB: ${previousFirst}`);
  }

  async function pollResults() {
    try {
      const frames = page.frames();
      let results = [];

      for (const frame of frames) {
        if (!frame.url().includes("evo-games")) continue;
        try {
          const nums = await frame.evaluate(() => {
            const selectors = [
              "[class*='recent']",
              "[class*='value']",
              "[class*='number']",
            ];
            for (const sel of selectors) {
              const els = document.querySelectorAll(sel);
              const found = [];
              els.forEach((el) => {
                const t = el.textContent && el.textContent.trim();
                if (t && /^\d{1,2}$/.test(t)) {
                  const n = parseInt(t);
                  if (n >= 0 && n <= 36) found.push(n);
                }
              });
              if (found.length >= 5) return found;
            }
            return [];
          });
          if (nums.length > 0) { results = nums; break; }
        } catch (e) {}
      }

      if (results.length === 0) {
        consecutiveErrors++;
        const currentUrl = page.url();
        if (!currentUrl.includes("immersive-roulette")) {
          log(`⚠️ Sessão expirada detectada — URL: ${currentUrl}`);
          scraperStatus = "sessao_expirada";
        } else if (consecutiveErrors % 30 === 0) {
          log(`⚠️ ${consecutiveErrors} polls sem dados`);
        }
        return;
      }

      if (consecutiveErrors > 0) {
        log(`✅ Dados retornaram (após ${consecutiveErrors} polls vazios)`);
      }
      consecutiveErrors = 0;

      const currentFirst = results[0];

      if (previousFirst === null) {
        const existing = countStmt.get().total;
        if (existing === 0) {
          db.transaction((nums) => {
            for (let i = nums.length - 1; i >= 0; i--) insertStmt.run(nums[i]);
          })(results);
          totalCaptured = results.length;
          log(`📦 Histórico inicial: ${results.length} números [${results.join(", ")}]`);
        }
      } else if (currentFirst !== previousFirst) {
        insertStmt.run(currentFirst);
        totalCaptured++;
        lastNewNumberAt = Date.now();  // ← atualiza o watchdog
        log(`🏆 NOVO: ${currentFirst} (total: ${totalCaptured})`);
      }

      previousFirst = currentFirst;
      lastNumbers = results;
      lastUpdate = new Date().toISOString();
      scraperStatus = "capturando";
    } catch (e) {
      consecutiveErrors++;
      errorCount++;
    }
  }

  await pollResults();
  if (lastNumbers.length === 0) {
    log("⏳ Aguardando dados da roleta...");
    for (let r = 0; r < 12; r++) {
      await page.waitForTimeout(5000);
      await pollResults();
      if (lastNumbers.length > 0) break;
    }
  }
  // Inicializa o watchdog a partir do momento que os dados chegaram
  lastNewNumberAt = Date.now();

  const pollId = setInterval(async () => {
    await pollResults();

    // ─── WATCHDOG: iframe congelado / dado estático ───────────────────
    // Quando o iframe trava, o bot lê sempre o mesmo número e não gera
    // erros consecutivos — só para de salvar silenciosamente.
    const staleSince = lastNewNumberAt ? Date.now() - lastNewNumberAt : 0;
    if (lastNewNumberAt && staleSince > STALE_TIMEOUT_MS && consecutiveErrors === 0) {
      const staleMin = Math.round(staleSince / 60000);
      log(`⏰ WATCHDOG: ${staleMin}min sem número novo — iframe pode estar congelado. Recarregando jogo...`);
      scraperStatus = "recarregando_jogo";
      try {
        await page.goto(GAME_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(8000);
        await dismissPopups();

        // Verifica se ainda está logado após o reload
        if (!(await isLoggedIn())) {
          log("❌ Sessão expirou durante watchdog reload.");
          await page.screenshot({ path: path.join(__dirname, "erro-sessao.png") });
          clearInterval(pollId);
          clearInterval(authSaveId);
          await handleSessionExpired();
          return;
        }

        // Reseta previousFirst para forçar captura do estado atual
        previousFirst = null;
        lastNewNumberAt = Date.now();
        consecutiveErrors = 0;
        scraperStatus = "capturando";
        log("✅ Watchdog: jogo recarregado com sucesso!");
      } catch (e) {
        log(`❌ Watchdog: erro ao recarregar jogo: ${e.message}`);
      }
      return; // evita checar consecutiveErrors neste ciclo
    }
    // ─────────────────────────────────────────────────────────────────

    if (consecutiveErrors >= 10 && consecutiveErrors < MAX_ERRORS_BEFORE_RESTART) {
      const currentUrl = page.url();
      if (!currentUrl.includes("immersive-roulette")) {
        log("⚠️ Sessão potencialmente expirada — verificando...");
        scraperStatus = "verificando_sessao";
        try {
          await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
          await page.waitForTimeout(3000);
          await dismissPopups();
          if (!(await isLoggedIn())) {
            // Sessão expirou — tenta login automático antes de aguardar novo auth.json
            clearInterval(pollId);
            clearInterval(authSaveId);
            await handleSessionExpired();
          } else {
            // Sessão ainda válida — navega de volta ao jogo
            await page.goto(GAME_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
            await page.waitForTimeout(5000);
            await dismissPopups();
            consecutiveErrors = 0;
            lastNewNumberAt = Date.now();
            scraperStatus = "capturando";
            log("✅ Sessão OK — voltando a capturar");
          }
        } catch (e) {
          log(`❌ Erro ao verificar sessão: ${e.message}`);
        }
      }
    } else if (consecutiveErrors >= MAX_ERRORS_BEFORE_RESTART) {
      log("🔄 Muitos erros consecutivos — reiniciando browser...");
      clearInterval(pollId);
      clearInterval(authSaveId);
      scraperStatus = "reiniciando";
      try { await browser.close(); } catch (e) {}
      browser = null;
      restartCount++;
      setTimeout(() => startScraper(), 5000);
    }
  }, POLL_INTERVAL);

  // Persiste o storageState periodicamente para renovar tokens
  const authSaveId = setInterval(async () => {
    try {
      await context.storageState({ path: AUTH_PATH });
    } catch (e) {
      log(`⚠️ Falha ao salvar auth.json: ${e.message}`);
    }
  }, 60000);

  log("");
  log("╔════════════════════════════════════════════════════════╗");
  log(`║  ✅ CAPTURA ATIVA — http://localhost:${PORT}                ║`);
  log("║  GET /api/resultados         → últimos números         ║");
  log("║  GET /api/resultados?limit=N → N últimos               ║");
  log("║  GET /api/status             → status completo         ║");
  log("╚════════════════════════════════════════════════════════╝");
}

// ═══════════════════════════════════════════════════════
// WRAPPER COM RECONEXÃO
// ═══════════════════════════════════════════════════════
async function startScraper() {
  try {
    await runScraper();
  } catch (err) {
    if (err.restartAlreadyScheduled) {
      log(`🔄 ${err.message}`);
      return;
    }
    log(`❌ Erro: ${err.message}`);
    scraperStatus = "erro_reconectando";
    try { if (browser) await browser.close(); } catch (e) {}
    browser = null;
    restartCount++;
    const delay = Math.min(30000, 5000 * restartCount);
    log(`🔄 Reconectando em ${delay / 1000}s... (tentativa #${restartCount})`);
    setTimeout(() => startScraper(), delay);
  }
}

// ═══════════════════════════════════════════════════════
// API REST
// ═══════════════════════════════════════════════════════
const app = express();

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/", (req, res) => {
  res.json({
    app: "API Roleta Immersive",
    versao: "3.0.0",
    uptime_seconds: Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000),
    endpoints: {
      resultados: "GET /api/resultados",
      resultados_limite: "GET /api/resultados?limit=20",
      status: "GET /api/status",
    },
  });
});

app.get("/api/resultados", (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 1000);
  const rows = selectStmt.all(limit);
  res.json({
    numeros: rows.map((r) => r.numero),
    detalhado: rows.map((r) => ({ numero: r.numero, capturado_em: r.capturado_em })),
    total: rows.length,
    ultimo: rows.length > 0 ? rows[0].numero : null,
    atualizado_em: lastUpdate,
  });
});

app.get("/api/status", (req, res) => {
  const total = countStmt.get().total;
  const authExists = fs.existsSync(AUTH_PATH);
  const staleSinceMs = lastNewNumberAt ? Date.now() - lastNewNumberAt : null;
  res.json({
    status: scraperStatus,
    auth_json_presente: authExists,
    numeros_no_banco: total,
    numeros_capturados_sessao: totalCaptured,
    erros_consecutivos: consecutiveErrors,
    erros_total: errorCount,
    ultimo_update: lastUpdate,
    ultimo_numero_novo_ha: staleSinceMs ? `${Math.round(staleSinceMs / 1000)}s atrás` : null,
    watchdog_dispara_em: staleSinceMs
      ? `${Math.round((STALE_TIMEOUT_MS - staleSinceMs) / 1000)}s`
      : null,
    ultimos_numeros: lastNumbers.slice(0, 13),
    restarts: restartCount,
    uptime_seconds: Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000),
    iniciado_em: startedAt,
  });
});

// ═══════════════════════════════════════════════════════
// INICIAR
// ═══════════════════════════════════════════════════════
app.listen(PORT, "0.0.0.0", () => {
  log(`🌐 API rodando em http://0.0.0.0:${PORT}`);
  startScraper();
});

function gracefulShutdown(signal) {
  log(`\n🛑 ${signal} — encerrando...`);
  scraperStatus = "encerrando";
  if (browser) browser.close().catch(() => {});
  db.close();
  process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("uncaughtException", (err) => {
  log(`❌ Uncaught: ${err.message}`);
});
process.on("unhandledRejection", (reason) => {
  log(`❌ Unhandled: ${reason}`);
});
