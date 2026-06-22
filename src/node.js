const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const os = require('os');
const Inventory = require('./inventory');
const Protocol = require('./protocol');

// MIME types para servir arquivos estáticos
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

class P2PNode {
  constructor(config) {
    this.peerId = config.peer_id;
    this.port = config.port;
    this.stickerId = config.sticker_id;
    this.stickerUrl = config.sticker_url;
    this.neighborsConfig = config.neighbors || [];

    // Detectar IP local para origin_peer_ip
    this.localIp = this._getLocalIp();

    this.inventory = new Inventory(this.stickerId);
    this.seenQueries = new Set();       // Prevenção de duplicatas de SEARCH
    this.seenMessages = new Set();      // Prevenção de duplicatas globais (message_id)
    this.pendingTrades = new Map();     // Trocas que EU enviei (trade_id -> trade info)
    this.incomingOffers = new Map();    // Trocas que EU RECEBI aguardando aceite manual (offer_id -> info)
    this.connections = new Map();       // peer_id -> WebSocket
    this.tradeHistory = [];             // Histórico de trocas
    this.searchHistory = [];            // Histórico de buscas

    // Mapeia query_id -> peer_id de quem nos enviou o SEARCH
    this.queryRoutes = new Map();

    // Quais query_ids nós mesmos originamos
    this.myQueries = new Set();

    // SSE: clientes conectados para push em tempo real
    this.sseClients = [];

    // Callbacks para a CLI
    this.onSearchResult = null;
  }

  // ── Detectar IP local ───────────────────────────────────────

