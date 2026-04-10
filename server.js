/**
 * API Roleta Immersive — Scraper + REST API (Produção v3)
 *
 * Captura números da Immersive Roulette (Evolution Gaming) no Superbet
 * via CDP (Chrome DevTools Protocol) para acessar iframes cross-origin.
 *
 * Features:
 *   - Login automático com credenciais
 *   - Persistência de sessão via cookies
 *   - Re-login automático quando sessão expira
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
 *   SUPERBET_USER   → usuário Superbet
 *   SUPERBET_PASS   → senha Superbet
 *   POLL_INTERVAL   → intervalo de polling em ms (padrão: 5000)
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
const DB_PATH = path.join(__dirname, "roleta.db");
const COOKIES_PATH = path.join(__dirname, "session-cookies.json");
const GAME_URL = "https://superbet.bet.br/jogo/immersive-roulette/814483?demo=false";
const HOME_URL = "https://superbet.bet.br";
const USERNAME = process.env.SUPERBET_USER || "analistamamede";
const PASSWORD = process.env.SUPERBET_PASS || "@Paula03111992";
const HEADLESS = process.env.HEADLESS !== "false";

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
  log(`   Usuário: ${USERNAME}`);
  log(`   Poll: ${POLL_INTERVAL}ms`);
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

  const hasCookies = fs.existsSync(COOKIES_PATH);
  const contextOptions = {
    viewport: { width: 1920, height: 1080 },
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    geolocation: { latitude: -23.5505, longitude: -46.6333 },
    permissions: ["geolocation"],
  };

  if (hasCookies) {
    try {
      JSON.parse(fs.readFileSync(COOKIES_PATH, "utf8"));
      contextOptions.storageState = COOKIES_PATH;
      log("🔑 Cookies carregados");
    } catch (e) {
      log("⚠️ Cookies corrompidos, ignorando");
      fs.unlinkSync(COOKIES_PATH);
    }
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
    ]) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 800 })) {
          await el.click({ force: true });
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

  // ─── Helper: verificar se está logado ───
  async function isLoggedIn() {
    try {
      const entrarBtn = page.locator("button.e2e-login");
      return !(await entrarBtn.isVisible({ timeout: 3000 }));
    } catch (e) {
      return true;
    }
  }

  // ─── Helper: fazer login ───
  async function doLogin() {
    scraperStatus = "fazendo_login";
    log("🔐 Fazendo login automático...");

    try {
      await page.locator("button.e2e-login").click({ force: true });
      await page.waitForTimeout(2000);
    } catch (e) {
      await page.evaluate(() => {
        for (const btn of document.querySelectorAll("button, a")) {
          if (btn.textContent.trim().toLowerCase() === "entrar" && btn.offsetParent) {
            btn.click();
            return;
          }
        }
      });
      await page.waitForTimeout(3000);
    }

    const usernameInput = page.locator('input[name="username"]');
    const formVisible = await usernameInput
      .isVisible({ timeout: 8000 })
      .catch(() => false);

    if (!formVisible) {
      log("❌ Formulário de login não apareceu");
      await page.screenshot({ path: path.join(__dirname, "erro-login.png") });
      return false;
    }

    await usernameInput.fill(USERNAME);
    await page.locator('input[name="password"]').fill(PASSWORD);
    await page.waitForTimeout(300);

    const submitBtn = page.locator('button[type="submit"].sds-button--block');
    if (await submitBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await submitBtn.click({ force: true });
    } else {
      await page.locator('input[name="password"]').press("Enter");
    }

    log("   Aguardando resposta do login...");
    await page.waitForTimeout(6000);
    await dismissPopups();

    let success = await isLoggedIn();
    if (!success) {
      await dismissPopups();
      await page.waitForTimeout(2000);
      success = await isLoggedIn();
    }

    if (success) {
      log("✅ Login realizado com sucesso!");
      await context.storageState({ path: COOKIES_PATH });
      log("💾 Cookies salvos");
      return true;
    }

    log("❌ Login falhou!");
    await page.screenshot({ path: path.join(__dirname, "erro-login.png") });
    return false;
  }

  // ═══ ETAPA 1: ACESSAR SUPERBET ═══
  scraperStatus = "acessando_superbet";
  log("🌐 Abrindo Superbet...");
  await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4000);
  await dismissPopups();
  await page.waitForTimeout(1000);

  // ═══ ETAPA 2: LOGIN ═══
  if (!(await isLoggedIn())) {
    const loginOk = await doLogin();
    if (!loginOk) {
      if (fs.existsSync(COOKIES_PATH)) {
        fs.unlinkSync(COOKIES_PATH);
        log("🔄 Cookies deletados, recarregando...");
        await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(4000);
        await dismissPopups();
        if (!(await doLogin())) {
          scraperStatus = "erro_login";
          throw new Error("Login falhou após 2 tentativas");
        }
      } else {
        scraperStatus = "erro_login";
        throw new Error("Login falhou");
      }
    }
  } else {
    log("✅ Já está logado (cookies válidos)");
  }

  // ═══ ETAPA 3: NAVEGAR PARA O JOGO ═══
  scraperStatus = "abrindo_jogo";
  log("🎰 Abrindo Immersive Roulette...");
  await page.goto(GAME_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(5000);
  await dismissPopups();
  await context.storageState({ path: COOKIES_PATH });

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
    log("⚠️ Iframe não encontrado, tentando re-login...");
    await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);
    await dismissPopups();

    if (!(await isLoggedIn())) {
      if (fs.existsSync(COOKIES_PATH)) fs.unlinkSync(COOKIES_PATH);
      if (!(await doLogin())) {
        scraperStatus = "erro_login";
        throw new Error("Re-login falhou");
      }
    }

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
  await context.storageState({ path: COOKIES_PATH });

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

  const pollId = setInterval(async () => {
    await pollResults();
    if (consecutiveErrors >= 10 && consecutiveErrors < MAX_ERRORS_BEFORE_RESTART) {
      const currentUrl = page.url();
      if (!currentUrl.includes("immersive-roulette")) {
        log("🔑 Sessão expirada — fazendo re-login sem reiniciar o browser...");
        scraperStatus = "refazendo_login";
        try {
          await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
          await page.waitForTimeout(3000);
          await dismissPopups();
          if (!(await isLoggedIn())) {
            if (fs.existsSync(COOKIES_PATH)) fs.unlinkSync(COOKIES_PATH);
            await doLogin();
          }
          await page.goto(GAME_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
          await page.waitForTimeout(5000);
          await dismissPopups();
          consecutiveErrors = 0;
          scraperStatus = "capturando";
          log("✅ Re-login concluído, voltando a capturar");
        } catch (e) {
          log(`❌ Erro no re-login: ${e.message}`);
        }
      }
    } else if (consecutiveErrors >= MAX_ERRORS_BEFORE_RESTART) {
      log("🔄 Muitos erros consecutivos — reiniciando...");
      clearInterval(pollId);
      clearInterval(cookieSaveId);
      scraperStatus = "reiniciando";
      try { await browser.close(); } catch (e) {}
      browser = null;
      restartCount++;
      setTimeout(() => startScraper(), 5000);
    }
  }, POLL_INTERVAL);

  const cookieSaveId = setInterval(async () => {
    try { await context.storageState({ path: COOKIES_PATH }); } catch (e) {}
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
  res.json({
    status: scraperStatus,
    numeros_no_banco: total,
    numeros_capturados_sessao: totalCaptured,
    erros_consecutivos: consecutiveErrors,
    erros_total: errorCount,
    ultimo_update: lastUpdate,
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
