# API Roleta Immersive

API que captura em tempo real os números da **Immersive Roulette** (Evolution Gaming) no Superbet e expõe via REST.

## Requisitos

- Node.js 18+
- Chromium (instalado automaticamente pelo Playwright)

## Instalação

```bash
npm install
npx playwright install chromium
```

## Configuração

Copie o `.env.example`:

```bash
cp .env.example .env
```

Edite o `.env` com suas credenciais.

## Execução

### Produção (headless)
```bash
npm start
# ou
node server.js
```

### Desenvolvimento (com browser visível)
```bash
npm run dev
# ou
HEADLESS=false node server.js
```

## Endpoints

### `GET /`
Health check e informações da API.

```json
{
  "app": "API Roleta Immersive",
  "versao": "3.0.0",
  "uptime_seconds": 120
}
```

### `GET /api/resultados`
Retorna os últimos números capturados.

**Query params:**
- `limit` (opcional): quantidade de resultados (1-1000, padrão: 100)

```json
{
  "numeros": [13, 16, 1, 2, 28],
  "detalhado": [
    { "numero": 13, "capturado_em": "2026-04-10 01:36:03" },
    { "numero": 16, "capturado_em": "2026-04-10 01:35:28" }
  ],
  "total": 5,
  "ultimo": 13,
  "atualizado_em": "2026-04-10T01:36:13.818Z"
}
```

### `GET /api/status`
Status detalhado do scraper.

```json
{
  "status": "capturando",
  "numeros_no_banco": 23,
  "numeros_capturados_sessao": 23,
  "erros_consecutivos": 0,
  "erros_total": 0,
  "ultimo_update": "2026-04-10T01:36:13.818Z",
  "ultimos_numeros": [13, 16, 1, 2, 28, 28, 27, 29, 12, 15, 34, 8, 32],
  "restarts": 0,
  "uptime_seconds": 77,
  "iniciado_em": "2026-04-10T01:34:57.760Z"
}
```

## Status possíveis

| Status | Descrição |
|--------|-----------|
| `iniciando` | API iniciando |
| `abrindo_browser` | Abrindo Chrome |
| `acessando_superbet` | Carregando site |
| `fazendo_login` | Login automático |
| `abrindo_jogo` | Navegando para o jogo |
| `esperando_iframe` | Esperando Evolution carregar |
| `capturando` | ✅ Capturando números |
| `reiniciando` | Reconectando após erro |
| `erro_login` | Falha no login |
| `erro_iframe` | Iframe não encontrado |
| `erro_reconectando` | Reconexão automática |

## Como funciona

1. Abre o Superbet via Playwright (Chrome headless)
2. Faz login automático com as credenciais
3. Navega para a Immersive Roulette
4. Usa CDP (Chrome DevTools Protocol) para acessar o iframe cross-origin da Evolution Gaming
5. Faz polling do DOM a cada 5 segundos para detectar novos números
6. Salva no SQLite e expõe via API REST
7. Se houver falha, reconecta automaticamente

## Persistência

- **Cookies**: salvos em `session-cookies.json` — login não precisa ser refeito a cada reinício
- **Banco**: SQLite em `roleta.db` — números persistem entre reinícios
- **Reconexão**: se o scraper perder conexão, reconecta automaticamente com backoff exponencial