  _getLocalIp() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
    return '127.0.0.1';
  }

  // ── Inicialização ──────────────────────────────────────────

  start() {
    // Criar servidor HTTP para servir a interface web + API
    this.httpServer = http.createServer((req, res) => this._handleHttp(req, res));

    // Anexar WebSocket ao mesmo servidor HTTP (porta 8080)
    this.server = new WebSocket.Server({ server: this.httpServer });
    this.server.on('connection', (ws) => this._handleConnection(ws));

    this.httpServer.listen(this.port, () => {
      console.log(`[${this.peerId}] Ouvindo na porta ${this.port} (HTTP + WebSocket)`);
      console.log(`[${this.peerId}] Interface web: http://localhost:${this.port}`);
    });

    // Conectar aos vizinhos configurados
    setTimeout(() => this._connectToNeighbors(), 1000);
  }

  _connectToNeighbors() {
    for (const n of this.neighborsConfig) {
      this._connectTo(n.host, n.port);
    }
  }

  _connectTo(host, port) {
    const url = `ws://${host}:${port}`;
    console.log(`[${this.peerId}] Conectando a ${url}...`);
    const ws = new WebSocket(url);

    ws.on('open', () => {
      console.log(`[${this.peerId}] Conectado a ${url}`);
      const knownPeers = [...this.connections.keys()];
      this._send(ws, Protocol.hello(this.peerId, knownPeers));
      this._pushEvent('peer_update', {});
    });

    ws.on('message', (data) => this._handleMessage(ws, data));
    ws.on('error', (e) => console.log(`[${this.peerId}] Erro ao conectar ${url}: ${e.message}`));
    ws.on('close', () => {
      console.log(`[${this.peerId}] Desconectado de ${url}`);
      for (const [peerId, peerWs] of this.connections) {
        if (peerWs === ws) {
          this.connections.delete(peerId);
          this._pushEvent('peer_update', {});
          this._pushEvent('log', { message: `Peer ${peerId} desconectou`, level: 'warning' });
          break;
        }
      }
    });
  }

  // ══════════════════════════════════════════════════════════
  //  HTTP SERVER — Interface Web + API + SSE
  // ══════════════════════════════════════════════════════════

  _handleHttp(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // ── API routes ──
    if (pathname.startsWith('/api/')) {
      return this._handleApi(req, res, pathname);
    }

    // ── Servir figurinhas (PNG) ──
    if (pathname.startsWith('/figurinhas/')) {
      const filePath = path.join(process.cwd(), pathname);
      return this._serveFile(res, filePath);
    }

    // ── Servir arquivos estáticos de public/ ──
    let filePath;
    if (pathname === '/' || pathname === '/index.html') {
      filePath = path.join(process.cwd(), 'public', 'index.html');
    } else {
      filePath = path.join(process.cwd(), 'public', pathname);
    }
    this._serveFile(res, filePath);
  }

  _serveFile(res, filePath) {
    // Prevenir path traversal
    const resolvedPath = path.resolve(filePath);
    const cwd = path.resolve(process.cwd());
    if (!resolvedPath.startsWith(cwd)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.readFile(resolvedPath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }
      const ext = path.extname(resolvedPath).toLowerCase();
      const contentType = MIME[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    });
  }

  async _handleApi(req, res, pathname) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    // ── GET endpoints ──
    if (req.method === 'GET') {
      switch (pathname) {
        case '/api/status':
          return this._jsonRes(res, {
            peer_id: this.peerId,
            sticker_id: this.stickerId,
            sticker_url: this.stickerUrl,
            local_ip: this.localIp,
            port: this.port
          });

        case '/api/inventory':
          return this._jsonRes(res, this.inventory.getAll());

        case '/api/peers':
          return this._jsonRes(res, [...this.connections.keys()]);

        case '/api/offers':
          return this._jsonRes(res, this._getOffersArray());

        case '/api/history':
          return this._jsonRes(res, this.tradeHistory);

        case '/api/events':
          return this._handleSSE(req, res);

        default:
          res.writeHead(404);
          return res.end(JSON.stringify({ error: 'Not found' }));
      }
    }

    // ── POST endpoints ──
    if (req.method === 'POST') {
      const body = await this._parseBody(req);

      switch (pathname) {
        case '/api/search': {
          if (!body.sticker_id) return this._jsonRes(res, { error: 'sticker_id obrigatório' }, 400);
          const queryId = this.search(body.sticker_id);
          return this._jsonRes(res, { query_id: queryId, sticker_id: body.sticker_id });
        }

        case '/api/connect': {
          if (!body.host) return this._jsonRes(res, { error: 'host obrigatório' }, 400);
          this._connectTo(body.host, body.port || 8080);
          return this._jsonRes(res, { ok: true });
        }

        case '/api/trade': {
          const { target_peer_id, offer_sticker_id, want_sticker_id } = body;
          if (!target_peer_id || !offer_sticker_id || !want_sticker_id) {
            return this._jsonRes(res, { error: 'Campos obrigatórios: target_peer_id, offer_sticker_id, want_sticker_id' }, 400);
          }
          const result = this.offerTrade(target_peer_id, offer_sticker_id, want_sticker_id);
          return this._jsonRes(res, result);
        }

        case '/api/trade/accept': {
          if (!body.offer_id) return this._jsonRes(res, { error: 'offer_id obrigatório' }, 400);
          const result = this.acceptIncomingOffer(body.offer_id);
          return this._jsonRes(res, result);
        }

        case '/api/trade/reject': {
          if (!body.offer_id) return this._jsonRes(res, { error: 'offer_id obrigatório' }, 400);
          const result = this.rejectIncomingOffer(body.offer_id);
          return this._jsonRes(res, result);
        }

        default:
          res.writeHead(404);
          return res.end(JSON.stringify({ error: 'Not found' }));
      }
    }

    res.writeHead(405);
    res.end(JSON.stringify({ error: 'Method not allowed' }));
  }

  _jsonRes(res, data, statusCode = 200) {
    res.writeHead(statusCode);
    res.end(JSON.stringify(data));
  }

  _parseBody(req) {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve({}); }
      });
    });
  }

  // ── SSE (Server-Sent Events) ──

  _handleSSE(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(':ok\n\n');

    this.sseClients.push(res);
    req.on('close', () => {
      this.sseClients = this.sseClients.filter(c => c !== res);
    });

    // Keep-alive a cada 30 segundos
    const keepAlive = setInterval(() => {
      if (res.writableEnded) { clearInterval(keepAlive); return; }
      res.write(':ping\n\n');
    }, 30000);

    req.on('close', () => clearInterval(keepAlive));
  }

  _pushEvent(type, data) {
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.sseClients) {
      if (!client.writableEnded) {
        client.write(payload);
      }
    }
  }

  _getOffersArray() {
    const arr = [];
    for (const [id, offer] of this.incomingOffers) {
      arr.push({
        id,
        from: offer.from,
        offer_sticker_id: offer.offer_sticker_id,
        want_sticker_id: offer.want_sticker_id,
        timestamp: offer.timestamp
      });
    }
    return arr;
  }

  // ══════════════════════════════════════════════════════════
  //  P2P — Recebimento de mensagens WebSocket
  // ══════════════════════════════════════════════════════════

  _handleConnection(ws) {
    console.log(`[${this.peerId}] Nova conexão recebida`);
    ws.on('message', (data) => this._handleMessage(ws, data));
    ws.on('close', () => {
      for (const [peerId, peerWs] of this.connections) {
        if (peerWs === ws) {
          console.log(`[${this.peerId}] Peer ${peerId} desconectou`);
          this.connections.delete(peerId);
          this._pushEvent('peer_update', {});
          this._pushEvent('log', { message: `Peer ${peerId} desconectou`, level: 'warning' });
          break;
        }
      }
    });
  }

  _handleMessage(ws, data) {
    let msg;
    try { msg = JSON.parse(data); }
    catch { return; }

    const senderId = msg.sender_peer_id || 'desconhecido';

    // ── Anti-flood: ignorar mensagens de nós mesmos (echo loop) ──
    if (msg.sender_peer_id === this.peerId || msg.origin_peer_id === this.peerId) {
      // Exceção: SEARCH_HIT/TRADE_ACCEPT/TRADE_REJECT onde origin é quem tem a figurinha
      // e receiver somos nós — esses são legítimos
      const isResponseToUs = (msg.receiver_peer_id === this.peerId);
      if (!isResponseToUs) {
        return; // Descarta silenciosamente
      }
    }

    // ── Anti-flood: deduplicar por message_id ──
    if (msg.message_id) {
      if (this.seenMessages.has(msg.message_id)) {
        return; // Mensagem duplicada, descarta
      }
      this.seenMessages.add(msg.message_id);
      // Limitar o tamanho do set para evitar memory leak
      if (this.seenMessages.size > 10000) {
        const iter = this.seenMessages.values();
        for (let i = 0; i < 5000; i++) iter.next();
        // Rebuild with only the newest half
        const newSet = new Set();
        for (const v of iter) newSet.add(v);
        this.seenMessages = newSet;
      }
    }

    console.log(`[${this.peerId}] Recebido: ${msg.type} de ${senderId}`);
    this._pushEvent('log', { message: `Recebido: ${msg.type} de ${senderId}`, level: 'info' });

    // Registra de onde veio essa conexão (nunca registrar a nós mesmos)
    // E deixa que a mensagem HELLO trate o seu próprio registro para sabermos se é uma nova conexão e responder adequadamente
    if (msg.sender_peer_id && msg.sender_peer_id !== this.peerId && msg.type !== 'HELLO') {
      const isNew = !this.connections.has(msg.sender_peer_id);
      this.connections.set(msg.sender_peer_id, ws);
      if (isNew) this._pushEvent('peer_update', {});
    }

    switch (msg.type) {
      case 'HELLO':            this._onHello(ws, msg); break;
      case 'SEARCH':           this._onSearch(ws, msg); break;
      case 'SEARCH_HIT':       this._onSearchHit(ws, msg); break;
      case 'SEARCH_MISS':      break; // Ignorar silenciosamente (opcional, não requer ação)
      case 'TRADE_OFFER':      this._onTradeOffer(ws, msg); break;
      case 'TRADE_ACCEPT':     this._onTradeAccept(ws, msg); break;
      case 'TRADE_REJECT':     this._onTradeReject(msg); break;
      case 'TRANSFER_CONFIRM': this._onTransferConfirm(msg); break;
    }
  }

  // ── Handlers por tipo ──────────────────────────────────────

  _onHello(ws, msg) {
    const alreadyKnown = this.connections.has(msg.sender_peer_id);
    console.log(`[${this.peerId}] HELLO de ${msg.sender_peer_id}`);
    this.connections.set(msg.sender_peer_id, ws);
    this._pushEvent('peer_update', {});
    this._pushEvent('log', { message: `HELLO de ${msg.sender_peer_id}`, level: 'success' });

    if (msg.peers && Array.isArray(msg.peers)) {
      console.log(`[${this.peerId}] Peers conhecidos por ${msg.sender_peer_id}: ${JSON.stringify(msg.peers)}`);
    }

    // Só responde com HELLO se ainda não conhecíamos esse peer
    if (!alreadyKnown) {
      const knownPeers = [...this.connections.keys()];
      this._send(ws, Protocol.hello(this.peerId, knownPeers));
    }
  }

  _onSearch(ws, msg) {
    // 1. Já processamos esse query_id? Descarta
    if (this.seenQueries.has(msg.query_id)) {
      console.log(`[${this.peerId}] Query ${msg.query_id} já processada, descartando.`);
      return;
    }
    this.seenQueries.add(msg.query_id);

    // Guardar a rota de retorno
    this.queryRoutes.set(msg.query_id, msg.sender_peer_id);

    // Registrar no histórico de buscas
    this.searchHistory.push({
      query_id: msg.query_id,
      sticker_id: msg.sticker_id,
      origin_peer_id: msg.origin_peer_id,
      timestamp: new Date().toISOString()
    });

    // 2. Tenho a figurinha?
    if (this.inventory.has(msg.sticker_id)) {
      console.log(`[${this.peerId}] Encontrei ${msg.sticker_id}! Respondendo ao buscador.`);
      this._pushEvent('log', {
        message: `Encontrei ${msg.sticker_id} no meu inventário! Respondendo a ${msg.origin_peer_id}`,
        level: 'success'
      });

      const hit = Protocol.searchHit({
        originPeerId: this.peerId,
        senderPeerId: this.peerId,
        receiverPeerId: msg.origin_peer_id,
        queryId: msg.query_id,
        stickerId: msg.sticker_id
      });
      this._send(ws, hit);
      return;
    }

    // 3. Não tenho — NÃO envia SEARCH_MISS (é opcional no protocolo
    //    e causa loops com implementações de outros grupos)

    // 4. Reencaminhar com TTL-1
    if (msg.ttl > 1) {
      for (const [peerId, peerWs] of this.connections) {
        if (peerWs !== ws) {
          const forwardMsg = Protocol.search({
            originPeerId: msg.origin_peer_id,
            originPeerIp: msg.origin_peer_ip,
            senderPeerId: this.peerId,
            receiverPeerId: peerId,
            queryId: msg.query_id,
            stickerId: msg.sticker_id,
            ttl: msg.ttl - 1
          });
          this._send(peerWs, forwardMsg);
        }
      }
    }
  }

  _onSearchHit(ws, msg) {
    const queryId = msg.query_id;

    // Se EU originei esta busca, sou o destino final
    if (this.myQueries.has(queryId)) {
      console.log(`[${this.peerId}] SEARCH_HIT: ${msg.sticker_id} encontrada em ${msg.origin_peer_id}`);
      this._pushEvent('search_hit', {
        sticker_id: msg.sticker_id,
        origin_peer_id: msg.origin_peer_id,
        query_id: queryId
      });
      if (this.onSearchResult) this.onSearchResult(msg);
      return;
    }

    // Sou intermediário — rotear de volta
    const routeToPeer = this.queryRoutes.get(queryId);
    if (routeToPeer) {
      const routeWs = this.connections.get(routeToPeer);
      if (routeWs) {
        console.log(`[${this.peerId}] Roteando SEARCH_HIT para ${routeToPeer}`);
        const forwardHit = Protocol.searchHit({
          originPeerId: msg.origin_peer_id,
          senderPeerId: this.peerId,
          receiverPeerId: msg.receiver_peer_id,
          queryId: queryId,
          stickerId: msg.sticker_id
        });
        this._send(routeWs, forwardHit);
      } else {
        console.log(`[${this.peerId}] Rota para ${routeToPeer} não encontrada, descartando SEARCH_HIT.`);
      }
      this.queryRoutes.delete(queryId);
    } else {
      console.log(`[${this.peerId}] Sem rota para query ${queryId}, descartando SEARCH_HIT.`);
    }
  }

  _onSearchMiss(msg) {
    console.log(`[${this.peerId}] SEARCH_MISS: ${msg.sticker_id} não encontrada em ${msg.origin_peer_id}`);
  }

  /**
   * Quando recebemos uma TRADE_OFFER, salvamos como pendente
   * para o usuário aceitar ou recusar pela interface.
   */
  _onTradeOffer(ws, msg) {
    const offerId = msg.message_id;
    const offerSticker = msg.offer_sticker_id;
    const wantSticker = msg.want_sticker_id;

    console.log(`[${this.peerId}] Oferta de troca de ${msg.origin_peer_id}: oferece ${offerSticker}, quer ${wantSticker}`);

    this.incomingOffers.set(offerId, {
      from: msg.origin_peer_id,
      sender_peer_id: msg.sender_peer_id,
      offer_sticker_id: offerSticker,
      want_sticker_id: wantSticker,
      ws: ws,
      timestamp: new Date().toISOString()
    });

    this._pushEvent('trade_offer', {
      id: offerId,
      from: msg.origin_peer_id,
      offer_sticker_id: offerSticker,
      want_sticker_id: wantSticker
    });

    this._pushEvent('log', {
      message: `📥 Oferta de ${msg.origin_peer_id}: oferece ${offerSticker}, quer ${wantSticker}`,
      level: 'warning'
    });
  }

  /**
   * Aceitar uma oferta pendente (chamado pela API/CLI)
   */
  acceptIncomingOffer(offerId) {
    const offer = this.incomingOffers.get(offerId);
    if (!offer) return { error: 'Oferta não encontrada' };

    if (!this.inventory.has(offer.want_sticker_id)) {
      return { error: `Sem estoque de ${offer.want_sticker_id}` };
    }

    const ws = offer.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.incomingOffers.delete(offerId);
      return { error: 'Conexão com o peer perdida' };
    }

    // Enviar TRADE_ACCEPT
    this._send(ws, Protocol.tradeAccept({
      originPeerId: this.peerId,
      senderPeerId: this.peerId,
      receiverPeerId: offer.from,
      offerStickerId: offer.want_sticker_id,
      wantStickerId: offer.offer_sticker_id
    }));

    // Atualizar inventário
    this.inventory.remove(offer.want_sticker_id);
    this.inventory.add(offer.offer_sticker_id);

    // Enviar TRANSFER_CONFIRM
    this._send(ws, Protocol.transferConfirm({
      originPeerId: this.peerId,
      senderPeerId: this.peerId,
      receiverPeerId: offer.from,
      offerStickerId: offer.want_sticker_id,
      wantStickerId: offer.offer_sticker_id
    }));

    // Registrar no histórico
    this.tradeHistory.push({
      with: offer.from,
      gave: offer.want_sticker_id,
      received: offer.offer_sticker_id,
      timestamp: new Date().toISOString()
    });

    console.log(`[${this.peerId}] Troca aceita! -${offer.want_sticker_id} +${offer.offer_sticker_id}`);
    this.incomingOffers.delete(offerId);

    this._pushEvent('inventory_update', {});
    this._pushEvent('log', {
      message: `✅ Troca aceita com ${offer.from}: dei ${offer.want_sticker_id}, recebi ${offer.offer_sticker_id}`,
      level: 'success'
    });

    return { ok: true, gave: offer.want_sticker_id, received: offer.offer_sticker_id };
  }

  /**
   * Rejeitar uma oferta pendente (chamado pela API/CLI)
   */
  rejectIncomingOffer(offerId) {
    const offer = this.incomingOffers.get(offerId);
    if (!offer) return { error: 'Oferta não encontrada' };

    const ws = offer.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      this._send(ws, Protocol.tradeReject({
        originPeerId: this.peerId,
        senderPeerId: this.peerId,
        receiverPeerId: offer.from,
        offerStickerId: offer.offer_sticker_id,
        wantStickerId: offer.want_sticker_id,
        reason: 'Oferta recusada pelo usuário'
      }));
    }

    console.log(`[${this.peerId}] Troca rejeitada de ${offer.from}`);
    this.incomingOffers.delete(offerId);

    this._pushEvent('log', {
      message: `❌ Troca rejeitada de ${offer.from}`,
      level: 'error'
    });

    return { ok: true };
  }

  _onTradeAccept(ws, msg) {
    let tradeKey = null;
    for (const [key, trade] of this.pendingTrades) {
      // Diferentes implementações podem enviar os campos em ordens diferentes:
      // Ordem invertida: o aceitante troca a perspectiva (offer↔want)
      const swapped = (trade.offer_sticker_id === msg.want_sticker_id &&
                       trade.want_sticker_id === msg.offer_sticker_id);
      // Mesma ordem: o aceitante ecoa os mesmos campos do TRADE_OFFER original
      const sameOrder = (trade.offer_sticker_id === msg.offer_sticker_id &&
                         trade.want_sticker_id === msg.want_sticker_id);
      // Match por peer de destino (fallback adicional)
      const samePeer = (trade.target_peer === msg.origin_peer_id ||
                        trade.target_peer === msg.sender_peer_id);

      if ((swapped || sameOrder) && samePeer) {
        tradeKey = key;
        break;
      }
    }

    // Fallback: se não achou com match de peer, tenta só por stickers
    if (!tradeKey) {
      for (const [key, trade] of this.pendingTrades) {
        const swapped = (trade.offer_sticker_id === msg.want_sticker_id &&
                         trade.want_sticker_id === msg.offer_sticker_id);
        const sameOrder = (trade.offer_sticker_id === msg.offer_sticker_id &&
                           trade.want_sticker_id === msg.want_sticker_id);
        if (swapped || sameOrder) {
          tradeKey = key;
          break;
        }
      }
    }

    if (!tradeKey) {
      console.log(`[${this.peerId}] TRADE_ACCEPT recebido mas sem trade pendente correspondente.`);
      console.log(`[${this.peerId}] Campos recebidos: offer=${msg.offer_sticker_id}, want=${msg.want_sticker_id}, de=${msg.origin_peer_id}`);
      return;
    }

    const trade = this.pendingTrades.get(tradeKey);

    // Atualizar inventário
    this.inventory.remove(trade.offer_sticker_id);
    this.inventory.add(trade.want_sticker_id);

    // Registrar no histórico
    this.tradeHistory.push({
      with: msg.origin_peer_id,
      gave: trade.offer_sticker_id,
      received: trade.want_sticker_id,
      timestamp: new Date().toISOString()
    });

    console.log(`[${this.peerId}] Troca confirmada! -${trade.offer_sticker_id} +${trade.want_sticker_id}`);
    this.pendingTrades.delete(tradeKey);

    this._pushEvent('trade_accepted', {
      peer: msg.origin_peer_id,
      gave: trade.offer_sticker_id,
      received: trade.want_sticker_id
    });
    this._pushEvent('inventory_update', {});
    this._pushEvent('log', {
      message: `✅ ${msg.origin_peer_id} aceitou a troca! -${trade.offer_sticker_id} +${trade.want_sticker_id}`,
      level: 'success'
    });
  }

  _onTradeReject(msg) {
    console.log(`[${this.peerId}] Troca rejeitada por ${msg.origin_peer_id}: ${msg.reason || 'sem motivo'}`);

    for (const [key, trade] of this.pendingTrades) {
      const matchWant = (trade.want_sticker_id === msg.want_sticker_id ||
                         trade.want_sticker_id === msg.offer_sticker_id);
      if (matchWant) {
        this.pendingTrades.delete(key);
        break;
      }
    }

    this._pushEvent('trade_rejected', {
      peer: msg.origin_peer_id,
      reason: msg.reason
    });
    this._pushEvent('log', {
      message: `❌ Troca rejeitada por ${msg.origin_peer_id}: ${msg.reason || 'sem motivo'}`,
      level: 'error'
    });
  }

  _onTransferConfirm(msg) {
    console.log(`[${this.peerId}] Parceiro ${msg.origin_peer_id} confirmou transferência.`);
    this._pushEvent('transfer_confirm', { peer: msg.origin_peer_id });
    this._pushEvent('log', {
      message: `📦 ${msg.origin_peer_id} confirmou a transferência`,
      level: 'success'
    });
  }

  // ── Ações iniciadas pelo usuário ───────────────────────────

  search(stickerId) {
    const queryId = uuidv4();

    // Marcar como query MINHA
    this.myQueries.add(queryId);
    this.seenQueries.add(queryId);

    console.log(`[${this.peerId}] Buscando ${stickerId} (query: ${queryId})`);
    this._pushEvent('log', {
      message: `🔍 Buscando ${stickerId} na rede (query: ${queryId.substring(0, 8)}...)`,
      level: 'accent'
    });

    // Enviar SEARCH para todos os vizinhos
    for (const [peerId, ws] of this.connections) {
      const msg = Protocol.search({
        originPeerId: this.peerId,
        originPeerIp: this.localIp,
        senderPeerId: this.peerId,
        receiverPeerId: peerId,
        queryId,
        stickerId,
        ttl: 7
      });
      this._send(ws, msg);
    }

    return queryId;
  }

  offerTrade(targetPeerId, offerSticker, wantSticker) {
    const ws = this.connections.get(targetPeerId);
    if (!ws) return { error: 'Peer não conectado' };
    if (!this.inventory.has(offerSticker)) return { error: 'Você não tem essa figurinha' };

    const tradeId = uuidv4();
    this.pendingTrades.set(tradeId, {
      offer_sticker_id: offerSticker,
      want_sticker_id: wantSticker,
      target_peer: targetPeerId
    });

    this._send(ws, Protocol.tradeOffer({
      originPeerId: this.peerId,
      senderPeerId: this.peerId,
      receiverPeerId: targetPeerId,
      offerStickerId: offerSticker,
      wantStickerId: wantSticker
    }));

    console.log(`[${this.peerId}] Oferta enviada para ${targetPeerId}: ofereço ${offerSticker}, quero ${wantSticker}`);
    this._pushEvent('log', {
      message: `📤 Proposta enviada para ${targetPeerId}: ofereço ${offerSticker}, quero ${wantSticker}`,
      level: 'accent'
    });

    return { ok: true, trade_id: tradeId };
  }

  showInventory() {
    console.log(`\n=== Inventário de ${this.peerId} ===`);
    for (const [id, qty] of Object.entries(this.inventory.getAll())) {
      console.log(`  ${id}: ${qty} cópias`);
    }
    console.log('');
  }

  showHistory() {
    console.log(`\n=== Histórico de Trocas de ${this.peerId} ===`);
    if (this.tradeHistory.length === 0) {
      console.log('  Nenhuma troca realizada.');
    } else {
      for (const t of this.tradeHistory) {
        console.log(`  [${t.timestamp}] Com ${t.with}: dei ${t.gave}, recebi ${t.received}`);
      }
    }
    console.log('');
  }

  // ── Utilitários de envio ───────────────────────────────────

  _send(ws, msg) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  _broadcast(msg, exceptWs) {
    for (const [, ws] of this.connections) {
      if (ws !== exceptWs) this._send(ws, msg);
    }
  }

  _broadcastAll(msg) {
    this._broadcast(msg, null);
  }
}

module.exports = P2PNode;