/**
 * login-manual.js — Gerador de Sessão para o Superbet
 * ─────────────────────────────────────────────────────────────────────────────
 * EXECUTE ESTE SCRIPT LOCALMENTE (não no servidor GCP).
 *
 * COMO USAR:
 *   1. node login-manual.js
 *   2. O browser abrirá em modo VISÍVEL (headful)
 *   3. Faça o login normalmente no Superbet:
 *        - Digite usuário e senha
 *        - Complete o reconhecimento facial
 *        - Resolva qualquer captcha/desafio
 *   4. Após estar logado, pressione ENTER no terminal
 *   5. O script salva a sessão em auth.json e fecha o browser
 *   6. Transfira o auth.json para o servidor:
 *        scp auth.json usuario@IP_DO_SERVIDOR:/caminho/api-imm/
 *
 * O auth.json contém cookies + localStorage completos (storageState do Playwright).
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

const { chromium } = require("playwright");
const path = require("path");
const readline = require("readline");

const AUTH_PATH = path.join(__dirname, "auth.json");
const HOME_URL = "https://superbet.bet.br";

// ─── Logger simples ───
function log(msg) {
  const ts = new Date().toISOString().replace("T", " ").substring(0, 19);
  console.log(`[${ts}] ${msg}`);
}

// ─── Aguardar ENTER no terminal ───
function waitForEnter(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

async function main() {
  log("");
  log("┌──────────────────────────────────────────────────────────┐");
  log("│  🔐  LOGIN MANUAL — Gerador de Sessão Superbet           │");
  log("│                                                          │");
  log("│  1. Faça login NO BROWSER que vai abrir                  │");
  log("│  2. Complete o reconhecimento facial e captchas          │");
  log("│  3. Quando estiver logado, volte aqui e pressione ENTER  │");
  log("└──────────────────────────────────────────────────────────┘");
  log("");

  // ─── Lançar browser HEADFUL (visível) ───
  const browser = await chromium.launch({
    headless: false,        // OBRIGATÓRIO: visível para interação manual
    slowMo: 50,             // leve delay para o site não detectar automação
    args: [
      "--disable-blink-features=AutomationControlled",
      "--start-maximized",
      // NÃO inclui --no-sandbox aqui pois está rodando localmente
    ],
  });

  const context = await browser.newContext({
    viewport: null,         // usa o tamanho real da janela maximizada
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    geolocation: { latitude: -23.5505, longitude: -46.6333 },
    permissions: ["geolocation"],
    locale: "pt-BR",
    timezoneId: "America/Sao_Paulo",
  });

  const page = await context.newPage();

  // ─── Navegar para o Superbet ───
  log("🌐 Abrindo Superbet...");
  try {
    await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  } catch (e) {
    log(`⚠️ Timeout ao carregar (normal): ${e.message}`);
  }

  log("");
  log("══════════════════════════════════════════════════════════════");
  log("  👤  FAÇA O LOGIN NO BROWSER AGORA:");
  log("  → Complete usuário, senha, reconhecimento facial e captchas");
  log("══════════════════════════════════════════════════════════════");
  log("");

  // ─── Aguarda o usuário completar o login manualmente ───
  await waitForEnter("  Pressione ENTER após estar completamente logado no Superbet... ");

  log("");
  log("🔍 Verificando estado da sessão...");

  // ─── Verificar se de fato está logado (opcional — para feedback) ───
  try {
    const currentUrl = page.url();
    log(`   URL atual: ${currentUrl}`);

    const loginBtnVisible = await page
      .locator("button.e2e-login")
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    if (loginBtnVisible) {
      log("");
      log("⚠️  ATENÇÃO: O botão de login ainda está visível.");
      log("   Talvez você não esteja logado.");
      log("");

      const proceed = await waitForEnter(
        "  Pressione ENTER para salvar mesmo assim, ou Ctrl+C para cancelar... "
      );
    } else {
      log("✅ Sessão parece válida (botão de login não detectado).");
    }
  } catch (e) {
    log(`⚠️ Não foi possível verificar o estado: ${e.message}`);
  }

  // ─── Salvar o storageState completo (cookies + localStorage) ───
  log("");
  log("💾 Salvando sessão completa em auth.json...");

  try {
    await context.storageState({ path: AUTH_PATH });
    log(`✅ auth.json salvo com sucesso em: ${AUTH_PATH}`);
  } catch (e) {
    log(`❌ Falha ao salvar auth.json: ${e.message}`);
    await browser.close();
    process.exit(1);
  }

  await browser.close();

  // ─── Instruções pós-captura ───
  log("");
  log("┌──────────────────────────────────────────────────────────────────┐");
  log("│  ✅  SESSÃO CAPTURADA COM SUCESSO!                               │");
  log("│                                                                  │");
  log("│  Agora transfira o auth.json para o servidor GCP:               │");
  log("│                                                                  │");
  log("│    scp auth.json SEU_USER@IP_GCP:/home/SEU_USER/api-imm/        │");
  log("│                                                                  │");
  log("│  Depois reinicie o bot no servidor:                              │");
  log("│                                                                  │");
  log("│    pm2 restart api-imm   (ou: node server.js)                   │");
  log("│                                                                  │");
  log("│  O bot detectará o auth.json automaticamente.                   │");
  log("└──────────────────────────────────────────────────────────────────┘");
  log("");
  process.exit(0);
}

main().catch((err) => {
  log(`\n❌ Erro fatal: ${err.message}`);
  console.error(err);
  process.exit(1);
});
